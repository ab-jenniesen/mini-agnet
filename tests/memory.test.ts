import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LongTermMemory } from '../src/infra/long-memory.js';
import { ScopedMemory } from '../src/infra/scoped-memory.js';
import { registerMemoryTools } from '../src/tools/memory.js';
import { ToolRegistry } from '../src/core/registry.js';
import { Agent } from '../src/core/agent.js';
import type { Model } from '../src/core/types.js';

test('long-term memory survives reopen, supports search/update/delete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-memory-'));
  try {
    const file = join(root, 'facts.json');
    const one = await LongTermMemory.open(file);
    const saved = await one.add('喜欢 TypeScript 学习', ['学习']);
    const two = await LongTermMemory.open(file);
    assert.equal(two.search('TypeScript')[0].id, saved.id);
    assert.equal(two.search('学习').length, 1);
    await two.update(saved.id, '喜欢 Node.js');
    assert.equal((await LongTermMemory.open(file)).search('Node.js').length, 1);
    assert.equal(await two.remove(saved.id), true);
    assert.equal((await LongTermMemory.open(file)).list().length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('memory writes require explicit human approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-memory-'));
  try {
    const memory = await ScopedMemory.open(join(root, 'facts.json'), join(root, 'global.json'));
    const tools = new ToolRegistry();
    registerMemoryTools(tools, memory);
    assert.match(
      await tools.invoke('memory_save', { text: 'remember me' }, async () => false),
      /denied/,
    );
    assert.equal(memory.list().length, 0);
    await tools.invoke('memory_save', { text: 'remember me' }, async () => true);
    assert.equal(memory.list().length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compaction keeps latest user and tool call/result together', async () => {
  const tools = new ToolRegistry();
  tools.register({
    name: 'ping',
    description: 'ping',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'pong',
  });
  let counter = 0;
  const model: Model = {
    complete: async () =>
      ++counter % 2
        ? { content: null, toolCalls: [{ id: String(counter), name: 'ping', arguments: '{}' }] }
        : { content: 'done', toolCalls: [] },
  };
  const agent = new Agent(model, tools, 'system', { maxHistoryChars: 250 });
  await agent.run('older message '.repeat(50));
  await agent.run('new message');
  assert(agent.history.some((x) => x.role === 'user' && x.content === 'new message'));
  for (let i = 0; i < agent.history.length; i++) {
    const msg = agent.history[i];
    if (msg.role === 'assistant' && msg.tool_calls?.length)
      assert.equal(agent.history[i + 1].role, 'tool');
  }
});
