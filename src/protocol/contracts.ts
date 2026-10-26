import type { AgentEvent } from '../core/events.js';
import type { AgentMetrics, Message } from '../core/model/types.js';
import type {
  ApprovalRequest,
  PermissionEvent,
  PermissionMode,
} from '../core/permissions/manager.js';
import type { ContextCapability } from '../core/context/types.js';
import type { Provider, Selection } from '../core/model/catalog.js';
import type { ModelCatalog } from '../core/model/catalog.js';
import type { CredentialStatus } from '../core/model/catalog.js';
import type { ScopedMemoryEntry } from '../core/memory/types.js';
import type { Todo } from '../core/execution/todo.js';
import type { TaskResult, TaskSnapshot } from '../core/execution/result.js';
import type { ExecutionState, GoalTask, WorkflowRun } from '../core/execution/types.js';
import type { Json, WorkflowDefinition } from '../core/workflow/definition.js';
import type { ContextSettings } from '../core/context/settings.js';

export type ApprovalView = { request: ApprovalRequest; preview: string };
export type SessionView = {
  id: string;
  history: Message[];
  interrupted: boolean;
  created: boolean;
};
export type ProviderView = Provider & { credentialStatus: CredentialStatus };
export type ArtifactView = { id: string; name: string };
export type ArtifactPage = {
  id: string;
  offset: number;
  total: number;
  next: number;
  content: string;
};

export type RuntimeSnapshot = SessionView & {
  protocolVersion?: 2;
  execution?: ExecutionState;
  selection: Selection;
  capability: ContextCapability;
  credentialStatus: CredentialStatus;
  workspaceRoot: string;
  extraWritable: number;
  permissionMode: PermissionMode;
  todos: Todo[];
  metrics: AgentMetrics;
  running: boolean;
  pendingApprovals: ApprovalView[];
  task?: TaskSnapshot;
};

/** JSON data only: suitable for direct calls, HTTP/SSE, Electron IPC or a WebSocket. */
type RuntimeEventPayload =
  | {
      type: 'execution';
      protocolVersion: 2;
      generationId: string;
      eventId: string;
      sequence: number;
      sessionId: string;
      taskId?: string;
      runId?: string;
      nodeRunId?: string;
      state: ExecutionState;
    }
  | { type: 'task'; task: TaskSnapshot }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'permission'; event: PermissionEvent }
  | { type: 'state'; state: RuntimeSnapshot }
  | { type: 'message'; message: Message }
  | { type: 'approval_requested'; approval: ApprovalView }
  | { type: 'approval_resolved'; id: string; accepted: boolean }
  | { type: 'notice'; level: 'info' | 'error'; text: string }
  | { type: 'run_error'; text: string };

export type RuntimeEvent = RuntimeEventPayload & {
  scope?: { sessionId: string; taskId?: string; runId?: string; nodeRunId?: string };
};

type Action<Input, Output> = { input: Input; output: Output };
export type Actions = {
  run: Action<{ input: string }, string>;
  'tasks.run': Action<{ input: string }, TaskResult>;
  'tasks.current': Action<{}, TaskSnapshot | undefined>;
  'tasks.list': Action<{}, GoalTask[]>;
  'tasks.create': Action<{ input: string; workflowId?: string }, GoalTask>;
  'tasks.select': Action<{ id: string }, GoalTask>;
  'tasks.continue': Action<{ id: string; input?: string }, TaskResult>;
  'tasks.cancel': Action<{ id: string }, void>;
  'runs.get': Action<{ id: string }, WorkflowRun>;
  'runs.pause': Action<{}, void>;
  'runs.resume': Action<{ id: string; confirmReplay?: boolean }, TaskResult>;
  'waits.respond': Action<{ id: string; response: Json }, void>;
  'execution.get': Action<{}, ExecutionState>;
  'workflows.list': Action<{}, WorkflowDefinition[]>;
  'workflows.register': Action<{ definition: WorkflowDefinition }, WorkflowDefinition>;
  'workflows.select': Action<{ id: string }, void>;
  'context.get': Action<{}, ContextSettings>;
  'context.configure': Action<{ settings: ContextSettings }, ContextSettings>;
  'runtime.capabilities': Action<
    {},
    {
      protocolVersion: 2;
      nodeTypes: string[];
      nodeExecutors?: string[];
      execution: 'sequential';
      checkpoints: 'node_boundaries';
      isolation: 'application';
      eventReplay: false;
    }
  >;
  'tools.describe': Action<
    {},
    Array<{
      name: string;
      description: string;
      parameters: import('../core/model/types.js').JsonSchema;
      write: boolean;
    }>
  >;
  cancel: Action<{}, void>;
  'sessions.list': Action<{}, string[]>;
  'sessions.switch': Action<{ id: string }, SessionView>;
  'sessions.delete': Action<{ id: string }, SessionView | undefined>;
  'sessions.reset': Action<{}, void>;
  'models.providers': Action<{}, ProviderView[]>;
  'models.discover': Action<{ provider: string }, ModelCatalog>;
  'models.select': Action<{ provider: string; model: string }, ContextCapability>;
  'credentials.set': Action<{ provider: string; key: string; persist: boolean }, void>;
  'permissions.set': Action<{ mode: PermissionMode }, void>;
  'workspace.status': Action<{}, { root: string; writable: string[] }>;
  'workspace.grant': Action<{ path: string }, { accepted: boolean; path?: string }>;
  'tools.list': Action<{}, string[]>;
  'memories.list': Action<{ scope?: 'project' | 'global' }, ScopedMemoryEntry[]>;
  'artifacts.list': Action<{}, ArtifactView[]>;
  'artifacts.read': Action<{ id: string; offset?: number; limit?: number }, ArtifactPage>;
  'approvals.respond': Action<{ id: string; accepted: boolean }, void>;
};

export type Command = { [K in keyof Actions]: { type: K } & Actions[K]['input'] }[keyof Actions];
export type CommandResult<C extends Command> = Actions[C['type']]['output'];

/** Clients render events and dispatch intentions. Agent construction belongs to the host. */
export interface AgentClient {
  initialize(): Promise<RuntimeSnapshot>;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  dispatch<C extends Command>(command: C): Promise<CommandResult<C>>;
  close(): Promise<void>;
}
