import type { AgentLoopPort } from '../core/ports.js';
import type { Selection } from '../core/model/catalog.js';
import type { ContextCapability } from '../core/context/types.js';
import type { ContextPolicyPort } from '../core/context/ports.js';
import type { PermissionPort } from '../core/permissions/ports.js';
import type { ToolRegistryPort } from '../core/tools/ports.js';
import type { WorkflowCatalogPort } from '../core/workflow/ports.js';
import type { DeliveryPort, TaskPersistencePort } from '../core/execution/ports.js';
import type { NodeExecutorCatalog } from './nodes/types.js';

export type AgentExecutionPort = Pick<
  AgentLoopPort,
  'history' | 'metrics' | 'getModel' | 'runDetailed'
>;

/** Only execution capabilities are visible here. No paths, terminals or host factories. */
export interface ExecutionServices {
  agent: AgentExecutionPort;
  registry: ToolRegistryPort;
  context: ContextPolicyPort;
  permissions: Pick<PermissionPort, 'getMode'>;
  workflows: WorkflowCatalogPort;
  persistence: TaskPersistencePort;
  deliveries: DeliveryPort;
  nodeExecutors: NodeExecutorCatalog;
  journal: {
    load(): Promise<{ runId: string; updatedAt: string } | undefined>;
  };
  selection: Selection;
  capability: ContextCapability;
  system: string;
  confirmPlan: boolean;
  interrupted: boolean;
}
