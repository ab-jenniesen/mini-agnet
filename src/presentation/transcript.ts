import type { Message, Usage } from '../core/types.js';

export type TranscriptEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; usage?: Usage; usageScope: 'call' | 'turn' }
  | {
      kind: 'tool';
      callId: string;
      name: string;
      args: string;
      result: string;
      artifactId?: string;
      durationMs?: number;
    }
  | { kind: 'error'; text: string };

export function preview(value: string, limit = 180): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** One projection for loaded history and live messages prevents duplicate tool records. */
export function transcript(messages: Message[]): TranscriptEntry[] {
  const calls = new Map<string, { name: string; args: string }>();
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') entries.push({ kind: 'user', text: message.content });
    if (message.role === 'assistant') {
      if (message.content !== null)
        entries.push({
          kind: 'assistant',
          text: message.content,
          usage: message.usage,
          usageScope: message.tool_calls?.length ? 'call' : 'turn',
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
