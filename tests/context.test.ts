import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextManager } from '../src/core/context/manager.js';
import type { Message } from '../src/core/types.js';

test('removes a complete old turn, preserving request history', async () => {
  const h: Message[] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'old' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'read', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'c', content: 'abc'.repeat(600) },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'new' },
    { role: 'assistant', content: 'current' },
  ];
  const { messages, report } = await new ContextManager({
    maxInputTokens: 500,
    reservedOutputTokens: 200,
    recentTurns: 1,
  }).prepare(h);
  assert.ok(report.removedMessages >= 3);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['system', 'user', 'assistant'],
  );
  assert.equal(h.length, 7);
});
test('truncates tools in request copy only', async () => {
  const h: Message[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: '1', type: 'function', function: { name: 't', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: '1', content: 'x'.repeat(7000) },
  ];
  const { messages, report } = await new ContextManager({
    maxInputTokens: 1000,
    reservedOutputTokens: 200,
    maxToolResultTokens: 80,
  }).prepare(h);
  assert.equal(report.truncatedToolResults, 1);
  assert.ok(messages.some((m) => m.role === 'tool' && m.content.includes('TRUNCATED')));
  assert.equal((h[3] as { content: string }).content.length, 7000);
});
test('retrieves memory into labeled ephemeral note', async () => {
  const h: Message[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'TypeScript' },
  ];
  const memory = { search: () => [{ text: 'Prefer TypeScript' }] };
  const { messages, report } = await new ContextManager({}, memory as any).prepare(h);
  assert.equal(report.recalledMemories, 1);
  assert.ok(messages[1]?.role === 'user' && messages[1].content.includes('untrusted'));
  assert.equal(h.length, 2);
});
test('refuses oversized current request', async () => {
  const h: Message[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'x'.repeat(8000) },
  ];
  await assert.rejects(
    new ContextManager({ maxInputTokens: 500, reservedOutputTokens: 200 }).prepare(h),
    /Context overflow/,
  );
});

test('an incomplete summary is neither used nor saved, including raw provider end metadata', async () => {
  for (const metadata of [{ finishReason: 'length' as const }, { rawFinishReason: 'max_tokens' }]) {
    let saved = false;
    const history: Message[] = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'old '.repeat(700) },
      { role: 'assistant', content: 'old response '.repeat(200) },
      { role: 'user', content: 'new question' },
    ];
    const context = new ContextManager(
      { maxInputTokens: 1200, reservedOutputTokens: 200, summarize: true, recentTurns: 1 },
      undefined,
      {
        read: async () => undefined,
        save: async () => {
          saved = true;
        },
      },
    );
    const prepared = await context.prepare(history, {
      complete: async () => ({ content: 'incomplete summary', toolCalls: [], ...metadata }),
    });
    assert.equal(saved, false);
    assert.equal(prepared.report.summaryCreated, false);
    assert.equal(
      prepared.messages.some((message) => message.content?.includes('incomplete summary')),
      false,
    );
    assert.equal(history.length, 4);
  }
});
