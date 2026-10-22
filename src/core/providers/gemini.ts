import { randomUUID } from 'node:crypto';
import type { Message, Model, ModelEvent, ModelReply, Tool, Usage } from '../types.js';
import { usage, requestSignal, sse } from './shared.js';
import { finishReason } from '../completion.js';
function geminiMessages(messages: Message[]) {
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') out.push({ role: 'user', parts: [{ text: m.content }] });
    if (m.role === 'assistant') {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const c of m.tool_calls ?? [])
        parts.push({
          functionCall: { name: c.function.name, args: JSON.parse(c.function.arguments) },
        });
      if (parts.length) out.push({ role: 'model', parts });
    }
    if (m.role === 'tool') {
      const assistant = [...messages]
        .reverse()
        .find((x) => x.role === 'assistant' && x.tool_calls?.some((c) => c.id === m.tool_call_id));
      const toolName =
        assistant?.role === 'assistant'
          ? assistant.tool_calls?.find((c) => c.id === m.tool_call_id)?.function.name
          : 'unknown';
      const last = out.at(-1);
      const part = { functionResponse: { name: toolName, response: { result: m.content } } };
      if (last?.role === 'user' && last.parts?.[0]?.functionResponse) last.parts.push(part);
      else out.push({ role: 'user', parts: [part] });
    }
  }
  return out;
}
export class GeminiModel implements Model {
  private maxOutputTokens?: number;
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
      const endpoint = options.onEvent ? 'streamGenerateContent?alt=sse' : 'generateContent';
      const response = await fetch(
        `${this.baseURL.replace(/\/$/, '')}/models/${encodeURIComponent(this.model)}:${endpoint}`,
        {
          method: 'POST',
          signal: r.signal,
          headers: { 'x-goog-api-key': this.key, 'content-type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: messages
                    .filter((m) => m.role === 'system')
                    .map((m) => m.content)
                    .join('\n'),
                },
              ],
            },
            contents: geminiMessages(messages),
            ...(this.maxOutputTokens || process.env.AGENT_GEMINI_THOUGHTS === '1'
              ? {
                  generationConfig: {
                    ...(this.maxOutputTokens ? { maxOutputTokens: this.maxOutputTokens } : {}),
                    ...(process.env.AGENT_GEMINI_THOUGHTS === '1'
                      ? { thinkingConfig: { includeThoughts: true } }
                      : {}),
                  },
                }
              : {}),
            ...(tools.length
              ? {
                  tools: [
                    {
                      functionDeclarations: tools.map((t) => ({
                        name: t.name,
                        description: t.description,
                        parameters: t.parameters,
                      })),
                    },
                  ],
                }
              : {}),
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      let text = '';
      let used: Usage | undefined;
      const calls: { id: string; name: string; arguments: string }[] = [];
      const callPrefix = randomUUID();
      let index = 0;
      let rawFinishReason: string | undefined;
      let promptBlocked = false;
      const consume = (d: any) => {
        if (d.error) throw new Error('Gemini response error: ' + JSON.stringify(d.error));
        if (d.promptFeedback?.blockReason) {
          promptBlocked = true;
          rawFinishReason = d.promptFeedback.blockReason;
        }
        if (d.candidates?.[0]?.finishReason) rawFinishReason = d.candidates[0].finishReason;
        for (const part of d.candidates?.[0]?.content?.parts ?? []) {
          if (part.text) {
            if (part.thought === true)
              options.onEvent?.({ type: 'thinking', text: part.text, source: 'summary' });
            else {
              text += part.text;
              options.onEvent?.({ type: 'text', text: part.text });
            }
          }
          if (part.functionCall)
            calls.push({
              id: `gemini-${callPrefix}-${index++}`,
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            });
        }
        if (d.usageMetadata) {
          used = usage(
            d.usageMetadata.promptTokenCount,
            (d.usageMetadata.candidatesTokenCount ?? 0) + (d.usageMetadata.thoughtsTokenCount ?? 0),
          );
          if (typeof d.usageMetadata.totalTokenCount === 'number')
            used.totalTokens = d.usageMetadata.totalTokenCount;
        }
      };
      if (options.onEvent) {
        for await (const e of sse(response)) consume(e.data);
        if (!rawFinishReason && !promptBlocked)
          throw new Error('Gemini stream terminated before finishReason');
      } else consume(await response.json());
      if (used) options.onEvent?.({ type: 'usage', usage: used });
      return {
        content: text || null,
        toolCalls: calls,
        usage: used,
        finishReason: promptBlocked ? 'blocked' : finishReason(rawFinishReason, calls.length),
        rawFinishReason,
      };
    } finally {
      r.cleanup();
    }
  }
}
