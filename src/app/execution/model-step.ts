import { randomUUID } from 'node:crypto';
import type { Message, Tool } from '../../core/model/types.js';
import { finishReason, ModelCompletionError } from '../../core/model/completion.js';
import type { ExecutionOperation } from '../../core/execution/types.js';
import type { ExecutionContext } from './context.js';

export async function executeModelStep(
  ctx: ExecutionContext,
  messages: Message[],
  tools: Tool[],
  visible: boolean,
) {
  const { services, state, run, task, signal } = ctx;
  const operation: ExecutionOperation = {
    id: randomUUID(),
    runId: run.id,
    taskId: task.id,
    nodeRunId: run.currentNodeRunId,
    kind: 'model' as const,
    name: run.phase === 'preparing' ? 'delivery_checklist' : 'model',
    status: 'running' as 'running' | 'completed' | 'failed',
    createdAt: new Date().toISOString(),
    finishedAt: undefined as string | undefined,
    durationMs: undefined as number | undefined,
  };
  state.operations.push(operation);
  await ctx.checkpoint();
  const started = performance.now();
  ctx.emit({ type: 'agent', event: { type: 'model_start', startedAt: Date.now() } });
  let firstText: number | undefined;
  try {
    const prepared = await services.context.prepare(messages, undefined, signal, tools);
    ctx.emit({ type: 'agent', event: { type: 'context', ...prepared.report } });
    services.agent.metrics.modelCalls++;
    const reply = await services.agent.getModel().complete(prepared.messages, tools, {
      signal,
      onEvent: visible
        ? (event) => {
            if (event.type === 'text' && firstText === undefined) {
              firstText = performance.now() - started;
              ctx.emit({ type: 'agent', event: { type: 'thinking_end', ms: firstText } });
            }
            ctx.emit({ type: 'agent', event });
          }
        : undefined,
    });
    operation.details = {
      usageSource: reply.usage ? (reply.usage.estimated ? 'estimated' : 'provider') : 'unknown',
      ...(reply.usage
        ? {
            promptTokens: reply.usage.promptTokens,
            completionTokens: reply.usage.completionTokens,
            totalTokens: reply.usage.totalTokens,
          }
        : {}),
    };
    if (reply.usage) {
      services.agent.metrics.promptTokens += reply.usage.promptTokens;
      services.agent.metrics.completionTokens += reply.usage.completionTokens;
      services.agent.metrics.totalTokens += reply.usage.totalTokens;
    }
    const reason =
      reply.finishReason ?? finishReason(reply.rawFinishReason, reply.toolCalls.length);
    if (['length', 'blocked', 'pause', 'error'].includes(reason))
      throw new ModelCompletionError(
        'invalid_response',
        '模型未正常完成当前阶段',
        reason,
        reply.rawFinishReason,
      );
    operation.status = 'completed';
    return { ...reply, thinkingMs: firstText ?? performance.now() - started };
  } catch (error) {
    operation.status = 'failed';
    throw error;
  } finally {
    const ms = performance.now() - started;
    services.agent.metrics.modelMs += ms;
    operation.finishedAt = new Date().toISOString();
    operation.durationMs = ms;
    ctx.emit({ type: 'agent', event: { type: 'thinking_end', ms: firstText ?? ms } });
  }
}
