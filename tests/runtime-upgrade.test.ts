import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerifiedFileCache } from '../src/infra/workspace/file-cache.js';
import { ExecutionJournal } from '../src/infra/storage/execution-journal.js';
import { ToolArtifacts } from '../src/infra/storage/tool-artifacts.js';

test('validated file cache sees external edits despite same length', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-cache-'));
  try {
    const path = join(dir, 'x.ts');
    await writeFile(path, 'hello');
    const cache = new VerifiedFileCache();
    assert.equal((await cache.read(path)).source, 'disk');
    assert.equal((await cache.read(path)).source, 'validated-cache');
    await writeFile(path, 'world');
    const current = await cache.read(path);
    assert.equal(current.source, 'disk');
    assert.equal(current.text, 'world');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('execution journal flags unfinished calls without replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-journal-'));
  try {
    const file = join(dir, 'run.json');
    const journal = new ExecutionJournal(file);
    await journal.begin('run-1');
    await journal.startTool('call-1', 'write_file');
    const afterCrash = await new ExecutionJournal(file).load();
    assert.equal(afterCrash?.status, 'running');
    assert.equal(afterCrash?.tools[0]?.state, 'pending');
    await journal.finish('interrupted');
    assert.equal((await journal.load())?.tools[0]?.state, 'uncertain');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('archived tool result can be paginated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-artifact-'));
  try {
    const store = new ToolArtifacts(dir);
    const saved = await store.save('abcdefghijklmnopqrstuvwxyz');
    assert.match(await store.read(saved.id, 5, 6), /fghijk/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
