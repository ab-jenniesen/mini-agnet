import { FilePermissionAudit } from '../src/infra/permissions/file-audit.js';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionManager } from '../src/core/permissions/manager.js';
import type { Tool } from '../src/core/model/types.js';
const tool = (name: string): Tool => ({
  name,
  write: true,
  description: name,
  parameters: { type: 'object', properties: {} },
  execute: async () => '',
});
test('permission decisions and append-only audit; command always asks', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'agent-permissions-'));
  let prompts = 0;
  try {
    const p = new PermissionManager(
      new FilePermissionAudit(join(folder, 'audit.jsonl')),
      async () => {
        prompts++;
        return true;
      },
    );
    assert.equal(
      (await p.authorize(tool('write_file'), { path: 'a', content: 'x' })).decision,
      'approved',
    );
    p.setMode('read-only');
    assert.equal((await p.authorize(tool('write_file'), {})).decision, 'blocked');
    p.setMode('allow');
    assert.equal((await p.authorize(tool('write_file'), {})).decision, 'auto');
    assert.equal((await p.authorize(tool('run_command'), {})).decision, 'approved');
    assert.equal(prompts, 2);
    const records = (await readFile(join(folder, 'audit.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 4);
    assert.equal(records[0].proposedSha256?.length, 64);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
