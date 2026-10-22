import type { Tool, ToolExecution } from './types.js';
import type { PermissionManager } from './permissions/manager.js';
import { z, type ZodTypeAny } from 'zod';

export type RegisteredTool = Tool & { validator?: ZodTypeAny };
export class ToolRegistry {
  private readonly items = new Map<string, RegisteredTool>();
  private permissions?: PermissionManager;
  setPermissions(p: PermissionManager) {
    this.permissions = p;
  }
  register(tool: RegisteredTool): void {
    if (this.items.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.items.set(tool.name, tool);
  }
  unregister(name: string): void {
    this.items.delete(name);
  }
  list(): Tool[] {
    return [...this.items.values()];
  }
  async invoke(
    name: string,
    input: unknown,
    approve: (name: string, args: unknown) => Promise<boolean>,
    toolCallId?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return (await this.invokeDetailed(name, input, approve, toolCallId, signal)).output;
  }

  async invokeDetailed(
    name: string,
    input: unknown,
    approve: (name: string, args: unknown) => Promise<boolean>,
    toolCallId?: string,
    signal?: AbortSignal,
  ): Promise<ToolExecution> {
    const failure = (output: string, status: 'denied' | 'error' = 'error'): ToolExecution => ({
      output,
      status,
      evidence: [],
    });
    const tool = this.items.get(name);
    if (!tool) return failure(`ERROR: Unknown tool ${name}`);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return failure('ERROR: Tool arguments must be an object');
    try {
      signal?.throwIfAborted();
      const args = tool.validator
        ? tool.validator.parse(input)
        : z.record(z.unknown()).parse(input);
      let approval: { id: string; decision: string } | undefined;
      if (tool.write) {
        if (this.permissions) {
          const outcome = await this.permissions.authorize(
            tool,
            args as Record<string, unknown>,
            toolCallId,
          );
          if (!outcome.allowed)
            return failure(
              JSON.stringify({
                status: 'denied',
                tool: name,
                decision: outcome.decision,
                approvalId: outcome.request.id,
                written: false,
              }),
              'denied',
            );
          approval = { id: outcome.request.id, decision: outcome.decision };
        } else if (!(await approve(name, args)))
          return failure('ERROR: User denied operation', 'denied');
      }
      signal?.throwIfAborted();
      const output = await tool.execute(args as Record<string, unknown>, { signal });
      const outputText = approval
        ? JSON.stringify({
            status: 'success',
            tool: name,
            approvalId: approval.id,
            decision: approval.decision,
            result: output,
          })
        : typeof output === 'string'
          ? output
          : (JSON.stringify(output) ?? 'null');
      return {
        output: outputText,
        status: 'success',
        evidence: tool.evidence?.(args as Record<string, unknown>, output) ?? [],
      };
    } catch (error) {
      return failure(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
