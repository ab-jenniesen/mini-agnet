import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/infra/workspace/files.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { Agent } from '../src/core/agent.js';
import type { Model } from '../src/core/model/types.js';
import type { AgentEvent } from '../src/core/events.js';
import { registerLocalTools } from '../src/tools/local.js';

test('workspace denies path traversal and symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-test-'));
  try {
    const ws = await Workspace.create(root);
    await assert.rejects(ws.writablePath('../escape'), /WRITE_SCOPE_DENIED/);
    await symlink(tmpdir(), join(root, 'link'));
    await assert.rejects(ws.safePath('link/secret'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('read tools, validation and write approval', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-test-'));
  try {
    await writeFile(join(root, 'a.txt'), 'hello');
    const r = new ToolRegistry();
    registerLocalTools(r, await Workspace.create(root));
    const readResult = JSON.parse(
      await r.invoke('read_file', { path: 'a.txt' }, async () => false),
    );
    assert.equal(readResult.content, 'hello');
    assert.match(readResult.sha256, /^[a-f0-9]{64}$/);
    assert.match(await r.invoke('read_file', { path: '../secret' }, async () => false), /ERROR/);
    assert.match(
      await r.invoke('write_file', { path: 'a.txt', content: 'new' }, async () => false),
      /denied/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('agent keeps tool calls and results in valid order', async () => {
  const r = new ToolRegistry();
  r.register({
    name: 'ping',
    description: 'ping',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'pong',
  });
  let i = 0;
  const model: Model = {
    complete: async () =>
      ++i === 1
        ? { content: null, toolCalls: [{ id: '1', name: 'ping', arguments: '{}' }] }
        : { content: 'finished', toolCalls: [] },
  };
  const agent = new Agent(model, r, 'system');
  assert.equal(await agent.run('go'), 'finished');
  assert.deepEqual(
    agent.history.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'assistant'],
  );
});

test('agent continues beyond fifteen model steps until a final reply arrives', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'ping',
    description: 'ping',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'pong',
  });
  let calls = 0;
  const agent = new Agent(
    {
      async complete() {
        calls++;
        return calls <= 20
          ? { content: null, toolCalls: [{ id: `call-${calls}`, name: 'ping', arguments: '{}' }] }
          : { content: 'done', toolCalls: [] };
      },
    },
    registry,
    'system',
  );
  assert.equal(await agent.run('continue'), 'done');
  assert.equal(calls, 21);
  assert.equal(agent.metrics.toolCalls, 20);
});

test('headless core retains a broken stream without a progress subscriber', async () => {
  const agent = new Agent(
    {
      async complete(_messages, _tools, options) {
        options?.onEvent?.({ type: 'text', text: 'partial answer' });
        throw new Error('stream disconnected');
      },
    },
    new ToolRegistry(),
    'system',
  );
  await assert.rejects(agent.run('go'), /stream disconnected/);
  const partial = agent.history.at(-1);
  assert.equal(partial?.content, 'partial answer');
  if (partial?.role === 'assistant') assert.equal(partial.finishReason, 'error');
});

test('actual tool effects remain observable if result archival fails', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'write',
    description: 'write',
    parameters: { type: 'object', properties: {} },
    execute: async () => 'long result',
    evidence: () => [{ kind: 'file_change', path: 'changed.txt' }],
  });
  const events: AgentEvent[] = [];
  const agent = new Agent(
    {
      async complete() {
        return { content: null, toolCalls: [{ id: '1', name: 'write', arguments: '{}' }] };
      },
    },
    registry,
    'system',
    {
      maxInlineToolChars: 1,
      artifacts: {
        save: async () => {
          throw new Error('disk full');
        },
      },
      onProgress: (event) => events.push(event),
    },
  );
  await assert.rejects(agent.run('go'), /disk full/);
  const completed = events.find((event) => event.type === 'tool_end');
  assert.equal(completed?.type, 'tool_end');
  if (completed?.type === 'tool_end') {
    assert.equal(completed.outcome, 'success');
    assert.deepEqual(completed.evidence, [{ kind: 'file_change', path: 'changed.txt' }]);
  }
  assert.equal(agent.history.at(-1)?.role, 'tool');
});
