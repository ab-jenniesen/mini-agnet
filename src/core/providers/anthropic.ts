import type { Message, Model, ModelEvent, ModelReply, Tool, Usage } from '../types.js';
import { usage, requestSignal, sse } from './shared.js';
import { finishReason } from '../completion.js';
function anthroMessages(messages: Message[]) {
  const out: Array<{ role: 'user' | 'assistant'; content: any }> = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    if (m.role === 'assistant') {
      const content: any[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.tool_calls ?? [])
        content.push({
          type: 'tool_use',
          id: c.id,
          name: c.function.name,
          input: JSON.parse(c.function.arguments),
        });
      if (content.length) out.push({ role: 'assistant', content });
    }
    if (m.role === 'tool') {
      const last = out.at(-1);
      const result = { type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content };
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(result);
      else out.push({ role: 'user', content: [result] });
    }
  }
  return out;
}
export class AnthropicModel implements Model {
  private maxOutputTokens = 4096;
  setMaxOutputTokens(tokens: number): void {
    if (Number.isSafeInteger(tokens) && tokens > 0) this.maxOutputTokens = tokens;
  }
  constructor(
    private readonly baseURL: string,
    private readonly key: string,
    private readonly model: string,
  ) {}
  async complete(
    messages: Message[],
    tools: Tool[],
    options: { onEvent?: (e: ModelEvent) => void; signal?: AbortSignal } = {},
  ): Promise<ModelReply> {
    const r = requestSignal(options.signal);
    try {
      const response = await fetch(`${this.baseURL.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        signal: r.signal,
        headers: {
          'x-api-key': this.key,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxOutputTokens,
          ...(Number(process.env.AGENT_ANTHROPIC_THINKING_BUDGET) > 0
            ? {
                thinking: {
                  type: 'enabled',
                  budget_tokens: Number(process.env.AGENT_ANTHROPIC_THINKING_BUDGET),
                },
              }
            : {}),
          system: messages
            .filter((m) => m.role === 'system')
            .map((m) => m.content)
            .join('\n'),
          messages: anthroMessages(messages),
          ...(tools.length
            ? {
                tools: tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                })),
              }
            : {}),
          stream: !!options.onEvent,
        }),
      });
      if (!response.ok)
        throw new Error(
          `Anthropic HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`,
        );
      if (!options.onEvent) {
        const data = (await response.json()) as any;
        const content = data.content ?? [];
        return {
          content:
            content
              .filter((x: any) => x.type === 'text')
              .map((x: any) => x.text)
              .join('') || null,
          toolCalls: content
            .filter((x: any) => x.type === 'tool_use')
            .map((x: any) => ({ id: x.id, name: x.name, arguments: JSON.stringify(x.input) })),
          usage: data.usage ? usage(data.usage.input_tokens, data.usage.output_tokens) : undefined,
          finishReason: finishReason(
            data.stop_reason,
            content.filter((x: any) => x.type === 'tool_use').length,
          ),
          rawFinishReason: data.stop_reason ?? undefined,
        };
      }
      let text = '';
      const calls = new Map<number, { id: string; name: string; arguments: string }>();
      let used: Usage | undefined;
      let ended = false;
      let rawFinishReason: string | undefined;
      for await (const e of sse(response)) {
        const d = e.data;
        if (e.event === 'message_delta' && d.delta?.stop_reason)
          rawFinishReason = d.delta.stop_reason;
        if (e.event === 'message_stop') {
          ended = true;
          break;
        }
        if (e.event === 'message_start') used = usage(d.message?.usage?.input_tokens, 0);
        if (e.event === 'content_block_start' && d.content_block?.type === 'tool_use')
          calls.set(d.index, { id: d.content_block.id, name: d.content_block.name, arguments: '' });
        if (e.event === 'content_block_delta') {
          if (d.delta?.type === 'thinking_delta' && typeof d.delta.thinking === 'string')
            options.onEvent({ type: 'thinking', text: d.delta.thinking, source: 'summary' });
          if (d.delta?.type === 'text_delta') {
            text += d.delta.text;
            options.onEvent({ type: 'text', text: d.delta.text });
          }
          if (d.delta?.type === 'input_json_delta') {
            const c = calls.get(d.index);
            if (c) c.arguments += d.delta.partial_json;
          }
        }
        if (e.event === 'message_delta' && d.usage) {
          used = usage(used?.promptTokens, d.usage.output_tokens);
        }
      }
      if (!ended) throw new Error('Anthropic stream terminated before message_stop');
      if (used) options.onEvent({ type: 'usage', usage: used });
      return {
        content: text || null,
        toolCalls: [...calls.values()].map((c) => ({ ...c, arguments: c.arguments || '{}' })),
        usage: used,
        finishReason: finishReason(rawFinishReason, calls.size),
        rawFinishReason,
      };
    } finally {
      r.cleanup();
    }
  }
}
