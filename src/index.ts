/** Embedded Node host entry. No terminal dependency or automatic startup. */
export { AgentRuntime } from './host/runtime.js';
export type { RuntimeOptions } from './host/runtime.js';
export type {
  RuntimeDependencies,
  RuntimeModule,
  ContextFactoryInput,
  BuiltinToolset,
} from './host/dependencies.js';
export { Agent } from './core/agent.js';
export type { AgentOptions, AgentInvocation, AgentRunResult } from './core/agent.js';
export type { Model, ModelReply, Tool, ModelEvent } from './core/model/types.js';
export type { RegisteredTool, ToolRegistryPort } from './core/tools/ports.js';
export { ToolRegistry } from './core/tools/registry.js';
export type { ContextPolicyPort } from './core/context/ports.js';
export { ContextManager } from './core/context/manager.js';
export type { MemoryPort } from './core/memory/ports.js';
export type { PermissionPort, PermissionAuditPort } from './core/permissions/ports.js';
export { PermissionManager } from './core/permissions/manager.js';
export type { WorkflowCatalogPort } from './core/workflow/ports.js';
export type {
  DeliveryPort,
  TaskPersistencePort,
  ExecutionStorePort,
} from './core/execution/ports.js';
export type { NodeExecutor, NodeExecutionContext, NodeOutput } from './app/nodes/types.js';
export { executeAgentNode } from './app/nodes/agent.js';
export { executeModelNode } from './app/nodes/model.js';
export { executeToolNode } from './app/nodes/tool.js';
export type * from './protocol/index.js';
export type { AgentLoopPort } from './core/ports.js';
