import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentRuntime,
  ContextManager,
  PermissionManager,
  type Model,
  type RuntimeDependencies,
} from '../src/index.js';
import { FileTaskPersistence } from '../src/infra/storage/task-persistence.js';
import { FileDeliveryChecker } from '../src/infra/verification/files.js';
import { validateWorkflow } from '../src/core/workflow/definition.js';
import type { WorkflowDefinition } from '../src/protocol/index.js';

function checklistModel(files: string[] = []): Model {
  return {
    async complete(_messages, tools) {
      assert.equal(tools[0]?.name, 'submit_delivery_checklist');
      return {
        content: null,
        finishReason: 'tool_calls',
        toolCalls: [
          {
            id: 'contract',
            name: 'submit_delivery_checklist',
            arguments: JSON.stringify({
              mode: files.length ? 'files' : 'response',
              files,
              plan: ['Deliver the requested result'],
            }),
          },
        ],
      };
    },
  };
}

async function fixture(
  dependencies: RuntimeDependencies,
  files: string[] = [],
  confirmPlan = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'mini-modules-'));
  const runtime = new AgentRuntime({
    root,
    configDirectory: join(root, 'config'),
    sessionId: 'default',
    confirmPlan,
    summarize: false,
    mcpCommand: undefined,
    mcpArgs: [],
    dependencies: {
      createModel: () => checklistModel(files),
      resolveCapability: async () => ({
        contextWindow: 32768,
        outputReserve: 4096,
        source: 'override',
      }),
      ...dependencies,
    },
  });
  return {
    root,
    runtime,
    async close() {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function workflow(executor: string): WorkflowDefinition {
  return validateWorkflow({
    schemaVersion: 1,
    id: 'custom',
    version: 1,
    entry: 'respond',
    nodes: [
      {
        id: 'respond',
        type: 'model',
        config: { executor },
        outputs: { text: { to: 'state.answer' } },
      },
    ],
    edges: [{ from: 'respond', to: '$end' }],
  });
}

async function select(runtime: AgentRuntime, definition: WorkflowDefinition) {
  await runtime.dispatch({ type: 'workflows.register', definition });
  await runtime.dispatch({ type: 'workflows.select', id: definition.id });
}

test('module factories survive context changes and session switching; UI is unnecessary', async () => {
  const sessions: string[] = [];
  const opened: string[] = [];
  const events: string[] = [];
  let disposed = 0;
  let checked = 0;
  const f = await fixture({
    toolsets: { command: false, todos: false, mcp: false },
    observers: [
      () => {
        throw new Error('broken observer');
      },
      (event) => events.push(event.type),
    ],
    createMemory: () => ({
      list: () => [],
      search: () => [],
      add: async () => {
        throw new Error('disabled');
      },
      update: async () => {
        throw new Error('disabled');
      },
      remove: async () => false,
    }),
    createContext(input) {
      sessions.push(input.sessionId);
      return new ContextManager(input.options, input.memory, input.compactions);
    },
    createPermissions({ audit, present }) {
      const permissions = new PermissionManager(audit, present);
      permissions.setMode('read-only');
      return permissions;
    },
    createPersistence({ project }) {
      const disk = new FileTaskPersistence(project);
      return {
        open(id) {
          opened.push(id);
          return disk.open(id);
        },
        reset: (id) => disk.reset(id),
        loadResult: (id) => disk.loadResult(id),
        saveResult: (id, result) => disk.saveResult(id, result),
        saveHistory: (id, history) => disk.saveHistory(id, history),
      };
    },
    createDelivery({ workspace }) {
      const checker = new FileDeliveryChecker(workspace);
      return {
        normalizePaths: (files) => checker.normalizePaths(files),
        check(task, run, checklist) {
          checked++;
          return checker.check(task, run, checklist);
        },
      };
    },
    nodeExecutors: {
      local_answer: async (context) => {
        assert.equal('task' in context, false);
        assert.equal('run' in context, false);
        return { outputs: { text: 'A response supplied by the registered executor' } };
      },
    },
    modules: [
      {
        id: 'calculator',
        setup(context) {
          context.registerTool({
            name: 'double',
            description: 'Double a number',
            parameters: { type: 'object', properties: {} },
            execute: async () => 2,
          });
          return () => {
            disposed++;
          };
        },
      },
    ],
  });
  try {
    await f.runtime.initialize();
    await select(f.runtime, workflow('local_answer'));
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'explain' });
    assert.equal(result.status, 'completed');
    assert.equal(result.completeness?.status, 'not_applicable');
    assert.equal(f.runtime.snapshot().history.at(-1)?.content, result.summary);
    assert.equal(checked, 1);
    assert.ok(events.includes('execution'));
    assert.equal(f.runtime.snapshot().permissionMode, 'read-only');
    await f.runtime.dispatch({
      type: 'context.configure',
      settings: { summarize: false, maxInputTokens: 65536 },
    });
    await f.runtime.dispatch({ type: 'sessions.switch', id: 'second' });
    assert.deepEqual(sessions, ['default', 'default', 'second']);
    assert.deepEqual(opened, ['default', 'second']);
    assert.equal((await f.runtime.dispatch({ type: 'context.get' })).maxInputTokens, 65536);
    const tools = await f.runtime.dispatch({ type: 'tools.list' });
    assert.ok(tools.includes('double'));
    assert.ok(!tools.includes('run_command') && !tools.includes('todo_add'));
    await assert.rejects(
      select(f.runtime, { ...workflow('missing_executor'), id: 'bad' }),
      /Unknown node executor/,
    );
    await f.runtime.close();
    await f.runtime.close();
    assert.equal(disposed, 1);
  } finally {
    await f.close();
  }
});

test('custom node execution still passes through completeness and missing-file retry in the same Run', async () => {
  let attempts = 0;
  let root = '';
  const f = await fixture(
    {
      nodeExecutors: {
        deliver: async () => {
          if (++attempts === 2) await writeFile(join(root, 'README.md'), '# Result');
          return { outputs: { text: 'delivery attempted' } };
        },
      },
      createDelivery({ workspace }) {
        const checker = new FileDeliveryChecker(workspace);
        return {
          normalizePaths: (files) => checker.normalizePaths(files),
          async check(task, run, checklist) {
            const report = await checker.check(task, run, checklist);
            // A buggy plugin's aggregate status cannot override its missing-file evidence.
            report.status = 'passed';
            task.goal = 'mutated plugin copy';
            return report;
          },
        };
      },
    },
    ['README.md'],
  );
  root = f.root;
  try {
    await f.runtime.initialize();
    await select(f.runtime, workflow('deliver'));
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'Create README.md' });
    assert.equal(result.status, 'completed');
    const state = await f.runtime.dispatch({ type: 'execution.get' });
    assert.equal(state.runs.length, 1);
    assert.equal(state.nodes.length, 2);
    assert.equal(state.tasks[0].goal, 'Create README.md');
    assert.deepEqual(
      state.reports.map((report) => report.status),
      ['incomplete', 'passed'],
    );
  } finally {
    await f.close();
  }
});

test('a checker cannot omit file observations or mark a file checklist not applicable', async () => {
  const f = await fixture(
    {
      nodeExecutors: { respond: async () => ({ outputs: { text: 'done' } }) },
      createDelivery({ workspace }) {
        const checker = new FileDeliveryChecker(workspace);
        return {
          normalizePaths: (files) => checker.normalizePaths(files),
          async check(task, run, checklist) {
            return {
              ...(await checker.check(task, run, checklist)),
              status: 'not_applicable',
              items: [],
            };
          },
        };
      },
    },
    ['README.md'],
  );
  try {
    await f.runtime.initialize();
    await select(f.runtime, workflow('respond'));
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'Deliver a file' });
    assert.equal(result.status, 'failed');
    assert.match(result.error?.message ?? '', /every required file/);
  } finally {
    await f.close();
  }
});

test('plan approval waits persist and custom executors cannot skip them', async () => {
  let executed = 0;
  const f = await fixture(
    {
      nodeExecutors: {
        respond: async () => {
          executed++;
          return { outputs: { text: 'done' } };
        },
      },
    },
    [],
    true,
  );
  try {
    await f.runtime.initialize();
    await select(f.runtime, workflow('respond'));
    const waiting = await f.runtime.dispatch({ type: 'tasks.run', input: 'answer' });
    assert.equal(waiting.status, 'waiting');
    assert.equal(executed, 0);
    const state = await f.runtime.dispatch({ type: 'execution.get' });
    const request = state.waits.find((wait) => wait.status === 'pending')!;
    await f.runtime.dispatch({ type: 'waits.respond', id: request.id, response: true });
    const result = await f.runtime.dispatch({ type: 'runs.resume', id: waiting.runId });
    assert.equal(result.status, 'completed');
    assert.equal(executed, 1);
  } finally {
    await f.close();
  }
});

test('failed module installation disposes previously installed modules in reverse order', async () => {
  const closed: string[] = [];
  const f = await fixture({
    modules: [
      {
        id: 'first',
        setup: () => () => {
          closed.push('first');
        },
      },
      {
        id: 'second',
        setup: () => () => {
          closed.push('second');
        },
      },
      {
        id: 'broken',
        setup: () => {
          throw new Error('installation failed');
        },
      },
    ],
  });
  try {
    await assert.rejects(f.runtime.initialize(), /installation failed/);
    assert.deepEqual(closed, ['second', 'first']);
  } finally {
    await f.close();
  }
});

test('restoration failure closes installed modules even before initialize resolves', async () => {
  let disposed = 0;
  const f = await fixture({
    createPersistence: () => ({
      open: () => ({
        load: async () => {
          throw new Error('storage unavailable');
        },
        save: async (state) => state,
      }),
      reset: async () => {},
      loadResult: async () => undefined,
      saveResult: async () => {},
      saveHistory: async () => {},
    }),
    modules: [
      {
        id: 'connection',
        setup: () => () => {
          disposed++;
        },
      },
    ],
  });
  try {
    await assert.rejects(f.runtime.initialize(), /storage unavailable/);
    assert.equal(disposed, 1);
  } finally {
    await f.close();
  }
  assert.equal(disposed, 1);
});
