import type { AgentEvent } from '../core/events.js';
import type { AgentMetrics, Message } from '../core/types.js';
import type {
  ApprovalRequest,
  PermissionEvent,
  PermissionMode,
} from '../core/permissions/manager.js';
import type { ContextCapability } from '../core/context/capabilities.js';
import type { Provider, Selection } from '../core/providers.js';
import type { ModelCatalog } from '../core/model-discovery.js';
import type { CredentialStatus } from '../infra/credentials.js';
import type { ScopedMemoryEntry } from '../infra/scoped-memory.js';
import type { Todo } from '../infra/todos.js';
import type { TaskResult, TaskSnapshot } from './tasks.js';

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
export type RuntimeEvent =
  | { type: 'task'; task: TaskSnapshot }
  | { type: 'agent'; event: AgentEvent }
  | { type: 'permission'; event: PermissionEvent }
  | { type: 'state'; state: RuntimeSnapshot }
  | { type: 'message'; message: Message }
  | { type: 'approval_requested'; approval: ApprovalView }
  | { type: 'approval_resolved'; id: string; accepted: boolean }
  | { type: 'notice'; level: 'info' | 'error'; text: string }
  | { type: 'run_error'; text: string };

type Action<Input, Output> = { input: Input; output: Output };
export type Actions = {
  run: Action<{ input: string }, string>;
  'tasks.run': Action<{ input: string }, TaskResult>;
  'tasks.current': Action<{}, TaskSnapshot | undefined>;
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
