import type { ContextReport } from './context/types.js';
import type { AgentMetrics, Message, Model, Tool } from './model/types.js';
import type { AgentInvocation, AgentRunResult } from './agent.js';

export interface AgentLoopPort {
  readonly history: Message[];
  readonly metrics: AgentMetrics;
  getModel(): Model;
  setModel(model: Model): void;
  setContext(context: ContextPort): void;
  setJournal(journal: JournalPort): void;
  runDetailed(input: string, runId?: string, invocation?: AgentInvocation): Promise<AgentRunResult>;
}

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
