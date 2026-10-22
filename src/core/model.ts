import { readSseFrames } from './providers/sse.js';
import { finishReason } from './completion.js';
import type { Message, Model, ModelReply, Tool, Usage, ModelEvent } from './types.js';

type Choice = {
  finish_reason?: string | null;
  message?: {
    content?: string | null;
    refusal?: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
};
type ModelBody = {
  choices?: Choice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};
const usageOf = (x: ModelBody['usage']): Usage | undefined =>
  x
    ? {
        promptTokens: x.prompt_tokens ?? 0,
        completionTokens: x.completion_tokens ?? 0,
        totalTokens: x.total_tokens ?? (x.prompt_tokens ?? 0) + (x.completion_tokens ?? 0),
      }
    : undefined;

export class CompatibleChatModel implements Model {
  private maxOutputTokens?: number;
  setMaxOutputTokens(tokens: number): void {
    if (Number.isSafeInteger(tokens) && tokens > 0) this.maxOutputTokens = tokens;
  }
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly model: string,
  ) {}
  async complete(
    messages: Message[],
    tools: Tool[],
    options: { onEvent?: (event: ModelEvent) => void; signal?: AbortSignal } = {},
  ): Promise<ModelReply> {
    const toolSpecs = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const wireMessages = messages.map((message) => {
      if (message.role === 'assistant')
        return {
          role: message.role,
          content: message.content,
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        };
      if (message.role === 'tool')
        return { role: message.role, content: message.content, tool_call_id: message.tool_call_id };
      return { role: message.role, content: message.content };
    });
    const body = {
      model: this.model,
      messages: wireMessages,
      ...(this.maxOutputTokens ? { max_tokens: this.maxOutputTokens } : {}),
      ...(toolSpecs.length ? { tools: toolSpecs, tool_choice: 'auto' } : {}),
      stream: !!options.onEvent,
      ...(options.onEvent ? { stream_options: { include_usage: true } } : {}),
    };
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error('Model request timed out')),
      120_000,
    );
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Cancelled');
      const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Model HTTP ${response.status}: ${(await response.text()).slice(0, 800)}`);
      if (!options.onEvent) {
        const parsed = (await response.json()) as ModelBody;
        const message = parsed.choices?.[0]?.message;
        if (!message) throw new Error('Missing model response');
        return {
          content: message.content ?? message.refusal ?? null,
          toolCalls: (message.tool_calls ?? []).map((c) => ({
            id: c.id,
            name: c.function.name,
            arguments: c.function.arguments,
          })),
          usage: usageOf(parsed.usage),
          finishReason: message.refusal
            ? 'blocked'
            : finishReason(parsed.choices?.[0]?.finish_reason, message.tool_calls?.length ?? 0),
          rawFinishReason: parsed.choices?.[0]?.finish_reason ?? undefined,
        };
      }
      if (!response.body) throw new Error('Streaming response has no body');
      let content = '';
      let usage: Usage | undefined;
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let ended = false;
      let rawFinishReason: string | undefined;
      let refused = false;
      const consume = (event: string) => {
        const data = event.trim();
        if (!data) return;
        if (data === '[DONE]') {
          ended = true;
          return;
        }
        const chunk = JSON.parse(data) as {
          error?: unknown;
          choices?: Array<{
            index?: number;
            finish_reason?: string | null;
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              refusal?: string | null;
              tool_calls?: Array<{
                index: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          usage?: ModelBody['usage'];
        };
        if (chunk.error) throw new Error(`Model stream error: ${JSON.stringify(chunk.error)}`);
        if (chunk.usage) {
          usage = usageOf(chunk.usage);
          if (usage) options.onEvent?.({ type: 'usage', usage });
        }
        for (const choice of chunk.choices ?? []) {
          if (choice.index !== undefined && choice.index !== 0) continue;
          if (choice.finish_reason) rawFinishReason = choice.finish_reason;
          const delta = choice.delta;
          if (delta?.refusal) {
            refused = true;
            content += delta.refusal;
            options.onEvent?.({ type: 'text', text: delta.refusal });
          }
          if (delta?.reasoning_content)
            options.onEvent?.({
              type: 'thinking',
              text: delta.reasoning_content,
              source: 'provider',
            });
          if (delta?.content) {
            content += delta.content;
            options.onEvent?.({ type: 'text', text: delta.content });
          }
          for (const c of delta?.tool_calls ?? []) {
            const old = calls.get(c.index) ?? { id: '', name: '', arguments: '' };
            old.id += c.id ?? '';
            old.name += c.function?.name ?? '';
            old.arguments += c.function?.arguments ?? '';
            calls.set(c.index, old);
          }
        }
      };
      for await (const frame of readSseFrames(response)) {
        consume(frame.data);
        if (ended) break;
      }
      if (!ended) throw new Error('Model stream terminated before [DONE]');
      return {
        content: content || null,
        toolCalls: [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c),
        usage,
        finishReason: refused ? 'blocked' : finishReason(rawFinishReason, calls.size),
        rawFinishReason,
      };
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}
