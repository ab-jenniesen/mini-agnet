import type { AgentRunResult } from '../../core/agent.js';
import type { ModelReply } from '../../core/model/types.js';
import type { ModelFinishReason } from '../../core/model/completion.js';
import type { Data, WorkflowNode } from '../../core/workflow/definition.js';

export type NodeOutput = {
  outputs: Data;
  completion?: { finishReason: ModelFinishReason; rawFinishReason?: string };
};

/** Extensions receive data and observed actions, never mutable Task/Run lifecycle records. */
export type NodeExecutionContext = {
  readonly inputs: Data;
  readonly definition: WorkflowNode;
  readonly signal: AbortSignal;
  runAgent(): Promise<AgentRunResult>;
  runModel(): Promise<ModelReply>;
  runTool(): Promise<string>;
};

export type NodeExecutor = (context: NodeExecutionContext) => Promise<NodeOutput>;

export interface NodeExecutorCatalog {
  get(name: string): NodeExecutor;
  names(): string[];
}
