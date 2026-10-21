import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '../src/core/context/manager.js';
import { ToolArtifacts } from '../src/infra/tool-artifacts.js';
import { resolveContextCapability } from '../src/core/context/capabilities.js';
import type { Message, Tool } from '../src/core/types.js';

test('model-window override beats a static default and budget includes tool definitions', async () => {
  const m = new ContextManager({ compactThreshold: 1, safetyMargin: 0 });
  m.setCapability({ contextWindow: 2000, outputReserve: 500, source: 'override' });
  const h: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'question' },
  ];
  const tool: Tool = {
    name: 'test',
    description: 'long description'.repeat(20),
    parameters: { type: 'object', properties: {} },
    execute: async () => '',
  };
  const first = await m.prepare(h, undefined, undefined, []);
  const second = await m.prepare(h, undefined, undefined, [tool]);
  assert.equal(first.report.budget, 1500);
  assert.ok(second.report.budget < first.report.budget);
  assert.equal(m.getCapability()?.contextWindow, 2000);
});
test('output archiving never truncates stored content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mini-v1-'));
  try {
    const store = new ToolArtifacts(dir);
    const raw = 'A'.repeat(10000) + 'TAIL';
    const saved = await store.save(raw);
    assert.equal((await store.read(saved.id, 10000, 10)).split('\n').at(-1), 'TAIL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('explicit capability override does not depend on network', async () => {
  const cap = await resolveContextCapability(
    { provider: 'openai', model: 'example' },
    { windowOverride: 128000, outputReserve: 8000 },
  );
  assert.deepEqual([cap.source, cap.contextWindow, cap.outputReserve], ['override', 128000, 8000]);
});
