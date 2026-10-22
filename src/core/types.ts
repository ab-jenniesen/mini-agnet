import type { ModelFinishReason } from './completion.js';

export type JsonSchema = {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};
export type ToolCall = { id: string; name: string; arguments: string };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
      usage?: Usage;
      /** Request start to first answer text, or reply completion for tool-only/nonstreaming replies. */
      thinkingMs?: number;
      finishReason?: ModelFinishReason;
      rawFinishReason?: string;
    }
  | { role: 'tool'; tool_call_id: string; content: string };
export type Tool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<unknown>;
  write?: boolean;
  /** Derive bounded, factual evidence from a successfully executed tool's actual return value. */
  evidence?: (args: Record<string, unknown>, result: unknown) => ToolEvidence[];
};

export type ToolEvidence =
  | { kind: 'file_change'; path: string }
  | {
      kind: 'command';
      command: string;
      args: string[];
      cwd: string;
      purpose: 'task' | 'verification';
      ok: boolean;
      exitCode: number | null;
      timedOut: boolean;
      cancelled: boolean;
      logPath: string;
    };

export type ToolExecution = {
  output: string;
  status: 'success' | 'denied' | 'error';
  evidence: ToolEvidence[];
};
export type Usage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
  partial?: boolean;
};

export type AgentMetrics = {
  modelCalls: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelMs: number;
  toolMs: number;
  lastRunMs: number;
};
export type ModelReply = {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: ModelFinishReason;
  rawFinishReason?: string;
};
export type ModelEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; source: 'provider' | 'summary' }
  | { type: 'usage'; usage: Usage };
export interface Model {
  setMaxOutputTokens?(tokens: number): void;
  complete(
    messages: Message[],
    tools: Tool[],
    options?: { onEvent?: (event: ModelEvent) => void; signal?: AbortSignal },
  ): Promise<ModelReply>;
}
