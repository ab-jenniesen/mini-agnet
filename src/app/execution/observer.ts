import { randomUUID } from 'node:crypto';
import type { RuntimeEvent } from '../../protocol/contracts.js';
import type { ExecutionState, WorkflowRun } from '../../core/execution/types.js';

export function finishOpenRecords(state: ExecutionState, run: WorkflowRun): void {
  if (!['failed', 'cancelled'].includes(run.status)) return;
  const status = run.status === 'cancelled' ? 'cancelled' : 'failed';
  for (const node of state.nodes.filter((item) => item.runId === run.id)) {
    if (['pending', 'running', 'waiting', 'paused', 'interrupted'].includes(node.status)) {
      node.status = status;
      node.finishedAt = run.finishedAt;
      const attempt = node.attempts.at(-1);
      if (
        attempt &&
        ['pending', 'running', 'waiting', 'paused', 'interrupted'].includes(attempt.status)
      ) {
        attempt.status = status;
        attempt.finishedAt = run.finishedAt;
      }
    }
  }
  for (const wait of state.waits.filter(
    (item) => item.runId === run.id && item.status === 'pending',
  ))
    wait.status = 'cancelled';
  for (const operation of state.operations.filter(
    (item) => item.runId === run.id && item.status === 'running',
  )) {
    operation.status = 'failed';
    operation.finishedAt = run.finishedAt;
  }
}

/** Collect bounded execution evidence without depending on a renderer. */
export function observeExecution(
  state: ExecutionState,
  run: WorkflowRun,
  event: RuntimeEvent,
  modelName: string,
  denied: Set<string>,
): void {
  if (event.type === 'agent' && event.event.type === 'tool_end') {
    const tool = event.event;
    run.evidence.push(...structuredClone(tool.evidence ?? []));
    if (tool.outcome === 'denied') denied.add(tool.name);
    if (tool.outcome === 'success') denied.delete(tool.name);
    const operation = state.operations.findLast(
      (item) => item.id === tool.callId && item.runId === run.id,
    );
    if (operation) {
      operation.status =
        tool.outcome === 'success' ? 'completed' : tool.outcome === 'denied' ? 'denied' : 'failed';
      operation.finishedAt = new Date().toISOString();
      operation.durationMs = tool.ms;
    }
  }
  if (event.type === 'agent' && event.event.type === 'tool_start') {
    state.operations.push({
      id: event.event.callId,
      runId: run.id,
      taskId: run.taskId,
      nodeRunId: run.currentNodeRunId,
      kind: 'tool',
      name: event.event.name,
      status: 'running',
      createdAt: new Date().toISOString(),
    });
  }
  if (event.type === 'agent' && event.event.type === 'model_call') {
    const call = event.event;
    if (call.status === 'started')
      state.operations.push({
        id: call.id,
        runId: run.id,
        taskId: run.taskId,
        nodeRunId: run.currentNodeRunId,
        kind: 'model',
        name: modelName,
        status: 'running',
        createdAt: new Date().toISOString(),
      });
    else {
      const operation = state.operations.findLast((item) => item.id === call.id);
      if (operation) {
        operation.status = call.status;
        operation.durationMs = call.ms;
        operation.finishedAt = new Date().toISOString();
        operation.details = {
          usageSource: call.usage ? (call.usage.estimated ? 'estimated' : 'provider') : 'unknown',
          ...(call.usage
            ? {
                promptTokens: call.usage.promptTokens,
                completionTokens: call.usage.completionTokens,
                totalTokens: call.usage.totalTokens,
              }
            : {}),
        };
      }
    }
  }
  if (event.type === 'agent' && event.event.type === 'context') {
    const { type: _type, ...report } = event.event;
    state.operations.push({
      id: randomUUID(),
      taskId: run.taskId,
      runId: run.id,
      nodeRunId: run.currentNodeRunId,
      kind: 'context',
      name: 'context_view',
      status: 'completed',
      createdAt: new Date().toISOString(),
      details: report,
    });
  }
}
