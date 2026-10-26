import { validateCompletenessReport } from '../../core/execution/acceptance.js';
import type { ExecutionContext } from './context.js';
import { executeModelStep } from './model-step.js';
import { nodeActions } from './node-actions.js';
import { jsonSchema } from '../../core/workflow/definition.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolCall } from '../../core/model/types.js';
import {
  applyOutputs,
  bindInputs,
  nextNode,
  type Data,
  type WorkflowNode,
} from '../../core/workflow/definition.js';
import {
  checklistInputSchema,
  emptyMetrics,
  type NodeRun,
  type WaitRequest,
  type ExecutionOperation,
} from '../../core/execution/types.js';
import { metricsSince } from '../../core/execution/result.js';

const dataSchema = z.record(jsonSchema);

/** Advances the fixed outer lifecycle. Client transports and layout remain outside the engine. */
export class ExecutionEngine {
  constructor(private readonly ctx: ExecutionContext) {}

  private view(output: Data = {}): Data {
    const { task, run } = this.ctx;
    return {
      task: {
        id: task.id,
        goal: task.goal,
        deliverables: task.checklist?.files.map((item) => item.path) ?? [],
        plan:
          task.plan?.steps.map((step) => ({ id: step.id, text: step.text, status: step.status })) ??
          [],
      },
      state: run.state.data,
      input: run.input,
      feedback: run.feedback,
      output,
    };
  }

  private async boundary(): Promise<boolean> {
    const { signal, run, task } = this.ctx;
    signal.throwIfAborted();
    if (!this.ctx.shouldPause()) return false;
    run.status = 'paused';
    task.status = 'paused';
    await this.ctx.checkpoint();
    return true;
  }

  private async wait(kind: WaitRequest['kind'], prompt: string, nodeRunId?: string): Promise<void> {
    const { run, task, state } = this.ctx;
    state.waits.push({
      id: randomUUID(),
      taskId: task.id,
      runId: run.id,
      nodeRunId,
      kind,
      status: 'pending',
      prompt,
      createdAt: new Date().toISOString(),
    });
    run.status = 'waiting';
    task.status = 'waiting';
    await this.ctx.checkpoint();
  }

  async advance(): Promise<void> {
    const { run } = this.ctx;
    if (await this.boundary()) return;
    if (run.phase === 'preparing' && !(await this.prepare())) return;
    while (run.phase !== 'finalized') {
      if (await this.boundary()) return;
      if (run.phase === 'executing') {
        if (!(await this.executeNodes())) return;
        run.phase = 'verifying';
        await this.ctx.checkpoint();
        if (await this.boundary()) return;
      }
      if (run.phase === 'verifying' && !(await this.verify())) return;
      if (run.phase === 'finalizing') {
        this.ctx.signal.throwIfAborted();
        run.phase = 'finalized';
        run.status = 'completed';
        this.ctx.task.status = 'completed';
        this.ctx.task.finishedAt = new Date().toISOString();
        if (this.ctx.task.plan) this.ctx.task.plan.status = 'completed';
      }
    }
  }

  private async prepare(): Promise<boolean> {
    const { task, run } = this.ctx;
    if (!task.checklist) {
      const tools: Tool[] = [
        {
          name: 'submit_delivery_checklist',
          description:
            'Submit the fixed delivery contract before execution. Use files for requested file deliverables and response for a pure answer.',
          parameters: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['files', 'response'] },
              files: { type: 'array', items: { type: 'string' } },
              plan: { type: 'array', items: { type: 'string' } },
            },
            required: ['mode', 'files', 'plan'],
            additionalProperties: false,
          },
          execute: async () => {
            throw new Error('Kernel-only submission');
          },
        },
      ];
      const reply = await executeModelStep(
        this.ctx,
        [
          {
            role: 'system',
            content:
              'Prepare the delivery contract only. You MUST call submit_delivery_checklist exactly once. Do not execute the task. List every file explicitly requested by the user, using paths relative to the primary workspace. For a pure answer with no file delivery use response and files=[]. Include a short action plan. The checklist is fixed during execution; its checks only establish file presence.',
          },
          { role: 'user', content: task.goal },
        ],
        tools,
        false,
      );
      if (reply.toolCalls.length !== 1 || reply.toolCalls[0].name !== tools[0].name)
        throw new Error('模型未通过 submit_delivery_checklist 提交交付清单，请重试');
      await this.acceptChecklist(reply.toolCalls[0]);
      await this.ctx.checkpoint();
    }
    if (!task.checklist) throw new Error('Delivery checklist was not saved');
    run.checklistVersion = task.checklist.version;
    run.checklist = structuredClone(task.checklist);
    run.planSnapshot = structuredClone(task.plan);
    if (task.plan?.approval === 'pending') {
      const existing = this.ctx.state.waits.find(
        (wait) =>
          wait.runId === run.id && wait.kind === 'plan_approval' && wait.status === 'pending',
      );
      if (!existing)
        await this.wait(
          'plan_approval',
          `执行前确认计划：\n${task.plan.steps.map((step, index) => `${index + 1}. ${step.text}`).join('\n')}\n请确认或拒绝此计划。`,
        );
      return false;
    }
    if (task.plan?.approval === 'rejected') throw new Error('计划未获确认，请修改目标后重新执行');
    run.phase = 'executing';
    await this.ctx.checkpoint();
    return true;
  }

  private async acceptChecklist(call: ToolCall): Promise<void> {
    const { task, run, services, state } = this.ctx;
    const operation: ExecutionOperation = {
      id: randomUUID(),
      taskId: task.id,
      runId: run.id,
      kind: 'tool',
      name: 'submit_delivery_checklist',
      status: 'running',
      createdAt: new Date().toISOString(),
    };
    state.operations.push(operation);
    services.agent.metrics.toolCalls++;
    const started = performance.now();
    try {
      const proposal = checklistInputSchema.parse(JSON.parse(call.arguments));
      const files = await services.deliveries.normalizePaths(proposal.files);
      task.checklist = {
        id: randomUUID(),
        taskId: task.id,
        version: task.goalRevision,
        goalRevision: task.goalRevision,
        mode: proposal.mode,
        files: files.map((path) => ({ id: randomUUID(), path })),
        createdAt: new Date().toISOString(),
      };
      task.plan = {
        version: task.goalRevision,
        status: services.confirmPlan ? 'draft' : 'active',
        approval: services.confirmPlan ? 'pending' : 'not_required',
        steps: proposal.plan.map((text) => ({ id: randomUUID(), text, status: 'pending' })),
      };
      operation.status = 'completed';
      operation.details = { mode: proposal.mode, files };
    } catch (error) {
      operation.status = 'failed';
      throw error;
    } finally {
      operation.durationMs = performance.now() - started;
      operation.finishedAt = new Date().toISOString();
      services.agent.metrics.toolMs += operation.durationMs;
    }
  }

  private async executeNodes(): Promise<boolean> {
    const { run, task, state, services } = this.ctx;
    while (run.cursor !== '$end') {
      if (await this.boundary()) return false;
      const definition = run.workflow.nodes.find((item) => item.id === run.cursor);
      if (!definition) throw new Error(`Unknown active node: ${run.cursor}`);
      let node = state.nodes.find((item) => item.id === run.currentNodeRunId);
      if (!node) {
        node = {
          id: randomUUID(),
          runId: run.id,
          taskId: task.id,
          sessionId: task.sessionId,
          nodeId: definition.id,
          status: 'pending',
          createdAt: new Date().toISOString(),
          inputStateRevision: run.state.revision,
          inputs: bindInputs(definition, this.view()),
          attempts: [],
          metrics: emptyMetrics(),
        };
        state.nodes.push(node);
        run.nodeRunIds.push(node.id);
        run.currentNodeRunId = node.id;
      }
      if (definition.type === 'human') {
        const request = state.waits.findLast((wait) => wait.nodeRunId === node!.id);
        if (!request) {
          node.status = 'waiting';
          await this.wait('user_input', definition.config.prompt!, node.id);
          return false;
        }
        if (request.status !== 'resolved') return false;
        await this.commit(node, definition, {
          value: request.response ?? null,
          text:
            typeof request.response === 'string'
              ? request.response
              : JSON.stringify(request.response ?? null),
        });
        continue;
      }
      node.status = 'running';
      node.error = undefined;
      node.attempts.push({
        id: randomUUID(),
        number: node.attempts.length + 1,
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      await this.ctx.checkpoint();
      const before = structuredClone(services.agent.metrics);
      const historyStart = services.agent.history.length;
      const started = performance.now();
      try {
        const executor = services.nodeExecutors.get(definition.config.executor ?? definition.type);
        const result = await executor(nodeActions(this.ctx, definition, node));
        const outputs = dataSchema.parse(result.outputs);
        if (result.completion) {
          run.finishReason = result.completion.finishReason;
          run.rawFinishReason = result.completion.rawFinishReason;
        }
        this.ctx.signal.throwIfAborted();
        // A local executor can produce a reply without a model request. Publish it once.
        if (
          ['agent', 'model'].includes(definition.type) &&
          typeof outputs.text === 'string' &&
          outputs.text.trim() &&
          !services.agent.history
            .slice(historyStart)
            .some((message) => message.role === 'assistant' && !message.tool_calls?.length)
        ) {
          const message = { role: 'assistant' as const, content: outputs.text };
          services.agent.history.push(message);
          this.ctx.emit({ type: 'message', message });
        }
        node.metrics = metricsSince(before, services.agent.metrics, performance.now() - started);
        node.attempts.at(-1)!.status = 'completed';
        node.attempts.at(-1)!.finishedAt = new Date().toISOString();
        await this.commit(node, definition, outputs);
      } catch (error) {
        node.status = this.ctx.signal.aborted ? 'cancelled' : 'failed';
        node.error = { code: 'node_execution_error', message: String(error), retryable: false };
        node.metrics = metricsSince(before, services.agent.metrics, performance.now() - started);
        node.finishedAt = new Date().toISOString();
        node.attempts.at(-1)!.status = node.status;
        node.attempts.at(-1)!.finishedAt = node.finishedAt;
        node.attempts.at(-1)!.error = node.error;
        throw error;
      }
    }
    return true;
  }

  private async commit(node: NodeRun, definition: WorkflowNode, outputs: Data): Promise<void> {
    const { run } = this.ctx;
    const next = applyOutputs(run.state.data, definition, outputs);
    const destination = nextNode(run.workflow, node.nodeId, { ...this.view(outputs), state: next });
    run.state = { revision: run.state.revision + 1, data: next };
    run.cursor = destination;
    node.outputs = outputs;
    node.committedStateRevision = run.state.revision;
    node.status = 'completed';
    node.finishedAt = new Date().toISOString();
    run.currentNodeRunId = undefined;
    if (typeof outputs.text === 'string') run.summary = outputs.text;
    await this.ctx.checkpoint();
  }

  private async verify(): Promise<boolean> {
    const { services, task, run, state } = this.ctx;
    if (
      !task.checklist ||
      task.checklist.version !== run.checklistVersion ||
      task.goalRevision !== run.goalRevision
    )
      throw new Error('Task goal or delivery checklist changed during execution');
    const report = validateCompletenessReport(
      await services.deliveries.check(
        structuredClone(task),
        structuredClone(run),
        structuredClone(task.checklist),
      ),
      { taskId: task.id, runId: run.id, goalRevision: run.goalRevision },
      task.checklist,
    );
    this.ctx.signal.throwIfAborted();
    state.reports.push(report);
    run.reportIds.push(report.id);
    for (const item of report.items.filter((item) => item.status === 'present')) {
      const artifact = {
        id: randomUUID(),
        taskId: task.id,
        runId: run.id,
        path: item.path,
        byteLength: item.byteLength!,
        createdAt: report.checkedAt,
      };
      state.artifacts.push(artifact);
      task.artifactIds.push(artifact.id);
    }
    if (report.status === 'error') {
      await this.wait(
        'user_input',
        `完整性检查异常，请处理后继续：\n${report.items
          .filter((item) => item.status === 'error')
          .map((item) => `${item.path}: ${item.error}`)
          .join('\n')}`,
      );
      return false;
    }
    if (report.status === 'incomplete') {
      run.feedback = report.items
        .filter((item) => item.status === 'missing')
        .map((item) => item.path);
      run.cursor = run.workflow.entry;
      run.phase = 'executing';
      await this.ctx.checkpoint();
      return true;
    }
    if (report.status === 'not_applicable' && !run.summary.trim())
      throw new Error('Response task has no answer');
    run.feedback = [];
    run.phase = 'finalizing';
    await this.ctx.checkpoint();
    return true;
  }
}
