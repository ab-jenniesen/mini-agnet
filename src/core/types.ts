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
    }
  | { role: 'tool'; tool_call_id: string; content: string };
export type Tool = {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (args: Record<string, unknown>, context?: { signal?: AbortSignal }) => Promise<unknown>;
  write?: boolean;
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
export type ModelReply = { content: string | null; toolCalls: ToolCall[]; usage?: Usage };
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
