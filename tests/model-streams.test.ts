import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CompatibleChatModel } from '../src/adapters/models/openai-compatible.js';
import { AnthropicModel, GeminiModel } from '../src/adapters/models/providers.js';
import { readSseFrames } from '../src/adapters/models/sse.js';

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

test('provider finish metadata normalizes truncation, tool use and refusal for JSON and streams', async () => {
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }),
    );
  const compatible = new CompatibleChatModel('https://example.invalid', 'fake', 'fake');
  const truncated = await compatible.complete([], []);
  assert.equal(truncated.finishReason, 'length');
  assert.equal(truncated.rawFinishReason, 'length');
  globalThis.fetch = async () =>
    new Response(
      'data: {"choices":[{"index":0,"delta":{"refusal":"cannot"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  const refused = await compatible.complete([], [], { onEvent: () => {} });
  assert.equal(refused.finishReason, 'blocked');
  assert.equal(refused.content, 'cannot');

  globalThis.fetch = async () =>
    new Response(
      'event: content_block_delta\ndata: {"delta":{"type":"text_delta","text":"partial"}}\n\nevent: message_delta\ndata: {"delta":{"stop_reason":"max_tokens"}}\n\nevent: message_stop\ndata: {}\n\n',
    );
  const anthropic = await new AnthropicModel('https://example.invalid', 'fake', 'fake').complete(
    [],
    [],
    { onEvent: () => {} },
  );
  assert.equal(anthropic.finishReason, 'length');
  assert.equal(anthropic.rawFinishReason, 'max_tokens');

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'partial' }] } }],
      }),
    );
  const gemini = await new GeminiModel('https://example.invalid', 'fake', 'fake').complete([], []);
  assert.equal(gemini.finishReason, 'length');
  assert.equal(gemini.rawFinishReason, 'MAX_TOKENS');
});

test('Gemini streams without a final finishReason fail rather than silently completing', async () => {
  globalThis.fetch = async () =>
    new Response('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n');
  await assert.rejects(
    new GeminiModel('https://example.invalid', 'fake', 'fake').complete([], [], {
      onEvent: () => {},
    }),
    /finishReason/,
  );
});
