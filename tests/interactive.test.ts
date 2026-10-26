import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { diffPreview } from '../src/infra/workspace/diff.js';
import { TodoStore } from '../src/infra/storage/todo-store.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { Agent } from '../src/core/agent.js';
import type { Model } from '../src/core/model/types.js';

test('diff shows added and deleted lines', () => {
  const s = diffPreview('hello\nold', 'hello\nnew');
  assert.match(s, /- old/);
  assert.match(s, /\+ new/);
});
test('todos survive reopen and update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-todo-'));
  try {
    const path = join(dir, 'todos.json');
    const s = await TodoStore.open(path);
    const task = await s.add('inspect code');
    await s.set(task.id, 'completed');
    const other = await TodoStore.open(path);
    assert.equal(other.list()[0]?.status, 'completed');
    await other.clear();
    assert.equal((await TodoStore.open(path)).list().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('model events, token usage, tool status and metrics', async () => {
  const events: string[] = [];
  const r = new ToolRegistry();
  r.register({
    name: 'ping',
    description: 'ping',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'pong',
  });
  let count = 0;
  const model: Model = {
    complete: async (_messages, _tools, opts) => {
      count++;
      opts?.onEvent?.({ type: 'text', text: count === 1 ? 'thinking...' : 'done' });
      return count === 1
        ? {
            content: 'thinking...',
            toolCalls: [{ id: 'c1', name: 'ping', arguments: '{}' }],
            usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
          }
        : {
            content: 'done',
            toolCalls: [],
            usage: { promptTokens: 4, completionTokens: 1, totalTokens: 5 },
          };
    },
  };
  const agent = new Agent(model, r, 'system', { onProgress: (e) => events.push(e.type) });
  assert.equal(await agent.run('go'), 'done');
  assert.deepEqual(
    agent.history.map((x) => x.role),
    ['system', 'user', 'assistant', 'tool', 'assistant'],
  );
  assert.equal(agent.metrics.totalTokens, 10);
  assert.equal(agent.metrics.toolCalls, 1);
  assert.ok(
    events.includes('tool_start') && events.includes('tool_end') && events.includes('text'),
  );
});
