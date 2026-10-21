import type { ContextReport } from './context/manager.js';
import type { Message, Model, Tool } from './types.js';

/** The loop depends on these capabilities, never on filesystem implementations. */
export interface ContextPort {
  prepare(
    history: Message[],
    model?: Model,
    signal?: AbortSignal,
    tools?: Tool[],
  ): Promise<{
    messages: Message[];
    report: ContextReport;
  }>;
}

export interface ArtifactPort {
  save(value: string): Promise<{ id: string; length: number }>;
}

export interface JournalPort {
  begin(runId: string): Promise<void>;
  startTool(callId: string, name: string): Promise<void>;
  finishTool(callId: string, result: string): Promise<void>;
  finish(status: 'completed' | 'interrupted'): Promise<void>;
}
