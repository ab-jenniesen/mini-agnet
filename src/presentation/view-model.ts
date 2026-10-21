import type { ApprovalView, RuntimeEvent, RuntimeSnapshot } from '../app/contracts.js';
import type { Message } from '../core/types.js';
import { transcript, preview, type TranscriptEntry } from './transcript.js';

export type Notice = { tone: 'info' | 'warning' | 'error'; text: string };
export type PresentationState = {
  snapshot?: RuntimeSnapshot;
  messages: Message[];
  conversation: TranscriptEntry[];
  answer: string;
  thinking: string;
  step: number;
  activeTool?: { name: string; args: string };
  approval?: ApprovalView;
  notice?: Notice;
};

export const initialPresentationState = (): PresentationState => ({
  messages: [],
  conversation: [],
  answer: '',
  thinking: '',
  step: 0,
});

function rebuild(state: PresentationState, messages: Message[]): TranscriptEntry[] {
  const tools = new Map(
    state.conversation
      .filter((entry) => entry.kind === 'tool')
      .map((entry) => [entry.callId, entry]),
  );
  const entries = transcript(messages).map((entry) =>
    entry.kind === 'tool' && tools.has(entry.callId)
      ? { ...entry, durationMs: tools.get(entry.callId)!.durationMs }
      : entry,
  );
  return [...entries, ...state.conversation.filter((entry) => entry.kind === 'error')];
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
      return {
        ...base,
        snapshot: input.state,
        messages: input.state.history,
        conversation:
          switched || reset
            ? transcript(input.state.history)
            : changed
              ? rebuild(base, input.state.history)
              : base.conversation,
        approval: input.state.pendingApprovals[0],
        ...(!input.state.running ? { answer: '', thinking: '', activeTool: undefined } : {}),
      };
    }
    case 'message': {
      const messages = [...state.messages, input.message];
      const added = transcript(messages).slice(transcript(state.messages).length);
      return {
        ...state,
        messages,
        conversation: [...state.conversation, ...added],
        ...(input.message.role === 'assistant' ? { answer: '', thinking: '' } : {}),
      };
    }
    case 'notice':
      return { ...state, notice: { tone: input.level, text: input.text } };
    case 'run_error':
      return {
        ...state,
        answer: '',
        thinking: '',
        activeTool: undefined,
        conversation: [...state.conversation, { kind: 'error', text: input.text }],
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
          return { ...state, step: event.step, answer: '', thinking: '', activeTool: undefined };
        case 'text':
          return { ...state, answer: state.answer + event.text };
        case 'thinking':
          return { ...state, thinking: (state.thinking + event.text).slice(-16000) };
        case 'tool_start':
          return {
            ...state,
            activeTool: { name: event.name, args: preview(JSON.stringify(event.args) ?? '') },
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
