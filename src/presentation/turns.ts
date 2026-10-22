import type { TranscriptEntry } from './transcript.js';

export type ConversationTurn = { number: number; entries: TranscriptEntry[] };
export type ToolDisplayMode = 'collapsed' | 'recent' | 'all';
export type TurnEntry =
  TranscriptEntry | { kind: 'folded-tools'; count: number; collapsed: boolean };

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
export function visibleTurnEntries(
  entries: TranscriptEntry[],
  maxTools: number,
  mode: ToolDisplayMode = 'recent',
  activeCallId?: string,
): TurnEntry[] {
  if (mode === 'all') return entries;
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const collapsed = mode === 'collapsed';
  const hiddenCount = collapsed ? tools.length : Math.max(0, tools.length - maxTools);
  // The tool result is committed just before tool_end. Count that call only once during this gap.
  const activeCount = activeCallId && !tools.some((entry) => entry.callId === activeCallId) ? 1 : 0;
  const count = hiddenCount + (collapsed ? activeCount : 0);
  const visible: TurnEntry[] = [];
  let skipped = 0;
  for (const entry of entries) {
    if (entry.kind === 'tool' && skipped < hiddenCount) {
      if (skipped === 0) visible.push({ kind: 'folded-tools', count, collapsed });
      skipped++;
    } else visible.push(entry);
  }
  if (collapsed && tools.length === 0 && count > 0)
    visible.push({ kind: 'folded-tools', count, collapsed });
  return visible;
}
