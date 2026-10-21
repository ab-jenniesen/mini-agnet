import type { Tool } from './types.js';
import type {PermissionManager} from './permissions/manager.js';
import { z, type ZodTypeAny } from 'zod';

export type RegisteredTool = Tool & { validator?: ZodTypeAny };
export class ToolRegistry {
  private readonly items = new Map<string, RegisteredTool>();
  private permissions?:PermissionManager;
  setPermissions(p:PermissionManager){this.permissions=p;}
  register(tool: RegisteredTool): void {
    if (this.items.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
    this.items.set(tool.name, tool);
  }
  list(): Tool[] { return [...this.items.values()]; }
  async invoke(name: string, input: unknown, approve: (name: string, args: unknown) => Promise<boolean>, toolCallId?: string): Promise<string> {
    const tool = this.items.get(name);
    if (!tool) return `ERROR: Unknown tool ${name}`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'ERROR: Tool arguments must be an object';
    try {
      const args = tool.validator ? tool.validator.parse(input) : z.record(z.unknown()).parse(input);
      let approval: {id:string;decision:string}|undefined;
      if (tool.write) {
        if(this.permissions){const outcome=await this.permissions.authorize(tool,args as Record<string,unknown>,toolCallId);if(!outcome.allowed)return JSON.stringify({status:'denied',tool:name,decision:outcome.decision,approvalId:outcome.request.id,written:false});approval={id:outcome.request.id,decision:outcome.decision};}
        else if(!await approve(name,args))return 'ERROR: User denied operation';
      }
      const output = await tool.execute(args as Record<string, unknown>);
      return approval ? JSON.stringify({status:'success',tool:name,approvalId:approval.id,decision:approval.decision,result:output}) : (typeof output === 'string' ? output : JSON.stringify(output));
    } catch (error) { return `ERROR: ${error instanceof Error ? error.message : String(error)}`; }
  }
}
