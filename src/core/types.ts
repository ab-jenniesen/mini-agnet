export type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
export type ToolCall = { id: string; name: string; arguments: string };
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };
export type Tool = { name: string; description: string; parameters: JsonSchema; execute: (args: Record<string, unknown>) => Promise<unknown>; write?: boolean };
export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number; estimated?: boolean };
export type ModelReply = { content: string | null; toolCalls: ToolCall[]; usage?: Usage };
export type ModelEvent = { type: 'text'; text: string } | { type: 'thinking'; text: string; source: 'provider' | 'summary' } | { type: 'usage'; usage: Usage };
export interface Model { setMaxOutputTokens?(tokens:number): void; complete(messages: Message[], tools: Tool[], options?: { onEvent?: (event: ModelEvent) => void; signal?: AbortSignal }): Promise<ModelReply> }
