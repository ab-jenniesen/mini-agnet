import type { ZodTypeAny } from 'zod';
import type { Tool, ToolExecution } from '../model/types.js';

export type RegisteredTool = Tool & {
  validator?: ZodTypeAny;
  delegate?: { name: string; fixed: Record<string, unknown> };
};

export interface ToolRegistryPort {
  register(tool: RegisteredTool): void;
  unregister(name: string): void;
  list(): Tool[];
  scoped(names?: string[]): ToolRegistryPort;
  invokeDetailed(
    name: string,
    input: unknown,
    approve: (name: string, args: unknown) => Promise<boolean>,
    toolCallId?: string,
    signal?: AbortSignal,
  ): Promise<ToolExecution>;
}
