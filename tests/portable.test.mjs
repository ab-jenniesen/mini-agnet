import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportBundle, inspectBundle, importBundle } from '../lib/portable.mjs';
test('portable export/import separates runtime state from local authorizations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-v2-test-'));
  const source = join(root, 'from'),
    dest = join(root, 'to');
  try {
    await mkdir(join(source, '.mini-agent', 'sessions'), { recursive: true });
    await mkdir(dest);
    await writeFile(
      join(source, '.mini-agent', 'sessions', 'default.json'),
      '[{"role":"user","content":"Hello"}]',
    );
    await writeFile(join(source, '.mini-agent', 'memories.json'), '[]');
    await writeFile(
      join(source, '.mini-agent', 'workspace-grants.json'),
      '["C:\\\\old\\\\folder"]',
    );
    await writeFile(
      join(source, '.mini-agent', 'mcp.json'),
      JSON.stringify({ servers: { risk: { command: 'sh', enabled: true } } }),
    );
    const out = join(root, 'portable.magent');
    const e = await exportBundle({ cwd: source, out });
    assert.ok(e.count >= 3);
    const m = await inspectBundle(out);
    assert.equal(m.format, 'mini-agent-portable');
    const preview = await importBundle({ file: out, cwd: dest });
    assert.ok(preview.plan.some((x) => x.action === 'skipped-write-grants'));
    await importBundle({ file: out, cwd: dest, apply: true });
    assert.equal(
      await readFile(join(dest, '.mini-agent', 'sessions', 'default.json'), 'utf8'),
      '[{"role":"user","content":"Hello"}]',
    );
    const mc = JSON.parse(await readFile(join(dest, '.mini-agent', 'mcp.json'), 'utf8'));
    assert.equal(mc.servers.risk.enabled, false);
    await assert.rejects(readFile(join(dest, '.mini-agent', 'workspace-grants.json')));
    const again = await importBundle({ file: out, cwd: dest });
    assert.ok(again.plan.some((x) => x.action === 'exists-skip'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
