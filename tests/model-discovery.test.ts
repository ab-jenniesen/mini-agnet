import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { discoverModels } from '../src/adapters/models/discovery.js';
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});
test('OpenAI-compatible models are discovered with bearer authentication', async () => {
  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/models$/);
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-key');
    return new Response(
      JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b', name: 'Model B' }] }),
      { status: 200 },
    );
  };
  const result = await discoverModels({ providerId: 'deepseek', key: 'test-key' });
  assert.equal(result.source, 'live');
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['model-a', 'model-b'],
  );
});
test('Claude model pagination and x-api-key', async () => {
  let pages = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal((init?.headers as Record<string, string>)['x-api-key'], 'secret');
    if (++pages === 1)
      return new Response(
        JSON.stringify({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }),
      );
    assert.match(String(input), /after_id=claude-a/);
    return new Response(JSON.stringify({ data: [{ id: 'claude-b' }], has_more: false }));
  };
  const r = await discoverModels({ providerId: 'anthropic', key: 'secret' });
  assert.equal(r.source, 'live');
  assert.equal(r.models.length, 2);
});
test('Gemini strips models prefix and uses paginated x-goog-api-key', async () => {
  let n = 0;
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>)['x-goog-api-key'], 'key');
    return new Response(
      JSON.stringify(
        ++n === 1
          ? {
              models: [{ name: 'models/gemini-test', displayName: 'Gemini Test' }],
              nextPageToken: 'next',
            }
          : { models: [{ name: 'models/gemini-next' }] },
      ),
    );
  };
  const r = await discoverModels({ providerId: 'gemini', key: 'key' });
  assert.equal(r.source, 'live');
  assert.deepEqual(
    r.models.map((x) => x.id),
    ['gemini-next', 'gemini-test'],
  );
});
test('HTTP failures fall back without exposing API key', async () => {
  globalThis.fetch = async () => new Response('bad auth', { status: 401 });
  const r = await discoverModels({ providerId: 'deepseek', key: 'secret-must-not-leak' });
  assert.equal(r.source, 'fallback');
  assert.ok(!JSON.stringify(r).includes('secret-must-not-leak'));
});
test('Ollama tags are supported without API key', async () => {
  globalThis.fetch = async (input) => {
    assert.match(String(input), /\/api\/tags$/);
    return new Response(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
  };
  const r = await discoverModels({ providerId: 'ollama' });
  assert.equal(r.source, 'live');
  assert.equal(r.models[0].id, 'qwen3:8b');
});
