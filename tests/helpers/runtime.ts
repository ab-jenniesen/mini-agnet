import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime } from '../../src/app/runtime.js';
import type { Model } from '../../src/core/types.js';

export async function runtimeFixture(model: Model) {
  const directory = await mkdtemp(join(tmpdir(), 'mini-runtime-'));
  const runtime = new AgentRuntime({
    root: directory,
    configDirectory: join(directory, 'config'),
    sessionId: 'default',
    summarize: false,
    mcpCommand: undefined,
    mcpArgs: [],
    dependencies: {
      createModel: () => model,
      resolveCapability: async () => ({
        contextWindow: 32768,
        outputReserve: 4096,
        source: 'override',
      }),
    },
  });
  return {
    runtime,
    directory,
    async close() {
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const echoModel: Model = {
  async complete(messages, _tools, options) {
    const content = `答复：${messages.findLast((message) => message.role === 'user')?.content}`;
    options?.onEvent?.({ type: 'text', text: content });
    return {
      content,
      toolCalls: [],
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    };
  },
};
