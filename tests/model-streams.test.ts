import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleChatModel } from '../src/core/model.js';
import { AnthropicModel, GeminiModel } from '../src/core/providers.js';
import { readSseFrames } from '../src/core/providers/sse.js';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('SSE parsing handles split UTF-8 bytes, CRLF and a final frame without a blank line', async () => {
  const encoded = new TextEncoder().encode(
    'event: delta\r\ndata: {"text":"你好"}\r\n\r\ndata: [DONE]',
  );
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    }),
  );
  const frames = [];
  for await (const frame of readSseFrames(response)) frames.push(frame);
  assert.deepEqual(frames, [
    { event: 'delta', data: '{"text":"你好"}' },
    { event: 'message', data: '[DONE]' },
  ]);
});

test('OpenAI-compatible streaming exits at DONE even if the server keeps the connection open', async () => {
  let cancelled = false;
  let body: Record<string, unknown> = {};
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
            ),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  };
  const model = new CompatibleChatModel('https://example.invalid', 'fake', 'fake');
  assert.equal(
    (await model.complete([{ role: 'user', content: 'go' }], [], { onEvent: () => {} })).content,
    'ok',
  );
  assert.equal(cancelled, true);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
});

test('provider error frames and interrupted Anthropic streams fail instead of returning success', async () => {
  globalThis.fetch = async () =>
    new Response('event: error\ndata: {"error":{"message":"failed"}}\n\n');
  await assert.rejects(
    new AnthropicModel('https://example.invalid', 'fake', 'fake').complete([], [], {
      onEvent: () => {},
    }),
    /stream error/,
  );
  await assert.rejects(
    new GeminiModel('https://example.invalid', 'fake', 'fake').complete([], [], {
      onEvent: () => {},
    }),
    /stream error/,
  );
  globalThis.fetch = async () =>
    new Response(
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"partial"}}\n\n',
    );
  await assert.rejects(
    new AnthropicModel('https://example.invalid', 'fake', 'fake').complete([], [], {
      onEvent: () => {},
    }),
    /message_stop/,
  );
});

test('Gemini tool IDs are unique between model turns and usage includes thought tokens', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ functionCall: { name: 'ping', args: {} } }] } }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 2,
          thoughtsTokenCount: 4,
          totalTokenCount: 16,
        },
      }),
    );
  const model = new GeminiModel('https://example.invalid', 'fake', 'fake');
  const first = await model.complete([], []);
  const second = await model.complete([], []);
  assert.notEqual(first.toolCalls[0].id, second.toolCalls[0].id);
  assert.deepEqual(first.usage, { promptTokens: 10, completionTokens: 6, totalTokens: 16 });
});
