import { z } from 'zod';
import type { ToolRegistryPort } from '../core/tools/ports.js';
import type { Workspace } from '../infra/workspace/files.js';
/** PermissionManager must approve this tool even when write mode is `allow`. */
export function registerWorkspaceTools(registry: ToolRegistryPort, workspace: Workspace): void {
  registry.register({
    name: 'list_write_directories',
    description:
      'List currently authorized writable directories. All other absolute paths are read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    validator: z.object({}).strict(),
    execute: async () =>
      JSON.stringify({ root: workspace.root, writable: workspace.listWritable() }),
  });
  registry.register({
    name: 'request_write_directory',
    description:
      'Ask the user to grant write access to an additional directory. If missing, set createIfMissing=true to request its creation. Requires explicit approval even in auto-write mode.',
    write: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, createIfMissing: { type: 'boolean' } },
      required: ['path', 'createIfMissing'],
      additionalProperties: false,
    },
    validator: z.object({ path: z.string().min(1), createIfMissing: z.boolean() }).strict(),
    execute: async ({ path, createIfMissing }) =>
      JSON.stringify({
        status: 'granted',
        path: await workspace.addDirectory(path as string, createIfMissing as boolean),
      }),
  });
}
