import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/infra/files.js';
import { runCommand } from '../src/tools/command.js';

test('commands preserve argument boundaries, UTF-8 output, logs and platform npm execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mini-command-'));
  try {
    const workspace = await Workspace.create(root);
    const result = JSON.parse(
      await runCommand(workspace, 'node', [
        '-e',
        'console.log(process.argv[1]);console.error("中文输出")',
        'a & b',
      ]),
    );
    assert.equal(result.ok, true);
    assert.match(result.preview, /a & b/);
    assert.match(result.preview, /中文输出/);
    assert.match(await readFile(result.logPath, 'utf8'), /中文输出/);
    const npm = JSON.parse(await runCommand(workspace, 'npm', ['--version']));
    assert.equal(npm.ok, true);
    assert.match(npm.preview, /\d+\.\d+\.\d+/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'cancellation terminates an active command and records it as cancelled',
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'mini-command-cancel-'));
    try {
      const workspace = await Workspace.create(root);
      const controller = new AbortController();
      const pending = runCommand(
        workspace,
        'node',
        ['-e', 'setInterval(()=>{},1000)'],
        '.',
        20000,
        controller.signal,
      );
      setTimeout(() => controller.abort(), 100);
      const result = JSON.parse(await pending);
      assert.equal(result.ok, false);
      assert.equal(result.cancelled, true);
      assert.equal(result.timedOut, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
