import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRuntime, type RuntimeOptions } from '../../src/host/runtime.js';
import type { Model } from '../../src/core/model/types.js';

export async function runtimeFixture(model: Model, overrides: RuntimeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mini-runtime-'));
  const { dependencies, ...options } = overrides;
  const factory = dependencies?.createModel ?? (() => model);
  const runtime = new AgentRuntime({
    root: directory,
    configDirectory: join(directory, 'config'),
    sessionId: 'default',
    summarize: false,
    mcpCommand: undefined,
    mcpArgs: [],
    dependencies: {
      ...dependencies,
      createModel: (selection, key) => withChecklist(factory(selection, key)),
      resolveCapability:
        dependencies?.resolveCapability ??
        (async () => ({
          contextWindow: 32768,
          outputReserve: 4096,
          source: 'override',
        })),
    },
    ...options,
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

/** Existing tests target the execution phase. This stub models a response-only preparation call. */
export function withChecklist(model: Model): Model {
  return {
    setMaxOutputTokens: model.setMaxOutputTokens?.bind(model),
    async complete(messages, tools, options) {
      if (tools.some((tool) => tool.name === 'submit_delivery_checklist')) {
        return {
          content: null,
          toolCalls: [
            {
              id: 'checklist',
              name: 'submit_delivery_checklist',
              arguments: JSON.stringify({
                mode: 'response',
                files: [],
                plan: ['Answer the request'],
              }),
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      return model.complete(messages, tools, options);
    },
  };
}
