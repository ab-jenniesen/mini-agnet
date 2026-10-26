import type { Message, Model } from '../core/model/types.js';
import type { AgentOptions } from '../core/agent.js';
import type { AgentLoopPort } from '../core/ports.js';
import type { Selection } from '../core/model/catalog.js';
import type { ContextCapability, ContextOptions, CompactionPort } from '../core/context/types.js';
import type { ContextPolicyPort } from '../core/context/ports.js';
import type { MemoryPort } from '../core/memory/ports.js';
import type {
  PermissionPort,
  PermissionAuditPort,
  ApprovalPresenter,
} from '../core/permissions/ports.js';
import type { DeliveryPort, TaskPersistencePort } from '../core/execution/ports.js';
import type { WorkflowCatalogPort } from '../core/workflow/ports.js';
import type { RegisteredTool, ToolRegistryPort } from '../core/tools/ports.js';
import type { NodeExecutor } from '../app/nodes/types.js';
import type { ProjectState } from '../infra/workspace/project-state.js';
import type { Workspace } from '../infra/workspace/files.js';
import type { RuntimeEvent } from '../protocol/contracts.js';

type Awaitable<T> = T | Promise<T>;
export type BuiltinToolset =
  | 'workspace'
  | 'files'
  | 'command'
  | 'memory'
  | 'todos'
  | 'history'
  | 'artifacts'
  | 'mcp'
  | 'configured';

export type ContextFactoryInput = {
  sessionId: string;
  options: ContextOptions;
  memory: MemoryPort;
  compactions: CompactionPort;
};

/** Trusted host modules are installed once and disposed when startup fails or the host closes. */
export interface RuntimeModule {
  id: string;
  setup(context: {
    workspaceRoot: string;
    registerTool(tool: RegisteredTool): void;
    signal(): AbortSignal | undefined;
  }): Awaitable<void | (() => Awaitable<void>)>;
}

/** Startup injection points; factories also serve later session switches and reconfiguration. */
export type RuntimeDependencies = {
  tools?: RegisteredTool[];
  toolsets?: Partial<Record<BuiltinToolset, boolean>>;
  modules?: RuntimeModule[];
  observers?: Array<(event: RuntimeEvent) => void>;
  nodeExecutors?: Record<string, NodeExecutor>;
  createModel?: (selection: Selection, key?: string) => Model;
  resolveCapability?: (selection: Selection, key?: string) => Promise<ContextCapability>;
  createAgent?: (input: {
    model: Model;
    tools: ToolRegistryPort;
    system: string;
    options: AgentOptions;
    history: Message[];
  }) => AgentLoopPort;
  createSystemPrompt?: (input: {
    workspaceRoot: string;
    defaultPrompt: string;
  }) => Awaitable<string>;
  createContext?: (input: ContextFactoryInput) => ContextPolicyPort;
  createPermissions?: (input: {
    audit: PermissionAuditPort;
    present: ApprovalPresenter;
  }) => PermissionPort;
  createMemory?: (input: { projectFile: string; globalFile: string }) => Awaitable<MemoryPort>;
  createWorkflows?: (input: { file: string }) => Awaitable<WorkflowCatalogPort>;
  createPersistence?: (input: { project: ProjectState }) => Awaitable<TaskPersistencePort>;
  createDelivery?: (input: { workspace: Workspace }) => DeliveryPort;
};
