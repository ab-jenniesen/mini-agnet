import type { ModelCompletionError } from '../../core/model/completion.js';
import type { ExecutionState, WorkflowRun } from '../../core/execution/types.js';
import { verification, type TaskResult, type TaskSnapshot } from '../../core/execution/result.js';

/** Compatibility views are derived from the canonical V1.2 records. */
export function executionResult(
  state: ExecutionState,
  run: WorkflowRun,
  completion?: ModelCompletionError,
): TaskResult {
  const report = state.reports.find((item) => item.id === run.reportIds.at(-1));
  return {
    runId: run.id,
    taskId: run.taskId,
    sessionId: run.sessionId,
    status:
      run.status === 'failed' &&
      ['model_blocked', 'model_paused', 'approval_denied'].includes(run.error?.code ?? '')
        ? 'blocked'
        : run.status === 'running' || run.status === 'queued'
          ? 'failed'
          : run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: run.summary || run.error?.message || '',
    finishReason: completion?.finishReason ?? run.finishReason,
    rawFinishReason: completion?.rawFinishReason ?? run.rawFinishReason,
    changes: [
      ...new Set(
        run.evidence.filter((item) => item.kind === 'file_change').map((item) => item.path),
      ),
    ],
    evidence: structuredClone(run.evidence),
    verification: verification(run.evidence),
    remaining: run.error ? [run.error.message] : [...run.feedback],
    metrics: structuredClone(run.metrics),
    error: run.error ? { code: run.error.code, message: run.error.message } : undefined,
    completeness: report ? { status: report.status, reportId: report.id } : { status: 'not_run' },
  };
}

export function executionSnapshot(state: ExecutionState, run: WorkflowRun): TaskSnapshot {
  return {
    runId: run.id,
    taskId: run.taskId,
    sessionId: run.sessionId,
    phase: run.phase,
    status: run.status === 'queued' ? 'running' : run.status,
    startedAt: run.startedAt,
    ...(['running', 'queued'].includes(run.status) ? {} : { result: executionResult(state, run) }),
  };
}
