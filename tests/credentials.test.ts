import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../src/infra/credentials.js';

test('credential persists across store reload but never into session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-keys-'));
  try {
    const path = join(dir, 'credentials.json');
    const store = await CredentialStore.open(path);
    const before = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      assert.equal(store.status('deepseek'), 'missing');
      await store.set('deepseek', 'test_fake_secret', true);
      assert.equal(store.status('deepseek'), 'saved');
      assert.equal(store.get('deepseek'), 'test_fake_secret');
      assert.equal((await CredentialStore.open(path)).get('deepseek'), 'test_fake_secret');
      if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.equal((await readFile(path, 'utf8')).includes('test_fake_secret'), true);
    } finally {
      if (before !== undefined) process.env.DEEPSEEK_API_KEY = before;
      else delete process.env.DEEPSEEK_API_KEY;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('temporary key lives in store memory and does not create disk file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-keytemp-'));
  try {
    const path = join(dir, 'credentials.json');
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const store = await CredentialStore.open(path);
      await store.set('anthropic', 'temporary_fake_secret', false);
      assert.equal(store.get('anthropic'), 'temporary_fake_secret');
      await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
