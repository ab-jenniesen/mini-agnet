import type { ExecutionServices } from '../ports.js';
import type { ExecutionState, GoalTask, WorkflowRun } from '../../core/execution/types.js';
import type { RuntimeEvent } from '../../protocol/contracts.js';

export type ExecutionContext = {
  services: ExecutionServices;
  state: ExecutionState;
  task: GoalTask;
  run: WorkflowRun;
  signal: AbortSignal;
  shouldPause: () => boolean;
  checkpoint: () => Promise<void>;
  emit: (event: RuntimeEvent) => void;
};
