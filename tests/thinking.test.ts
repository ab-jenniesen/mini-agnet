import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/core/agent.js';
import { ToolRegistry } from '../src/core/registry.js';
import type { Model } from '../src/core/types.js';

test('thinking is forwarded to UI but never persisted in canonical messages', async () => {
  const events: string[] = [];
  const model: Model = {
    async complete(_messages, _tools, options) {
      options?.onEvent?.({ type: 'thinking', text: 'public summary', source: 'summary' });
      options?.onEvent?.({ type: 'text', text: 'Final answer' });
      return { content: 'Final answer', toolCalls: [] };
    },
  };
  const agent = new Agent(model, new ToolRegistry(), 'system', {
    onProgress: (e) => events.push(e.type),
  });
  assert.equal(await agent.run('test'), 'Final answer');
  assert.ok(events.includes('thinking'));
  assert.equal(JSON.stringify(agent.history).includes('public summary'), false);
});
