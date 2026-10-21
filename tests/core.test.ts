import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/infra/files.js';
import { ToolRegistry } from '../src/core/registry.js';
import { Agent } from '../src/core/agent.js';
import type { Model } from '../src/core/types.js';
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
