import { randomUUID } from 'node:crypto';
import type { Message } from '../../core/model/types.js';
import type { WorkflowNode } from '../../core/workflow/definition.js';
import type { NodeRun } from '../../core/execution/types.js';
import { truncateByTokens } from '../../core/context/tokens.js';
import type { ExecutionContext } from './context.js';
import type { NodeExecutionContext } from '../nodes/types.js';
import { executeModelStep } from './model-step.js';
import { planTools } from './plan-tools.js';

function message(ctx: ExecutionContext, value: Message): void {
  ctx.services.agent.history.push(value);
  ctx.emit({ type: 'message', message: value });
}

export function nodeActions(
  ctx: ExecutionContext,
  definition: WorkflowNode,
  node: NodeRun,
): NodeExecutionContext {
  const { services, run, signal } = ctx;
  const instructions = () =>
    [
      definition.config.instructions ?? '',
      'Work on this task and fixed delivery contract. File acceptance only checks presence. Do not claim semantic verification from presence alone.',
      JSON.stringify({
        task: {
          id: ctx.task.id,
          goal: ctx.task.goal,
          deliverables: ctx.task.checklist?.files.map((item) => item.path) ?? [],
          plan: {
            total: ctx.task.plan?.steps.length ?? 0,
            steps:
              ctx.task.plan?.steps
                .filter((step) => ['pending', 'running', 'failed'].includes(step.status))
                .slice(0, 5)
                .map((step) => ({
                  id: step.id,
                  status: step.status,
                  text: truncateByTokens(step.text, 256),
                })) ?? [],
          },
        },
        input: run.input,
        inputs: node.inputs,
        feedback: run.feedback,
      }),
    ].join('\n');

  return {
    inputs: structuredClone(node.inputs),
    definition: structuredClone(definition),
    signal,
    async runTool() {
      if (definition.type !== 'tool') throw new Error('This node has no standalone tool action');
      const name = definition.config.toolRef!;
      if (
        !services.context.options.generateMemory &&
        ['memory_save', 'memory_update'].includes(name)
      )
        throw new Error('Memory generation is disabled by the context policy');
      const callId = randomUUID();
      message(ctx, {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: callId,
            type: 'function',
            function: { name, arguments: JSON.stringify(node.inputs) },
          },
        ],
      });
      ctx.emit({
        type: 'agent',
        event: { type: 'tool_start', callId, name, args: node.inputs },
      });
      const started = performance.now();
      const result = await services.registry.invokeDetailed(
        name,
        node.inputs,
        async () => false,
        callId,
        signal,
      );
      const ms = performance.now() - started;
      services.agent.metrics.toolCalls++;
      services.agent.metrics.toolMs += ms;
      message(ctx, { role: 'tool', tool_call_id: callId, content: result.output });
      ctx.emit({
        type: 'agent',
        event: {
          type: 'tool_end',
          callId,
          name,
          result: result.output.slice(0, 300),
          ms,
          evidence: result.evidence,
          outcome: result.status,
        },
      });
      if (result.status !== 'success') throw new Error(result.output);
      return result.output;
    },
    async runAgent() {
      if (definition.type !== 'agent') throw new Error('This node has no Agent action');
      return services.agent.runDetailed(run.input, run.id, {
        instructions,
        appendInput: false,
        toolRefs: (
          definition.config.toolRefs ?? services.registry.list().map((tool) => tool.name)
        ).filter(
          (name) =>
            (services.context.options.generateMemory ||
              !['memory_save', 'memory_update'].includes(name)) &&
            (services.context.options.applyMemory ||
              !['memory_search', 'memory_list'].includes(name)),
        ),
        additionalTools: planTools(ctx.task, ctx.checkpoint),
      });
    },
    async runModel() {
      if (definition.type !== 'model') throw new Error('This node has no single-model action');
      const reply = await executeModelStep(
        ctx,
        [
          { role: 'system', content: `${services.system}\n\n${instructions()}` },
          { role: 'user', content: run.input },
        ],
        [],
        true,
      );
      if (reply.toolCalls.length || !reply.content?.trim())
        throw new Error('Model node requires a final text response');
      message(ctx, {
        role: 'assistant',
        content: reply.content,
        thinkingMs: reply.thinkingMs,
        usage: reply.usage,
        finishReason: reply.finishReason,
      });

      return reply;
    },
  };
}
