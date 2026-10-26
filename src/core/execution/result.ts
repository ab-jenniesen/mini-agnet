import type { ModelFinishReason } from '../model/completion.js';
import type { AgentMetrics, ToolEvidence } from '../model/types.js';

/** Compatibility response statuses; canonical Task and Run statuses live in execution-types.ts. */
export type TaskResponseStatus =
  'completed' | 'failed' | 'cancelled' | 'blocked' | 'waiting' | 'paused' | 'interrupted';
export type FinalTaskStatus = Extract<
  TaskResponseStatus,
  'completed' | 'failed' | 'cancelled' | 'blocked'
>;
export type TaskStatus = 'running' | 'waiting_approval' | TaskResponseStatus;
export type CommandEvidence = Extract<ToolEvidence, { kind: 'command' }>;

export type TaskResult = {
  taskId?: string;
  runId: string;
  sessionId: string;
  status: TaskResponseStatus;
  startedAt: string;
  finishedAt?: string;
  summary: string;
  finishReason?: ModelFinishReason;
  rawFinishReason?: string;
  changes: string[];
  evidence: ToolEvidence[];
  verification: { status: 'not_run' | 'passed' | 'failed'; checks: CommandEvidence[] };
  remaining: string[];
  metrics: AgentMetrics;
  error?: { code: string; message: string };
  completeness?: {
    status: 'not_run' | 'passed' | 'incomplete' | 'error' | 'not_applicable';
    reportId?: string;
  };
};

export type TaskSnapshot = {
  taskId?: string;
  phase?: 'preparing' | 'executing' | 'verifying' | 'finalizing' | 'finalized';
  runId: string;
  sessionId: string;
  status: TaskStatus;
  startedAt: string;
  result?: TaskResult;
};

/** Verification is factual command evidence, never a model's assertion that it tested something. */
export function verification(evidence: ToolEvidence[]): TaskResult['verification'] {
  const checks = evidence.filter(
    (entry): entry is CommandEvidence =>
      entry.kind === 'command' && entry.purpose === 'verification',
  );
  const lastChange = evidence.findLastIndex((entry) => entry.kind === 'file_change');
  const current = new Map<string, CommandEvidence>();
  for (const entry of evidence.slice(lastChange + 1)) {
    if (entry.kind !== 'command' || entry.purpose !== 'verification') continue;
    current.set(JSON.stringify([entry.command, entry.args, entry.cwd]), entry);
  }
  const status = !current.size
    ? 'not_run'
    : [...current.values()].every(
          (check) => check.ok && check.exitCode === 0 && !check.timedOut && !check.cancelled,
        )
      ? 'passed'
      : 'failed';
  return { status, checks };
}

export function metricsSince(
  before: AgentMetrics,
  after: AgentMetrics,
  durationMs: number,
): AgentMetrics {
  return {
    modelCalls: after.modelCalls - before.modelCalls,
    toolCalls: after.toolCalls - before.toolCalls,
    promptTokens: after.promptTokens - before.promptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    totalTokens: after.totalTokens - before.totalTokens,
    modelMs: after.modelMs - before.modelMs,
    toolMs: after.toolMs - before.toolMs,
    lastRunMs: durationMs,
  };
}

/** Legacy string callers still receive rejected promises; structured callers inspect the result. */
export class TaskExecutionError extends Error {
  constructor(readonly result: TaskResult) {
    super(result.error?.message || result.remaining.join('\n') || result.summary);
    this.name = 'TaskExecutionError';
  }
}
