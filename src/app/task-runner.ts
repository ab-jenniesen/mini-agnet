import { randomUUID } from 'node:crypto';
import { ModelCompletionError } from '../core/completion.js';
import type { AgentRunResult } from '../core/agent.js';
import type { ToolEvidence } from '../core/types.js';
import { saveSession } from '../infra/memory.js';
import { TaskResultStore } from '../infra/task-results.js';
import type { RuntimeEvent } from './contracts.js';
import type { RuntimeServices } from './services.js';
import { metricsSince, verification, type TaskResult, type TaskSnapshot } from './tasks.js';

/** Owns one task lifecycle. The host still owns sessions, configuration and client transport. */
export class TaskRunner {
  private current?: TaskSnapshot;
  private active?: Promise<TaskResult>;
  private controller?: AbortController;
  private evidence: ToolEvidence[] = [];
  private readonly denied = new Set<string>();

  constructor(
    private readonly services: RuntimeServices,
    private readonly sessionId: () => string,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {}

  get running(): boolean {
    return !!this.active;
  }
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }
  get snapshot(): TaskSnapshot | undefined {
    return structuredClone(this.current);
  }

  private store(): TaskResultStore {
    return new TaskResultStore(this.services.project.path('tasks', `${this.sessionId()}.json`));
  }

  async restore(): Promise<void> {
    const saved = await this.store().load();
    const journal = await this.services.journal.load();
    // A newer interrupted run must not inherit the previous run's successful result.
    this.current =
      saved && (!journal || saved.runId === journal.runId || journal.updatedAt < saved.startedAt)
        ? {
            runId: saved.runId,
            sessionId: saved.sessionId,
            status: saved.status,
            startedAt: saved.startedAt,
            result: saved,
          }
        : undefined;
    if (this.current) this.services.interrupted = this.current.status !== 'completed';
  }

  reset(): void {
    this.current = undefined;
  }

  observe(event: RuntimeEvent): void {
    if (!this.active || event.type !== 'agent' || event.event.type !== 'tool_end') return;
    const tool = event.event;
    this.evidence.push(...(tool.evidence ?? []));
    if (tool.outcome === 'denied') this.denied.add(tool.name);
    if (tool.outcome === 'success') this.denied.delete(tool.name);
  }

  approvalChanged(waiting: boolean): void {
    if (!this.active || !this.current) return;
    this.current.status = waiting ? 'waiting_approval' : 'running';
    this.publish();
  }

  run(input: string): Promise<TaskResult> {
    if (this.active) throw new Error('Agent 正在运行，请稍后重试');
    const task: TaskSnapshot = {
      runId: randomUUID(),
      sessionId: this.sessionId(),
      status: 'running',
      startedAt: new Date().toISOString(),
    };
    this.current = task;
    this.controller = new AbortController();
    this.evidence = [];
    this.denied.clear();
    const before = structuredClone(this.services.agent.metrics);
    const historyStart = this.services.agent.history.length;
    const started = performance.now();
    // Set active before any event can synchronously trigger another client action.
    this.active = Promise.resolve().then(async () => {
      let completion: AgentRunResult | undefined;
      let failure: unknown;
      try {
        completion = await this.services.agent.runDetailed(input, task.runId);
      } catch (error) {
        failure = error;
      }
      const checked = verification(this.evidence);
      let status: TaskResult['status'] = 'completed';
      let error: TaskResult['error'];
      if (this.signal?.aborted) {
        status = 'cancelled';
        error = { code: 'cancelled', message: 'Task cancelled：任务已取消' };
      } else if (failure !== undefined) {
        status =
          failure instanceof ModelCompletionError &&
          ['blocked', 'pause'].includes(failure.finishReason)
            ? 'blocked'
            : 'failed';
        error = {
          code: failure instanceof ModelCompletionError ? failure.code : 'execution_error',
          message: String(failure instanceof Error ? failure.message : failure),
        };
      } else if (this.denied.size) {
        status = 'blocked';
        error = {
          code: 'approval_denied',
          message: `工具未获授权：${[...this.denied].join('、')}`,
        };
      } else if (checked.status === 'failed') {
        status = 'failed';
        error = {
          code: 'verification_failed',
          message: '最后执行的验证检查未通过，任务尚未验收完成',
        };
      }
      const partial = this.services.agent.history
        .slice(historyStart)
        .findLast((message) => message.role === 'assistant');
      const result: TaskResult = {
        runId: task.runId,
        sessionId: task.sessionId,
        status,
        startedAt: task.startedAt,
        finishedAt: new Date().toISOString(),
        summary: completion?.content ?? partial?.content ?? error?.message ?? '',
        finishReason:
          completion?.finishReason ??
          (failure instanceof ModelCompletionError ? failure.finishReason : undefined) ??
          (partial?.role === 'assistant' ? partial.finishReason : undefined),
        rawFinishReason:
          completion?.rawFinishReason ??
          (failure instanceof ModelCompletionError ? failure.rawFinishReason : undefined) ??
          (partial?.role === 'assistant' ? partial.rawFinishReason : undefined),
        changes: [
          ...new Set(
            this.evidence
              .filter((entry) => entry.kind === 'file_change')
              .map((entry) => entry.path),
          ),
        ],
        evidence: structuredClone(this.evidence),
        verification: checked,
        remaining: error ? [error.message] : [],
        metrics: metricsSince(before, this.services.agent.metrics, performance.now() - started),
        error,
      };
      await this.persist(result);
      this.services.interrupted = result.status !== 'completed';
      this.current = { ...task, status: result.status, result };
      this.controller = undefined;
      if (result.status === 'failed' || result.status === 'blocked')
        this.emit({ type: 'run_error', text: result.error?.message ?? result.summary });
      this.active = undefined;
      this.publish();
      return result;
    });
    this.publish();
    return this.active;
  }

  private async persist(result: TaskResult): Promise<void> {
    const failures: string[] = [];
    const recordFailure = (error: unknown): void => {
      failures.push(String(error));
      result.status = 'failed';
      result.error = {
        code: 'persistence_error',
        message: `任务数据保存失败：${failures.join('；')}`,
      };
    };
    // Keep independent stores useful even if the journal or another file cannot be written.
    if (result.status !== 'completed')
      await this.services.journal.finish('interrupted').catch(recordFailure);
    await saveSession(
      this.services.project.session(result.sessionId),
      this.services.agent.history,
    ).catch(recordFailure);
    if (result.error?.code === 'persistence_error') result.remaining.push(result.error.message);
    await this.store()
      .save(result)
      .catch((error) => {
        recordFailure(error);
        result.remaining.push(result.error!.message);
      });
    if (failures.length) await this.services.journal.finish('interrupted').catch(() => {});
  }

  cancel(): void {
    this.controller?.abort(new Error('Task cancelled'));
  }
  async wait(): Promise<void> {
    await this.active;
  }
  private publish(): void {
    if (this.current) this.emit({ type: 'task', task: structuredClone(this.current) });
  }
}
