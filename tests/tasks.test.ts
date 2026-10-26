import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRuntime } from '../src/host/runtime.js';
import { verification, type CommandEvidence } from '../src/core/execution/result.js';
import type { Model, ModelReply } from '../src/core/model/types.js';
import { runtimeFixture, echoModel } from './helpers/runtime.js';

function replies(values: ModelReply[]): Model {
  let step = 0;
  return {
    async complete() {
      const reply = values[step++];
      if (!reply) throw new Error('Unexpected model call');
      return reply;
    },
  };
}

const command = (ok: boolean): CommandEvidence => ({
  kind: 'command',
  command: 'node',
  args: ['check.js'],
  cwd: '.',
  purpose: 'verification',
  ok,
  exitCode: ok ? 0 : 1,
  timedOut: false,
  cancelled: false,
  logPath: 'check.log',
});

test('structured task results retain the legacy interface and survive session changes and restarts', async () => {
  const f = await runtimeFixture(echoModel);
  let reopened: AgentRuntime | undefined;
  try {
    await f.runtime.initialize();
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'hello' });
    assert.equal(result.status, 'completed');
    assert.equal(result.summary, '答复：hello');
    assert.equal(result.verification.status, 'not_run');
    assert.equal(result.metrics.modelCalls, 2);
    assert.equal(result.metrics.totalTokens, 12);
    assert.deepEqual(result.changes, []);
    await f.runtime.dispatch({ type: 'sessions.switch', id: 'other' });
    assert.equal(await f.runtime.dispatch({ type: 'tasks.current' }), undefined);
    await f.runtime.dispatch({ type: 'sessions.switch', id: 'default' });
    assert.equal(f.runtime.snapshot().task?.runId, result.runId);
    assert.equal(await f.runtime.dispatch({ type: 'run', input: 'legacy' }), '答复：legacy');
    assert.equal(f.runtime.snapshot().task?.result?.metrics.modelCalls, 2);
    await f.runtime.close();
    reopened = new AgentRuntime({
      root: f.directory,
      configDirectory: join(f.directory, 'config'),
      summarize: false,
      mcpCommand: undefined,
      mcpArgs: [],
      dependencies: {
        createModel: () => echoModel,
        resolveCapability: async () => ({
          contextWindow: 32768,
          outputReserve: 4096,
          source: 'override',
        }),
      },
    });
    const restored = await reopened.initialize();
    assert.equal(restored.task?.result?.summary, '答复：legacy');
    await reopened.dispatch({ type: 'sessions.reset' });
    assert.equal(reopened.snapshot().task, undefined);
    await assert.rejects(access(join(f.directory, '.mini-agent/tasks/default.json')));
  } finally {
    await reopened?.close();
    await f.close();
  }
});

test('truncated model tool calls never execute and the partial reply is marked incomplete', async () => {
  const f = await runtimeFixture(
    replies([
      {
        content: 'partial',
        finishReason: 'length',
        rawFinishReason: 'length',
        toolCalls: [
          {
            id: 'truncated',
            name: 'write_file',
            arguments: '{"path":"never.txt","content":"bad"}',
          },
        ],
      },
    ]),
  );
  try {
    await f.runtime.initialize();
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'go' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'output_truncated');
    assert.equal(result.finishReason, 'length');
    assert.equal(result.summary, 'partial');
    assert.deepEqual(result.changes, []);
    await assert.rejects(access(join(f.directory, 'never.txt')));
    const last = f.runtime.snapshot().history.at(-1);
    assert.equal(last?.role, 'assistant');
    if (last?.role === 'assistant') assert.equal(last.tool_calls, undefined);
    const stored = JSON.parse(
      await readFile(join(f.directory, '.mini-agent/tasks/default.json'), 'utf8'),
    );
    assert.equal(stored.error.code, 'output_truncated');
  } finally {
    await f.close();
  }
});

test('empty replies, refusals and paused generation produce explicit terminal states', async () => {
  for (const [reason, status, code] of [
    ['stop', 'failed', 'empty_response'],
    ['blocked', 'blocked', 'model_blocked'],
    ['pause', 'blocked', 'model_paused'],
    ['error', 'failed', 'invalid_response'],
  ] as const) {
    const f = await runtimeFixture(
      replies([{ content: null, toolCalls: [], finishReason: reason }]),
    );
    try {
      await f.runtime.initialize();
      const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'go' });
      assert.equal(result.status, status);
      assert.equal(result.error?.code, code);
      assert.equal(f.runtime.snapshot().running, false);
      assert.equal(f.runtime.snapshot().history.at(-1)?.role, 'user');
    } finally {
      await f.close();
    }
  }
});

test('a broken model stream retains its partial answer without reporting success', async () => {
  const f = await runtimeFixture({
    async complete(_messages, _tools, options) {
      options?.onEvent?.({ type: 'text', text: 'partial answer' });
      throw new Error('Network disconnected');
    },
  });
  try {
    await f.runtime.initialize();
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'go' });
    assert.equal(result.status, 'failed');
    assert.equal(result.summary, 'partial answer');
    assert.equal(result.finishReason, 'error');
    const message = f.runtime.snapshot().history.at(-1);
    assert.equal(message?.content, 'partial answer');
    if (message?.role === 'assistant') assert.equal(message.finishReason, 'error');
  } finally {
    await f.close();
  }
});

test('approval events change task state and cancellation repairs tool pairs', async () => {
  const f = await runtimeFixture(
    replies([
      {
        content: null,
        toolCalls: [
          { id: 'approval', name: 'write_file', arguments: '{"path":"never.txt","content":"bad"}' },
        ],
      },
    ]),
  );
  try {
    await f.runtime.initialize();
    let ready!: () => void;
    const requested = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.runtime.subscribe((event) => {
      if (event.type === 'approval_requested') ready();
    });
    const pending = f.runtime.dispatch({ type: 'tasks.run', input: 'write' });
    await requested;
    assert.equal(f.runtime.snapshot().task?.status, 'waiting_approval');
    await f.runtime.dispatch({ type: 'cancel' });
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(result.error?.code, 'cancelled');
    assert.equal(f.runtime.snapshot().pendingApprovals.length, 0);
    assert.equal(f.runtime.snapshot().history.at(-1)?.role, 'tool');
    await assert.rejects(access(join(f.directory, 'never.txt')));
  } finally {
    await f.close();
  }
});

test('only observed verification commands determine check status, and later writes invalidate old checks', () => {
  assert.equal(verification([]).status, 'not_run');
  assert.equal(verification([{ ...command(true), purpose: 'task' }]).status, 'not_run');
  assert.equal(verification([command(false)]).status, 'failed');
  assert.equal(verification([command(false), command(true)]).status, 'passed');
  assert.equal(
    verification([command(true), { kind: 'file_change', path: 'new.ts' }]).status,
    'not_run',
  );
  assert.equal(verification([{ ...command(true), timedOut: true }]).status, 'failed');
});

test('actual writes and command checks remain evidence separate from delivery completeness', async () => {
  for (const exitCode of [0, 1]) {
    const f = await runtimeFixture(
      replies([
        {
          content: null,
          toolCalls: [
            {
              id: 'write',
              name: 'write_file',
              arguments: '{"path":"new.ts","content":"export const value = 1;"}',
            },
          ],
        },
        {
          content: null,
          toolCalls: [
            {
              id: 'verify',
              name: 'run_command',
              arguments: JSON.stringify({
                command: 'node',
                args: ['-e', `process.exit(${exitCode})`],
                purpose: 'verification',
              }),
            },
          ],
        },
        { content: 'finished', toolCalls: [], finishReason: 'stop' },
      ]),
    );
    try {
      await f.runtime.initialize();
      f.runtime.subscribe((event) => {
        if (event.type === 'approval_requested')
          void f.runtime.dispatch({
            type: 'approvals.respond',
            id: event.approval.request.id,
            accepted: true,
          });
      });
      const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'write and verify' });
      assert.equal(result.status, 'completed');
      assert.equal(result.completeness?.status, 'not_applicable');
      assert.deepEqual(result.changes, ['new.ts']);
      assert.equal(result.verification.status, exitCode === 0 ? 'passed' : 'failed');
      assert.equal(result.verification.checks[0]?.exitCode, exitCode);
      assert.equal(result.metrics.modelCalls, 4);
      assert.equal(result.metrics.toolCalls, 3);
      assert.equal(result.evidence.length, 2);
    } finally {
      await f.close();
    }
  }
});

test('denied writes mark tasks blocked and create no file-change evidence', async () => {
  const f = await runtimeFixture(
    replies([
      {
        content: null,
        toolCalls: [
          { id: 'denied', name: 'write_file', arguments: '{"path":"never.txt","content":"bad"}' },
        ],
      },
      { content: 'could not write', toolCalls: [] },
    ]),
  );
  try {
    await f.runtime.initialize();
    f.runtime.subscribe((event) => {
      if (event.type === 'approval_requested')
        void f.runtime.dispatch({
          type: 'approvals.respond',
          id: event.approval.request.id,
          accepted: false,
        });
    });
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'write' });
    assert.equal(result.status, 'blocked');
    assert.equal(result.error?.code, 'approval_denied');
    assert.deepEqual(result.changes, []);
  } finally {
    await f.close();
  }
});

test('failed authoritative execution persistence cannot report completion', async () => {
  const f = await runtimeFixture(echoModel);
  try {
    await f.runtime.initialize();
    await mkdir(join(f.directory, '.mini-agent/executions/default.json'), { recursive: true });
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'go' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'persistence_error');
    assert.equal(f.runtime.snapshot().task?.status, 'failed');
  } finally {
    await f.close();
  }
});

test('legacy result cache failure preserves the committed execution and emits a notice', async () => {
  const f = await runtimeFixture(echoModel);
  try {
    await f.runtime.initialize();
    const notices: string[] = [];
    f.runtime.subscribe((event) => {
      if (event.type === 'notice') notices.push(event.text);
    });
    await mkdir(join(f.directory, '.mini-agent/tasks/default.json'));
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'go' });
    assert.equal(result.status, 'completed');
    const execution = await f.runtime.dispatch({ type: 'execution.get' });
    assert.equal(execution.runs.at(-1)?.status, 'completed');
    assert.ok(notices.some((notice) => notice.includes('兼容缓存更新失败')));
  } finally {
    await f.close();
  }
});

test('legacy journal recovery never inherits an older legacy result', async () => {
  const f = await runtimeFixture(echoModel);
  try {
    await f.runtime.initialize();
    const first = await f.runtime.dispatch({ type: 'tasks.run', input: 'first' });
    await f.runtime.dispatch({ type: 'sessions.switch', id: 'other' });
    // Reproduce a V1.1 session without the authoritative V1.2 manifest.
    await rm(join(f.directory, '.mini-agent/executions/default.json'));
    await writeFile(
      join(f.directory, '.mini-agent/journals/default.json'),
      JSON.stringify({
        runId: 'a-newer-run',
        status: 'running',
        // Even a same-millisecond timestamp must not restore an unrelated success.
        updatedAt: first.startedAt,
        tools: [],
      }),
    );
    await f.runtime.dispatch({ type: 'sessions.switch', id: 'default' });
    assert.equal(await f.runtime.dispatch({ type: 'tasks.current' }), undefined);
    assert.equal(f.runtime.snapshot().interrupted, true);
  } finally {
    await f.close();
  }
});

test('a broken journal still allows history and the failed task result to be saved', async () => {
  let directory = '';
  const f = await runtimeFixture({
    async complete() {
      const journal = join(directory, '.mini-agent/journals/default.json');
      await rm(journal);
      await mkdir(journal);
      return { content: 'answer before journal failure', toolCalls: [], finishReason: 'stop' };
    },
  });
  directory = f.directory;
  try {
    await f.runtime.initialize();
    const result = await f.runtime.dispatch({ type: 'tasks.run', input: 'go' });
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'persistence_error');
    const saved = JSON.parse(
      await readFile(join(directory, '.mini-agent/tasks/default.json'), 'utf8'),
    );
    assert.equal(saved.status, 'failed');
    assert.equal(saved.error.code, 'persistence_error');
    assert.match(
      await readFile(join(directory, '.mini-agent/sessions/default.json'), 'utf8'),
      /answer before journal failure/,
    );
  } finally {
    await f.close();
  }
});

test('a terminal task event can start the next task without receiving the old error', async () => {
  const f = await runtimeFixture(
    replies([
      { content: 'partial', toolCalls: [], finishReason: 'length' },
      { content: 'recovered', toolCalls: [], finishReason: 'stop' },
    ]),
  );
  try {
    await f.runtime.initialize();
    const events: string[] = [];
    let next: ReturnType<typeof f.runtime.dispatch> | undefined;
    f.runtime.subscribe((event) => {
      if (event.type === 'run_error') events.push('error');
      if (event.type === 'task') {
        events.push(event.task.status);
        if (event.task.status === 'failed')
          next = f.runtime.dispatch({ type: 'tasks.run', input: 'retry' });
      }
    });
    const first = await f.runtime.dispatch({ type: 'tasks.run', input: 'first' });
    assert.equal(first.status, 'failed');
    await next;
    assert.deepEqual(
      events.filter((value, index) => value !== events[index - 1]),
      ['running', 'error', 'failed', 'running', 'completed'],
    );
    assert.equal(f.runtime.snapshot().task?.result?.summary, 'recovered');
  } finally {
    await f.close();
  }
});
