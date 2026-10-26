import type { Message } from '../model/types.js';
import type { TaskResult } from './result.js';
import type {
  CompletenessReport,
  DeliveryChecklist,
  ExecutionState,
  GoalTask,
  WorkflowRun,
} from './types.js';

/** save resolves only after durable commit and returns the exact committed revision. */
export interface ExecutionStorePort {
  load(): Promise<ExecutionState>;
  save(state: ExecutionState): Promise<ExecutionState>;
}

export interface TaskPersistencePort {
  open(sessionId: string): ExecutionStorePort;
  reset(sessionId: string): Promise<void>;
  loadResult(sessionId: string): Promise<TaskResult | undefined>;
  saveResult(sessionId: string, result: TaskResult): Promise<void>;
  saveHistory(sessionId: string, messages: Message[]): Promise<void>;
}

/** Mandatory kernel acceptance invokes this port, independently of the execution subgraph. */
export interface DeliveryPort {
  normalizePaths(files: string[]): Promise<string[]>;
  check(
    task: GoalTask,
    run: WorkflowRun,
    checklist: DeliveryChecklist,
  ): Promise<CompletenessReport>;
}
