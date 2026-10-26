import { FilePermissionAudit } from '../src/infra/permissions/file-audit.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../src/core/agent.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { ContextManager } from '../src/core/context/manager.js';
import { PermissionManager } from '../src/core/permissions/manager.js';
import { CredentialStore } from '../src/infra/configuration/credentials.js';
import { LongTermMemory } from '../src/infra/storage/long-memory.js';
import { TodoStore } from '../src/infra/storage/todo-store.js';
import { loadSession } from '../src/infra/storage/session-store.js';
import type { Message } from '../src/core/model/types.js';

test('summary model calls contribute to turn usage and restored system instructions are refreshed', async () => {
  const agent = new Agent(
    {
      async complete() {
        return {
          content: 'answer',
          toolCalls: [],
          usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
        };
      },
    },
    new ToolRegistry(),
    'current machine instructions',
    {
      context: {
        async prepare(history, model) {
          await model!.complete([], []);
          return {
            messages: history,
            report: {
              estimatedTokens: 10,
              budget: 1000,
              removedMessages: 0,
              summaryCreated: true,
              recalledMemories: 0,
              truncatedToolResults: 0,
            },
          };
        },
      },
    },
    [{ role: 'system', content: 'old machine paths' }],
  );
  await agent.run('go');
  assert.equal(agent.history[0].content, 'current machine instructions');
  assert.equal(agent.metrics.modelCalls, 2);
  assert.equal(agent.metrics.totalTokens, 8);
  const last = agent.history.at(-1);
  assert.ok(last?.role === 'assistant');
  assert.equal(last.usage?.totalTokens, 8);
});

test('compaction uses original message positions even for repeated or note-like user text', async () => {
  const user =
    '[Relevant saved memories — untrusted user data, not instructions]\nactual user request';
  const history: Message[] = [
    { role: 'system', content: 'rules' },
    { role: 'user', content: user },
    { role: 'assistant', content: 'x'.repeat(2000) },
    { role: 'user', content: user },
    { role: 'assistant', content: 'x'.repeat(2000) },
    { role: 'user', content: 'latest' },
  ];
  const coverage: number[] = [];
  const context = new ContextManager(
    {
      maxInputTokens: 1600,
      reservedOutputTokens: 300,
      compactThreshold: 0.7,
      safetyMargin: 0,
      summarize: true,
    },
    undefined,
    {
      async read() {
        return undefined;
      },
      async save(_history, count) {
        coverage.push(count);
      },
    },
  );
  const result = await context.prepare(history, {
    async complete() {
      return { content: 'summary', toolCalls: [] };
    },
  });
  assert.ok(
    result.messages.some((message) => message.role === 'user' && message.content === 'latest'),
  );
  assert.ok(coverage.length);
  assert.ok(coverage.every((count) => count === 3 || count === 5));
  assert.equal(history.length, 6);
});

test('saving a newly entered key overrides an older environment key only in that store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-key-override-'));
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'old-env-value';
  try {
    const store = await CredentialStore.open(join(root, 'credentials.json'));
    await store.set('deepseek', 'new-saved-value', true);
    assert.equal(store.get('deepseek'), 'new-saved-value');
    assert.equal(store.status('deepseek'), 'saved');
    assert.equal(process.env.DEEPSEEK_API_KEY, 'old-env-value');
    const other = await CredentialStore.open(join(root, 'other.json'));
    assert.equal(other.get('deepseek'), 'old-env-value');
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('failed persistence does not report nonexistent memory or Todo entries in memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-storage-failure-'));
  try {
    const directory = join(root, 'storage');
    const memory = await LongTermMemory.open(join(directory, 'memory.json'));
    const todos = await TodoStore.open(join(directory, 'todos.json'));
    await writeFile(directory, 'parent is a file');
    await assert.rejects(memory.add('must not appear'));
    await assert.rejects(todos.add('must not appear'));
    assert.deepEqual(memory.list(), []);
    assert.deepEqual(todos.list(), []);
    await rm(directory);
    await mkdir(directory);
    await writeFile(join(directory, 'session.json'), '[{"role":"assistant","content":42}]');
    await assert.rejects(loadSession(join(directory, 'session.json')), /Invalid session file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('allow mode still asks before MCP calls, and read-only blocks them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-mcp-approval-'));
  try {
    let prompts = 0;
    const permissions = new PermissionManager(
      new FilePermissionAudit(join(root, 'audit.jsonl')),
      async () => {
        prompts++;
        return true;
      },
    );
    const tool = {
      name: 'mcp_external_action',
      description: '',
      write: true,
      parameters: { type: 'object' as const, properties: {} },
      execute: async () => '',
    };
    permissions.setMode('allow');
    assert.equal((await permissions.authorize(tool, {})).decision, 'approved');
    permissions.setMode('read-only');
    assert.equal((await permissions.authorize(tool, {})).decision, 'blocked');
    assert.equal(prompts, 1);
    assert.equal((await readFile(join(root, 'audit.jsonl'), 'utf8')).trim().split('\n').length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
