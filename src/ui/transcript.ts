import type { Message, Usage } from '../protocol/index.js';
import type { ModelFinishReason } from '../protocol/index.js';

/** Public provider thinking stays in client memory, separate from canonical messages. */
export type ThinkingHistory = Readonly<Record<number, string>>;

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'thinking'; text: string; durationMs?: number }
  | {
      kind: 'assistant';
      text: string;
      usage?: Usage;
      usageScope: 'call' | 'turn';
      thinkingMs?: number;
      finishReason?: ModelFinishReason;
    }
  | {
      kind: 'tool';
      callId: string;
      name: string;
      args: string;
      result: string;
      artifactId?: string;
      durationMs?: number;
    }
  | { kind: 'error'; text: string; afterMessageCount?: number };

export function preview(value: string, limit = 180): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** One projection for loaded history and live messages prevents duplicate tool records. */
export function transcript(
  messages: Message[],
  thinkingHistory: ThinkingHistory = {},
): TranscriptEntry[] {
  const calls = new Map<string, { name: string; args: string }>();
  const entries: TranscriptEntry[] = [];
  let turnThinkingMs: number | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      turnThinkingMs = undefined;
      entries.push({ kind: 'user', text: message.content });
    }
    if (message.role === 'assistant') {
      const thinking = thinkingHistory[index];
      if (thinking)
        entries.push({ kind: 'thinking', text: thinking, durationMs: message.thinkingMs });
      if (message.thinkingMs !== undefined)
        turnThinkingMs = (turnThinkingMs ?? 0) + message.thinkingMs;
      if (message.content !== null)
        entries.push({
          kind: 'assistant',
          text: message.content,
          usage: message.usage,
          usageScope: message.tool_calls?.length ? 'call' : 'turn',
          thinkingMs: message.tool_calls?.length ? message.thinkingMs : turnThinkingMs,
          finishReason: message.finishReason,
        });
      for (const call of message.tool_calls ?? [])
        calls.set(call.id, {
          name: call.function.name,
          args: preview(call.function.arguments, 120),
        });
    }
    if (message.role === 'tool') {
      const call = calls.get(message.tool_call_id);
      const artifactId = /^\[ARCHIVED id=([^\s\]]+)/.exec(message.content)?.[1];
      entries.push({
        kind: 'tool',
        callId: message.tool_call_id,
        name: call?.name ?? 'tool',
        args: call?.args ?? '',
        result: preview(message.content),
        artifactId,
      });
    }
  }
  return entries;
}
