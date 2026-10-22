import type { ApprovalView, RuntimeEvent, RuntimeSnapshot } from '../app/contracts.js';
import type { Message } from '../core/types.js';
import { transcript, preview, type ThinkingHistory, type TranscriptEntry } from './transcript.js';

export type Notice = { tone: 'info' | 'warning' | 'error'; text: string };
export type PresentationState = {
  snapshot?: RuntimeSnapshot;
  messages: Message[];
  conversation: TranscriptEntry[];
  answer: string;
  thinking: string;
  thinkingHistory: ThinkingHistory;
  modelActivity?: { startedAt: number; thinkingMs?: number };
  step: number;
  activeTool?: { callId: string; name: string; args: string };
  approval?: ApprovalView;
  notice?: Notice;
};

export const initialPresentationState = (): PresentationState => ({
  messages: [],
  conversation: [],
  answer: '',
  thinking: '',
  thinkingHistory: {},
  step: 0,
});

function rebuild(state: PresentationState, messages: Message[]): TranscriptEntry[] {
  const tools = new Map(
    state.conversation
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => [entry.callId, entry]),
  );
  const entries = transcript(messages, state.thinkingHistory).map((entry) =>
    entry.kind === 'tool' && tools.has(entry.callId)
      ? { ...entry, durationMs: tools.get(entry.callId)!.durationMs }
      : entry,
  );
  let inserted = 0;
  for (const entry of state.conversation) {
    if (entry.kind !== 'error') continue;
    const count = entry.afterMessageCount ?? messages.length;
    const position = transcript(messages.slice(0, count), state.thinkingHistory).length;
    entries.splice(position + inserted++, 0, entry);
  }
  return entries;
}

/** Pure state transitions, reusable by any renderer and testable without a terminal. */
export function reducePresentation(
  state: PresentationState,
  input: RuntimeEvent,
): PresentationState {
  switch (input.type) {
    case 'state': {
      const switched = state.snapshot?.id !== input.state.id;
      const reset = input.state.history.length < state.messages.length;
      const changed = JSON.stringify(state.messages) !== JSON.stringify(input.state.history);
      const base = switched || reset ? initialPresentationState() : state;
      // Message indices survive append-only snapshots, but edited/replaced messages must lose stale text.
      const thinkingHistory = Object.fromEntries(
        Object.entries(base.thinkingHistory).filter(([index]) => {
          const position = Number(index);
          return (
            JSON.stringify(base.messages[position]) ===
            JSON.stringify(input.state.history[position])
          );
        }),
      );
      return {
        ...base,
        thinkingHistory,
        snapshot: input.state,
        messages: input.state.history,
        conversation:
          switched || reset
            ? transcript(input.state.history)
            : changed
              ? rebuild({ ...base, thinkingHistory }, input.state.history)
              : base.conversation,
        approval: input.state.pendingApprovals[0],
        ...(!input.state.running
          ? { answer: '', thinking: '', modelActivity: undefined, activeTool: undefined }
          : {}),
      };
    }
    case 'message': {
      const messages = [...state.messages, input.message];
      const thinkingHistory =
        input.message.role === 'assistant' && state.thinking
          ? { ...state.thinkingHistory, [state.messages.length]: state.thinking }
          : state.thinkingHistory;
      const added = transcript(messages, thinkingHistory).slice(
        transcript(state.messages, state.thinkingHistory).length,
      );
      return {
        ...state,
        messages,
        thinkingHistory,
        conversation: [...state.conversation, ...added],
        ...(input.message.role === 'assistant'
          ? { answer: '', thinking: '', modelActivity: undefined }
          : {}),
      };
    }
    case 'notice':
      return { ...state, notice: { tone: input.level, text: input.text } };
    case 'run_error':
      return {
        ...state,
        answer: '',
        thinking: '',
        modelActivity: undefined,
        activeTool: undefined,
        conversation: [
          ...state.conversation,
          { kind: 'error', text: input.text, afterMessageCount: state.messages.length },
        ],
      };
    case 'approval_requested':
      return { ...state, approval: input.approval };
    case 'approval_resolved':
      return state.approval?.request.id === input.id ? { ...state, approval: undefined } : state;
    case 'permission':
      return state;
    case 'agent': {
      const event = input.event;
      switch (event.type) {
        case 'step':
          return {
            ...state,
            step: event.step,
            answer: '',
            thinking: '',
            modelActivity: undefined,
            activeTool: undefined,
          };
        case 'model_start':
          return { ...state, modelActivity: { startedAt: event.startedAt } };
        case 'thinking_end':
          return {
            ...state,
            modelActivity: state.modelActivity
              ? { ...state.modelActivity, thinkingMs: event.ms }
              : undefined,
          };
        case 'text':
          return { ...state, answer: state.answer + event.text };
        case 'thinking':
          return { ...state, thinking: state.thinking + event.text };
        case 'tool_start':
          return {
            ...state,
            activeTool: {
              callId: event.callId,
              name: event.name,
              args: preview(JSON.stringify(event.args) ?? ''),
            },
          };
        case 'tool_end':
          return {
            ...state,
            activeTool: undefined,
            conversation: state.conversation.map((entry) =>
              entry.kind === 'tool' && entry.callId === event.callId
                ? { ...entry, durationMs: event.ms, artifactId: event.artifactId }
                : entry,
            ),
          };
        case 'context':
          return {
            ...state,
            notice: {
              tone: 'info',
              text: `上下文约 ${event.estimatedTokens}/${event.budget} Token · 召回 ${event.recalledMemories} 条记忆 · 裁剪 ${event.truncatedToolResults} 条工具结果`,
            },
          };
        case 'compact':
          return {
            ...state,
            notice: { tone: 'info', text: `上下文压缩：省略 ${event.removedMessages} 条旧消息` },
          };
        default:
          return state;
      }
    }
  }
}
