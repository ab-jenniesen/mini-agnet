import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolRegistryPort } from '../../core/tools/ports.js';

/** Explicit opt-in: launch only an MCP server command supplied by the operator, never the model. */
export async function connectMcpStdio(
  registry: ToolRegistryPort,
  command: string,
  args: string[] = [],
  namespace = 'external',
): Promise<() => Promise<void>> {
  const client = new Client({ name: 'mini-agent-lab', version: '1.0.0' });
  const registered: string[] = [];
  try {
    await client.connect(new StdioClientTransport({ command, args }));
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const name = `mcp_${namespace.replace(/[^a-zA-Z0-9_-]/g, '_')}_${tool.name}`;
      registry.register({
        name,
        description: `[External MCP tool; permission required] ${tool.description ?? tool.name}`,
        parameters: tool.inputSchema as {
          type: 'object';
          properties: Record<string, unknown>;
          required?: string[];
        },
        write: true, // Treat all external actions as requiring approval (including reads for untrusted servers).
        execute: async (input) => {
          const result = await client.callTool({ name: tool.name, arguments: input });
          if (result.isError) throw new Error(JSON.stringify(result.content));
          return result.content;
        },
      });
      registered.push(name);
    }
  } catch (error) {
    for (const name of registered) registry.unregister(name);
    await client.close().catch(() => {});
    throw error;
  }
  return async () => {
    for (const name of registered) registry.unregister(name);
    await client.close();
  };
}
