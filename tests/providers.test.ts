import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadSelection,
  saveSelection,
  AnthropicModel,
  GeminiModel,
  PROVIDERS,
} from '../src/core/providers.js';
import type { Message, Tool } from '../src/core/types.js';

const tool: Tool = {
  name: 'echo',
  description: 'Echo string',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  execute: async () => '',
};
const history: Message[] = [
  { role: 'system', content: 'System' },
  { role: 'user', content: 'Say hello' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'hi' },
];
const oldFetch = globalThis.fetch;
function mockFetch(response: unknown, observer: (url: string, options: RequestInit) => void) {
  globalThis.fetch = async (input, init) => {
    observer(String(input), init ?? {});
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}
test('first run picks DeepSeek and saves last chosen model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-selection-'));
  const path = join(dir, 'choice.json');
  assert.deepEqual(await loadSelection(path), {
    provider: 'deepseek',
    model: process.env.DEEPSEEK_MODEL ?? PROVIDERS.find((p) => p.id === 'deepseek')!.defaultModel,
  });
  const choice = { provider: 'anthropic', model: 'claude-sonnet-5-5' };
  await saveSelection(path, choice);
  assert.deepEqual(await loadSelection(path), choice);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), choice);
});
test('provider catalog includes native and compatible protocols', () => {
  assert.ok(PROVIDERS.some((p) => p.id === 'deepseek'));
  assert.equal(PROVIDERS.find((p) => p.id === 'gemini')?.kind, 'gemini');
  assert.equal(PROVIDERS.find((p) => p.id === 'anthropic')?.kind, 'anthropic');
});
test('Anthropic maps tool calls and tool results from vendor-independent history', async () => {
  let captured: any;
  mockFetch(
    {
      content: [{ type: 'text', text: 'Finished' }],
      usage: { input_tokens: 30, output_tokens: 7 },
    },
    (_, init) => {
      captured = JSON.parse(String(init.body));
    },
  );
  try {
    const model = new AnthropicModel('https://api.anthropic.com/v1', 'test', 'claude-test');
    const result = await model.complete(history, [tool]);
    assert.equal(result.content, 'Finished');
    assert.equal(result.usage?.totalTokens, 37);
    assert.deepEqual(captured.messages[1].content[0].type, 'tool_use');
    assert.equal(captured.messages[2].content[0].type, 'tool_result');
    assert.equal(captured.messages[2].content[0].tool_use_id, 'call_1');
  } finally {
    globalThis.fetch = oldFetch;
  }
});
test('Gemini maps tool calls and tool results from same history', async () => {
  let captured: any;
  mockFetch(
    {
      candidates: [{ content: { parts: [{ text: 'Finished' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
    },
    (_, init) => {
      captured = JSON.parse(String(init.body));
    },
  );
  try {
    const model = new GeminiModel(
      'https://generativelanguage.googleapis.com/v1beta',
      'test',
      'gemini-test',
    );
    const result = await model.complete(history, [tool]);
    assert.equal(result.content, 'Finished');
    assert.equal(result.usage?.totalTokens, 13);
    assert.equal(captured.contents[1].parts[0].functionCall.name, 'echo');
    assert.equal(captured.contents[2].parts[0].functionResponse.name, 'echo');
  } finally {
    globalThis.fetch = oldFetch;
  }
});
test('Anthropic streaming emits text, collects tool args and usage', async () => {
  const data = [
    ['message_start', { message: { usage: { input_tokens: 12 } } }],
    [
      'content_block_start',
      { index: 0, content_block: { type: 'tool_use', id: 'anthro-1', name: 'echo', input: {} } },
    ],
    [
      'content_block_delta',
      { index: 0, delta: { type: 'input_json_delta', partial_json: '{"text":"hi"}' } },
    ],
    ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'checking' } }],
    ['message_delta', { usage: { output_tokens: 8 } }],
    ['message_stop', {}],
  ]
    .map(([name, body]) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`)
    .join('');
  globalThis.fetch = async () =>
    new Response(data, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const seen: string[] = [];
  try {
    const m = new AnthropicModel('https://api.anthropic.com/v1', 'test', 'claude-test');
    const result = await m.complete([{ role: 'user', content: 'hello' }], [tool], {
      onEvent: (e) => {
        if (e.type === 'text') seen.push(e.text);
      },
    });
    assert.equal(result.content, 'checking');
    assert.deepEqual(seen, ['checking']);
    assert.equal(result.toolCalls[0]?.arguments, '{"text":"hi"}');
    assert.equal(result.usage?.totalTokens, 20);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
test('Gemini SSE streaming parses text and functionCall', async () => {
  const frames = [
    { candidates: [{ content: { parts: [{ text: 'working' }] } }] },
    {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'echo', args: { text: 'hi' } } }] } },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    },
  ]
    .map((x) => `data: ${JSON.stringify(x)}\n\n`)
    .join('');
  globalThis.fetch = async () =>
    new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const m = new GeminiModel(
      'https://generativelanguage.googleapis.com/v1beta',
      'test',
      'gemini-test',
    );
    const result = await m.complete([{ role: 'user', content: 'hello' }], [tool], {
      onEvent: () => {},
    });
    assert.equal(result.content, 'working');
    assert.equal(result.toolCalls[0]?.name, 'echo');
    assert.equal(result.usage?.totalTokens, 6);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('Gemini separates thought summaries from visible answers', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Planning steps', thought: true }, { text: 'Answer' }] } }] })}\n\n`,
      { status: 200 },
    );
  const events: string[] = [];
  try {
    const m = new GeminiModel(
      'https://generativelanguage.googleapis.com/v1beta',
      'test',
      'gemini-test',
    );
    const reply = await m.complete([{ role: 'user', content: 'hello' }], [], {
      onEvent: (e) => events.push(`${e.type}:${'text' in e ? e.text : ''}`),
    });
    assert.equal(reply.content, 'Answer');
    assert.deepEqual(events, ['thinking:Planning steps', 'text:Answer']);
  } finally {
    globalThis.fetch = old;
  }
});
test('Anthropic thinking_delta is distinct from normal reply text', async () => {
  const old = globalThis.fetch;
  const data = [
    ['message_start', { message: { usage: { input_tokens: 2 } } }],
    [
      'content_block_delta',
      { index: 0, delta: { type: 'thinking_delta', thinking: 'Public thinking summary' } },
    ],
    ['content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Reply' } }],
    ['message_stop', {}],
  ]
    .map(([name, body]) => `event: ${name}\ndata: ${JSON.stringify(body)}\n\n`)
    .join('');
  globalThis.fetch = async () => new Response(data, { status: 200 });
  const events: string[] = [];
  try {
    const m = new AnthropicModel('https://api.anthropic.com/v1', 'test', 'claude-test');
    const reply = await m.complete([{ role: 'user', content: 'hello' }], [], {
      onEvent: (e) => events.push(`${e.type}:${'text' in e ? e.text : ''}`),
    });
    assert.equal(reply.content, 'Reply');
    assert.deepEqual(events, ['thinking:Public thinking summary', 'text:Reply', 'usage:']);
  } finally {
    globalThis.fetch = old;
  }
});
