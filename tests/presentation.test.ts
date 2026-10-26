import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { initialPresentationState, reducePresentation } from '../src/ui/view-model.js';
import { runtimeFixture, echoModel } from './helpers/runtime.js';

test('presentation keeps transcript types separate and preserves error order while replacing notices', async () => {
  const f = await runtimeFixture(echoModel);
  try {
    let state = reducePresentation(initialPresentationState(), {
      type: 'state',
      state: await f.runtime.initialize(),
    });
    state = reducePresentation(state, { type: 'notice', level: 'info', text: 'old' });
    state = reducePresentation(state, { type: 'notice', level: 'info', text: 'new' });
    state = reducePresentation(state, {
      type: 'message',
      message: { role: 'user', content: 'one' },
    });
    state = reducePresentation(state, { type: 'run_error', text: 'failed' });
    state = reducePresentation(state, {
      type: 'message',
      message: { role: 'user', content: 'two' },
    });
    assert.deepEqual(
      state.conversation.map((entry) => entry.kind),
      ['user', 'error', 'user'],
    );
    assert.equal(state.notice?.text, 'new');
    const updated = reducePresentation(state, {
      type: 'state',
      state: {
        ...f.runtime.snapshot(),
        history: [...state.messages, { role: 'assistant', content: 'reply' }],
      },
    });
    assert.deepEqual(
      updated.conversation.map((entry) => entry.kind),
      ['user', 'error', 'user', 'assistant'],
    );
    const reset = reducePresentation(state, { type: 'state', state: f.runtime.snapshot() });
    assert.deepEqual(reset.conversation, []);
  } finally {
    await f.close();
  }
});

test('application, core, tools and storage have no UI dependency or terminal output', async () => {
  const sourceRoot = resolve(import.meta.dirname, '../src');
  async function scan(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await scan(path);
      else if (item.name.endsWith('.ts')) {
        const source = await readFile(path, 'utf8');
        assert.doesNotMatch(
          source,
          /from\s+['"][^'"]*(?:presentation|pi-tui|react|ink)[/'"]/i,
          path,
        );
        assert.doesNotMatch(source, /process\.(?:stdout|stdin)|console\.log\(/, path);
      }
    }
  }
  for (const name of ['core', 'app', 'tools', 'infra']) await scan(join(sourceRoot, name));
  const client = await readFile(join(sourceRoot, 'adapters/http/client.ts'), 'utf8');
  assert.doesNotMatch(client, /from\s+['"]node:|AgentRuntime|pi-tui/);
});
