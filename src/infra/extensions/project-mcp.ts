import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolRegistryPort } from '../../core/tools/ports.js';
import { connectMcpStdio } from './mcp.js';
import type { ProjectState } from '../workspace/project-state.js';
export type McpServer = { command: string; args?: string[]; enabled?: boolean };
async function readConfig(file: string): Promise<Record<string, McpServer>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  if (!raw || typeof raw !== 'object' || !('servers' in raw))
    throw Error(`Invalid MCP config: ${file}`);
  const servers = (raw as { servers: unknown }).servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers))
    throw Error(`Invalid MCP servers: ${file}`);
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec))
      throw Error(`Invalid MCP ${name}`);
    const x = spec as Partial<McpServer>;
    if (
      typeof x.command !== 'string' ||
      !x.command.trim() ||
      (x.args !== undefined &&
        (!Array.isArray(x.args) || !x.args.every((a) => typeof a === 'string'))) ||
      (x.enabled !== undefined && typeof x.enabled !== 'boolean')
    )
      throw Error(`Invalid MCP server ${name}`);
  }
  return servers as Record<string, McpServer>;
}
export async function resolveMcpServers(
  globalConfig: string,
  projectConfig: string,
): Promise<Record<string, McpServer>> {
  return { ...(await readConfig(globalConfig)), ...(await readConfig(projectConfig)) };
}
/** Config precedence project > global; project enabled:false suppresses same-name global server. */
export async function connectProjectMcp(
  registry: ToolRegistryPort,
  state: ProjectState,
  globalConfig = join(homedir(), '.config', 'mini-agent', 'mcp.json'),
  report: (text: string) => void = (text) => console.error(text),
): Promise<() => Promise<void>> {
  // Invalid project/global MCP configuration must not prevent the CLI from starting.
  let servers: Record<string, McpServer> = {};
  try {
    servers = await resolveMcpServers(globalConfig, state.path('mcp.json'));
  } catch (error) {
    report(
      `[mini-agent] MCP config invalid; MCP disabled: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const closers: Array<() => Promise<void>> = [];
  for (const [name, server] of Object.entries(servers)) {
    if (server.enabled !== true) continue;
    try {
      // One broken server must not prevent other configured servers or the Agent from starting.
      closers.push(await connectMcpStdio(registry, server.command, server.args ?? [], name));
    } catch (error) {
      report(
        `[mini-agent] MCP server ${name} unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return async () => {
    for (const close of closers.reverse())
      await close().catch((error) => report(`[mini-agent] MCP shutdown: ${String(error)}`));
  };
}
