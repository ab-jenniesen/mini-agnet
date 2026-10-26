import { validateExecutors } from '../nodes/validate.js';
import { executionResult, executionSnapshot } from '../execution/projection.js';
import { observeExecution, finishOpenRecords } from '../execution/observer.js';
import { randomUUID } from 'node:crypto';
import { ModelCompletionError } from '../../core/model/completion.js';
import type { Message, AgentMetrics } from '../../core/model/types.js';
import { jsonSchema } from '../../core/workflow/definition.js';
import { messageSchema } from '../../core/model/message-schema.js';
import type { ExecutionStorePort } from '../../core/execution/ports.js';
import type { RuntimeEvent } from '../../protocol/contracts.js';
import type { ExecutionServices } from '../ports.js';
import { metricsSince, type TaskResult, type TaskSnapshot } from '../../core/execution/result.js';
import {
  emptyMetrics,
  type ExecutionState,
  type GoalTask,
  type WorkflowRun,
} from '../../core/execution/types.js';
import { ExecutionEngine } from '../execution/engine.js';

/** Owns goals and execution lifecycles. Views consume projections, never update these records. */
export class TaskRunner {
  private current?: TaskSnapshot;
  private active?: Promise<TaskResult>;
  private controller?: AbortController;
  private state?: ExecutionState;
  private committedState?: ExecutionState;
  private repository?: ExecutionStorePort;
  private activeRun?: WorkflowRun;
  private activeMetricsBaseline?: AgentMetrics;
  private activeStarted = 0;
  private pauseRequested = false;
  private readonly denied = new Set<string>();

  constructor(
    private readonly services: ExecutionServices,
    private readonly sessionId: () => string,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}

  get running(): boolean {
    return !!this.active;
  }
  get activeTaskId(): string | undefined {
    return this.activeRun?.taskId;
  }
  get scope() {
    return {
      taskId: this.activeRun?.taskId,
      runId: this.activeRun?.id,
      nodeRunId: this.activeRun?.currentNodeRunId,
    };
  }
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }
  get snapshot(): TaskSnapshot | undefined {
    return structuredClone(this.current);
  }
  get execution(): ExecutionState | undefined {
    return structuredClone(this.committedState);
  }
  get metrics(): AgentMetrics {
    const total = emptyMetrics();
    const add = (metrics: AgentMetrics): void => {
      for (const key of Object.keys(total) as Array<keyof AgentMetrics>) total[key] += metrics[key];
    };
    for (const run of this.state?.runs ?? []) add(run.metrics);
    if (this.activeMetricsBaseline)
      add(
        metricsSince(
          this.activeMetricsBaseline,
          this.services.agent.metrics,
          performance.now() - this.activeStarted,
        ),
      );
    return total;
  }

  private get data(): ExecutionState {
    if (!this.state) throw new Error('Execution store is not initialized');
    return this.state;
  }

  async restore(): Promise<void> {
    this.repository = this.services.persistence.open(this.sessionId());
    this.state = await this.repository.load();
    this.committedState = structuredClone(this.state);
    if (this.state.history.length) {
      const messages = this.state.history.map((value) => messageSchema.parse(value));
      this.services.agent.history.splice(
        1,
        this.services.agent.history.length - 1,
        ...messages.filter((message) => message.role !== 'system'),
      );
      // A process can stop after persisting a call but before persisting its result.
      const completed = new Set(
        this.services.agent.history
          .filter((message) => message.role === 'tool')
          .map((message) => message.tool_call_id),
      );
      for (const message of [...this.services.agent.history]) {
        if (message.role !== 'assistant') continue;
        for (const call of message.tool_calls ?? [])
          if (!completed.has(call.id)) {
            this.services.agent.history.push({
              role: 'tool',
              tool_call_id: call.id,
              content:
                'ERROR: Execution interrupted before a result was recorded. External effects are unknown; inspect before recovery.',
            });
            completed.add(call.id);
          }
      }
    }
    let interrupted = false;
    for (const run of this.state.runs) {
      const durableWait = this.state.waits.some(
        (wait) => wait.runId === run.id && wait.status === 'pending',
      );
      if (
        ['queued', 'running'].includes(run.status) ||
        (run.status === 'waiting' && !durableWait)
      ) {
        interrupted = true;
        run.status = 'interrupted';
        const task = this.state.tasks.find((item) => item.id === run.taskId)!;
        task.status = 'paused';
        task.statusReason = '执行中断；恢复可能重做未提交节点的外部操作，需要明确确认';
        for (const node of this.state.nodes.filter(
          (item) => item.runId === run.id && item.status === 'running',
        )) {
          node.status = 'interrupted';
          if (node.attempts.at(-1)) node.attempts.at(-1)!.status = 'interrupted';
        }
        for (const operation of this.state.operations.filter(
          (item) => item.runId === run.id && item.status === 'running',
        ))
          operation.status = 'interrupted';
      }
    }
    const selected = this.selected();
    const run = this.state.runs.find((item) => item.id === selected?.lastRunId);
    if (run) this.current = executionSnapshot(this.data, run);
    else if (selected) this.current = undefined;
    else {
      const legacy = await this.services.persistence.loadResult(this.sessionId());
      const journal = await this.services.journal.load();
      this.current =
        legacy &&
        (!journal || legacy.runId === journal.runId || journal.updatedAt < legacy.startedAt)
          ? {
              runId: legacy.runId,
              sessionId: legacy.sessionId,
              status: legacy.status,
              startedAt: legacy.startedAt,
              result: legacy,
            }
          : undefined;
    }
    if (run)
      this.services.interrupted = ['failed', 'cancelled', 'interrupted'].includes(run.status);
    if (interrupted) await this.checkpoint();
  }

  reset(): void {
    this.current = undefined;
    this.state = undefined;
    this.committedState = undefined;
  }
  list(): GoalTask[] {
    return structuredClone(this.data.tasks);
  }
  selected(): GoalTask | undefined {
    return this.data.tasks.find((task) => task.id === this.data.selectedTaskId);
  }

  async select(id: string): Promise<GoalTask> {
    if (this.running) throw new Error('运行期间不能切换任务');
    const task = this.data.tasks.find((item) => item.id === id);
    if (!task) throw new Error('任务不存在');
    this.data.selectedTaskId = id;
    const run = this.data.runs.find((item) => item.id === task.lastRunId);
    this.current = run ? executionSnapshot(this.data, run) : undefined;
    await this.checkpoint();
    return structuredClone(task);
  }

  async create(input: string, workflowId?: string): Promise<GoalTask> {
    if (this.running) throw new Error('Agent 正在运行');
    const task = this.newTask(input, workflowId);
    await this.checkpoint();
    return structuredClone(task);
  }

  private newTask(input: string, workflowId?: string): GoalTask {
    const now = new Date().toISOString();
    const task: GoalTask = {
      id: randomUUID(),
      sessionId: this.sessionId(),
      title: input.slice(0, 100),
      goal: input,
      goalRevision: 1,
      goalHistory: [],
      status: 'ready',
      createdAt: now,
      updatedAt: now,
      workflow: validateExecutors(
        this.services.workflows.get(workflowId ?? this.data.selectedWorkflowId),
        this.services.nodeExecutors,
      ),
      runIds: [],
      artifactIds: [],
    };
    this.data.tasks.push(task);
    this.data.selectedTaskId = task.id;
    return task;
  }

  async selectWorkflow(id: string): Promise<void> {
    this.services.workflows.get(id);
    this.data.selectedWorkflowId = id;
    await this.checkpoint();
  }

  run(input: string, taskId?: string, newTask = false): Promise<TaskResult> {
    if (this.active) throw new Error('Agent 正在运行，请稍后重试');
    this.controller = new AbortController();
    this.pauseRequested = false;
    this.denied.clear();
    this.active = Promise.resolve()
      .then(async () => {
        let task = taskId ? this.data.tasks.find((item) => item.id === taskId) : this.selected();
        if (taskId && !task) throw new Error('任务不存在');
        if (
          newTask ||
          !task ||
          (!taskId && ['completed', 'cancelled', 'failed'].includes(task.status))
        )
          task = this.newTask(input);
        this.data.selectedTaskId = task.id;
        const previous = this.data.runs.find((item) => item.id === task!.activeRunId);
        const revisesPausedGoal =
          previous?.status === 'paused' &&
          input.trim() &&
          !/^(继续|重试|continue|retry)$/i.test(input.trim());
        if (revisesPausedGoal && previous) {
          previous.status = 'cancelled';
          previous.phase = 'finalized';
          previous.finishedAt = new Date().toISOString();
          previous.error = {
            code: 'goal_updated',
            message: '目标修订，结束此前暂停的执行',
            retryable: false,
          };
          task.activeRunId = undefined;
        }
        if (previous && ['paused', 'waiting', 'interrupted'].includes(previous.status)) {
          if (previous.status === 'interrupted')
            throw new Error('中断恢复需要明确确认，可能重做节点内的外部操作');
          const request = this.data.waits.find(
            (wait) => wait.runId === previous.id && wait.status === 'pending',
          );
          if (request?.kind === 'plan_approval') throw new Error('请先确认或拒绝待处理的计划');
          if (request) this.resolveWait(request.id, input);
          return this.advance(task, previous);
        }
        if (
          input.trim() &&
          task.runIds.length &&
          input !== task.goal &&
          !/^(继续|重试|continue|retry)$/i.test(input.trim())
        ) {
          task.goalHistory.push({ revision: task.goalRevision, text: task.goal });
          task.goal += `\n\n后续要求：${input}`;
          task.goalRevision++;
          task.checklist = undefined;
          task.plan = undefined;
        }
        const now = new Date().toISOString();
        const run: WorkflowRun = {
          id: randomUUID(),
          taskId: task.id,
          sessionId: task.sessionId,
          status: 'running',
          phase: 'preparing',
          createdAt: now,
          updatedAt: now,
          startedAt: now,
          input: input || task.goal,
          goalRevision: task.goalRevision,
          workflow: structuredClone(task.workflow),
          state: { revision: 0, data: {} },
          cursor: task.workflow.entry,
          nodeRunIds: [],
          reportIds: [],
          feedback: [],
          summary: '',
          metrics: emptyMetrics(),
          evidence: [],
          config: {
            provider: this.services.selection.provider,
            model: this.services.selection.model,
            contextWindow: this.services.capability.contextWindow,
            outputReserve: this.services.capability.outputReserve,
            permissionMode: this.services.permissions.getMode(),
          },
        };
        this.data.runs.push(run);
        task.runIds.push(run.id);
        task.activeRunId = run.id;
        task.lastRunId = run.id;
        task.finishedAt = undefined;
        if (task.plan?.status === 'completed') {
          task.plan.status = 'active';
          for (const step of task.plan.steps) step.status = 'pending';
        }
        this.message({ role: 'user', content: run.input });
        return this.advance(task, run);
      })
      .finally(() => {
        this.active = undefined;
        this.controller = undefined;
        this.activeRun = undefined;
        this.publish();
      });
    return this.active;
  }

  resume(runId: string, confirmReplay = false): Promise<TaskResult> {
    if (this.active) throw new Error('Agent 正在运行');
    const run = this.data.runs.find((item) => item.id === runId);
    if (!run || !['paused', 'waiting', 'interrupted'].includes(run.status))
      throw new Error('该执行不能恢复');
    if (run.status === 'interrupted' && !confirmReplay)
      throw new Error('恢复中断节点可能重复外部操作，需要 confirmReplay=true');
    if (this.data.waits.some((wait) => wait.runId === run.id && wait.status === 'pending'))
      throw new Error('请先回复等待请求');
    const task = this.data.tasks.find((item) => item.id === run.taskId)!;
    if (task.activeRunId !== run.id) throw new Error('该执行已不再是任务的活动执行');
    this.data.selectedTaskId = task.id;
    this.controller = new AbortController();
    this.pauseRequested = false;
    this.denied.clear();
    this.active = Promise.resolve()
      .then(() =>
        this.advance(
          this.data.tasks.find((task) => task.id === run.taskId)!,
          run,
        ),
      )
      .finally(() => {
        this.active = undefined;
        this.controller = undefined;
        this.activeRun = undefined;
        this.publish();
      });
    return this.active;
  }

  async respond(id: string, response: unknown): Promise<void> {
    if (this.running) throw new Error('请等待当前调用结束');
    const history = structuredClone(this.services.agent.history);
    try {
      this.resolveWait(id, response);
      await this.checkpoint();
    } catch (error) {
      this.services.agent.history.splice(0, this.services.agent.history.length, ...history);
      throw error;
    }
  }

  private resolveWait(id: string, response: unknown): void {
    const request = this.data.waits.find((wait) => wait.id === id && wait.status === 'pending');
    if (!request) throw new Error('等待请求不存在或已结束');
    const value = jsonSchema.parse(response);
    const task = this.data.tasks.find((item) => item.id === request.taskId)!;
    if (request.kind === 'plan_approval') {
      if (typeof value !== 'boolean') throw new Error('计划审批需要 boolean 回复');
      task.plan!.approval = value ? 'approved' : 'rejected';
      task.plan!.status = value ? 'active' : 'draft';
    }
    request.response = value;
    request.status = 'resolved';
    request.resolvedAt = new Date().toISOString();
    if (request.kind === 'user_input' && typeof value === 'string' && value.trim())
      this.services.agent.history.push({ role: 'user', content: value });
  }

  async cancelTask(id: string): Promise<void> {
    if (this.running && this.activeRun?.taskId !== id)
      throw new Error('请等待当前执行结束后修改其他任务');
    const task = this.data.tasks.find((item) => item.id === id);
    if (!task) throw new Error('任务不存在');
    if (task.status === 'completed') throw new Error('目标已经完成；可以继续目标或创建新目标');
    if (task.status === 'cancelled') return;
    const runId = task.activeRunId;
    if (this.activeRun?.taskId === id) {
      this.cancel();
      await this.wait();
    }
    task.status = 'cancelled';
    task.finishedAt = new Date().toISOString();
    const run = this.data.runs.find((item) => item.id === runId);
    if (run) {
      run.status = 'cancelled';
      run.finishedAt = task.finishedAt;
      run.phase = 'finalized';
      run.currentNodeRunId = undefined;
      finishOpenRecords(this.data, run);
    }
    task.activeRunId = undefined;
    for (const request of this.data.waits.filter(
      (item) => item.taskId === id && item.status === 'pending',
    ))
      request.status = 'cancelled';
    await this.checkpoint();
  }

  private async advance(task: GoalTask, run: WorkflowRun): Promise<TaskResult> {
    this.activeRun = run;
    this.denied.clear();
    for (const operation of this.data.operations.filter(
      (item) => item.runId === run.id && item.kind === 'tool',
    )) {
      if (operation.status === 'denied') this.denied.add(operation.name);
      if (operation.status === 'completed') this.denied.delete(operation.name);
    }
    run.status = 'running';
    run.error = undefined;
    task.status = 'active';
    task.activeRunId = run.id;
    task.statusReason = undefined;
    const historyStart = this.services.agent.history.length;
    const before = structuredClone(this.services.agent.metrics);
    const started = performance.now();
    this.activeMetricsBaseline = before;
    this.activeStarted = started;
    const previousMetrics = structuredClone(run.metrics);
    this.data.operations.push({
      id: randomUUID(),
      taskId: task.id,
      runId: run.id,
      kind: 'context',
      name: 'runtime_configuration',
      status: 'completed',
      createdAt: new Date().toISOString(),
      details: {
        provider: this.services.selection.provider,
        model: this.services.selection.model,
        contextWindow: this.services.capability.contextWindow,
        outputReserve: this.services.capability.outputReserve,
        permissionMode: this.services.permissions.getMode(),
        contextPolicy: jsonSchema.parse(this.services.context.options),
        confirmPlan: this.services.confirmPlan,
      },
    });
    let completionError: ModelCompletionError | undefined;
    try {
      await this.checkpoint();
      await new ExecutionEngine({
        services: this.services,
        state: this.data,
        task,
        run,
        signal: this.controller!.signal,
        shouldPause: () => this.pauseRequested,
        checkpoint: () => this.checkpoint(),
        emit: (event) => {
          this.observe(event);
          this.emit(event);
        },
      }).advance();
      this.signal?.throwIfAborted();
      if (this.denied.size && ['completed'].includes(run.status))
        throw new Error(`工具未获授权：${[...this.denied].join('、')}`);
    } catch (error) {
      if (error instanceof ModelCompletionError) completionError = error;
      run.status = this.signal?.aborted ? 'cancelled' : 'failed';
      run.phase = 'finalized';
      run.error = {
        code: this.signal?.aborted
          ? 'cancelled'
          : (completionError?.code ??
            (this.denied.size
              ? 'approval_denied'
              : ['EACCES', 'EISDIR', 'ENOSPC', 'EROFS', 'EPERM'].includes(
                    String((error as { code?: unknown })?.code),
                  )
                ? 'persistence_error'
                : 'execution_error')),
        message: String(error instanceof Error ? error.message : error),
        retryable: false,
      };
      const partial = this.services.agent.history
        .slice(historyStart)
        .findLast(
          (message) =>
            message.role === 'assistant' && !message.tool_calls?.length && message.content,
        );
      if (partial?.role === 'assistant') {
        run.summary = partial.content ?? run.summary;
        run.finishReason = partial.finishReason;
        run.rawFinishReason = partial.rawFinishReason;
      }
      if (completionError) {
        run.finishReason = completionError.finishReason;
        run.rawFinishReason = completionError.rawFinishReason;
      }
      task.status = 'ready';
      task.statusReason = run.error.message;
      task.finishedAt = undefined;
    }
    const delta = metricsSince(before, this.services.agent.metrics, performance.now() - started);
    this.activeMetricsBaseline = undefined;
    for (const key of Object.keys(delta) as Array<keyof typeof delta>)
      run.metrics[key] = previousMetrics[key] + delta[key];
    if (['completed', 'failed', 'cancelled'].includes(run.status)) {
      run.finishedAt = new Date().toISOString();
      task.activeRunId = undefined;
      run.currentNodeRunId = undefined;
    }
    task.summary = run.summary;
    finishOpenRecords(this.data, run);
    const result = executionResult(this.data, run, completionError);
    let saved = false;
    try {
      await this.checkpoint();
      saved = true;
    } catch (error) {
      result.status = 'failed';
      result.error = { code: 'persistence_error', message: `任务保存失败：${String(error)}` };
      result.remaining.push(result.error.message);
      run.status = 'failed';
      run.phase = 'finalized';
      run.finishedAt = new Date().toISOString();
      result.finishedAt = run.finishedAt;
      run.error = { ...result.error, retryable: false };
      task.status = 'ready';
      task.finishedAt = undefined;
      task.activeRunId = undefined;
      finishOpenRecords(this.data, run);
      await this.checkpoint().catch(() => {});
    }
    if (saved) {
      const caches = await Promise.allSettled([
        this.services.persistence.saveHistory(this.sessionId(), this.services.agent.history),
        this.services.persistence.saveResult(this.sessionId(), result),
      ]);
      const errors = caches
        .filter((item) => item.status === 'rejected')
        .map((item) => String(item.reason));
      if (errors.length)
        this.emit({
          type: 'notice',
          level: 'error',
          text: `执行清单已保存，兼容缓存更新失败：${errors.join('；')}`,
        });
    }
    this.services.interrupted = !['completed', 'waiting', 'paused'].includes(run.status);
    this.current = {
      runId: run.id,
      taskId: task.id,
      sessionId: run.sessionId,
      status: result.status,
      phase: run.phase,
      startedAt: run.startedAt,
      result,
    };
    if (result.error) this.emit({ type: 'run_error', text: result.error.message });
    return structuredClone(result);
  }

  observe(event: RuntimeEvent): void {
    if (this.state && this.activeRun)
      observeExecution(
        this.state,
        this.activeRun,
        event,
        this.services.selection.model,
        this.denied,
      );
  }

  approvalChanged(waiting: boolean): void {
    if (!this.activeRun) return;
    this.activeRun.status = waiting ? 'waiting' : 'running';
    const task = this.data.tasks.find((item) => item.id === this.activeRun!.taskId)!;
    task.status = waiting ? 'waiting' : 'active';
    this.current = {
      ...executionSnapshot(this.data, this.activeRun),
      status: waiting ? 'waiting_approval' : 'running',
    };
    this.publish();
  }

  pause(): void {
    this.pauseRequested = true;
  }
  cancel(): void {
    this.controller?.abort(new Error('Task cancelled'));
  }
  async wait(): Promise<void> {
    await this.active;
  }

  private message(message: Message): void {
    this.services.agent.history.push(message);
    this.emit({ type: 'message', message });
  }

  private async checkpoint(): Promise<void> {
    const now = new Date().toISOString();
    if (this.activeRun) {
      this.activeRun.updatedAt = now;
      const task = this.data.tasks.find((item) => item.id === this.activeRun!.taskId)!;
      task.updatedAt = now;
      this.activeRun.planSnapshot = structuredClone(task.plan);
    }
    const history = messageSchema
      .array()
      .parse(this.services.agent.history.filter((message) => message.role !== 'system'));
    // Optional message properties may be undefined in memory; JSON persistence omits them.
    this.data.history = jsonSchema.array().parse(JSON.parse(JSON.stringify(history)));
    let committed: ExecutionState;
    try {
      committed = await this.repository!.save(this.data);
    } catch (error) {
      // Idle commands can roll back cleanly. Active execution retains observed external evidence.
      if (!this.activeRun && this.committedState) {
        this.state = structuredClone(this.committedState);
        const task = this.selected();
        const run = this.data.runs.find((item) => item.id === task?.lastRunId);
        if (task) this.current = run ? executionSnapshot(this.data, run) : undefined;
      }
      throw error;
    }
    this.committedState = committed;
    const selected = committed.tasks.find((task) => task.id === committed.selectedTaskId);
    const run = committed.runs.find(
      (item) => item.id === (this.activeRun?.id ?? selected?.lastRunId),
    );
    if (run || selected) this.current = run ? executionSnapshot(committed, run) : undefined;
    this.emit({
      type: 'execution',
      protocolVersion: 2,
      generationId: committed.generationId,
      eventId: randomUUID(),
      sequence: committed.revision,
      sessionId: this.sessionId(),
      taskId: this.activeRun?.taskId,
      runId: this.activeRun?.id,
      nodeRunId: this.activeRun?.currentNodeRunId,
      state: structuredClone(committed),
    });
    this.publish();
  }

  private publish(): void {
    // Terminal task subscribers may start another Run. Publish after the active lock is released.
    if (
      this.current &&
      (!this.active || ['running', 'waiting_approval'].includes(this.current.status))
    )
      this.emit({ type: 'task', task: structuredClone(this.current) });
  }
}
