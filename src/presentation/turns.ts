import type { TranscriptEntry } from './transcript.js';

export type ConversationTurn = { number: number; entries: TranscriptEntry[] };
export type TurnEntry = TranscriptEntry | { kind: 'folded-tools'; count: number };

/** A user message starts a turn; model steps and tool results belong to that same turn. */
export function conversationTurns(entries: TranscriptEntry[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  let number = 0;
  for (const entry of entries) {
    if (entry.kind === 'user') number++;
    if (entry.kind === 'user' || turns.length === 0) turns.push({ number, entries: [] });
    turns[turns.length - 1]!.entries.push(entry);
  }
  return turns;
}

/** Limit the display only. The transcript and model's canonical history remain complete. */
export function visibleTurnEntries(entries: TranscriptEntry[], maxTools: number): TurnEntry[] {
  const toolCount = entries.filter((entry) => entry.kind === 'tool').length;
  const hiddenCount = Math.max(0, toolCount - maxTools);
  const visible: TurnEntry[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (entry.kind === 'tool' && skipped < hiddenCount) {
      if (skipped === 0) visible.push({ kind: 'folded-tools', count: hiddenCount });
      skipped++;
    } else visible.push(entry);
  }
  return visible;
}
