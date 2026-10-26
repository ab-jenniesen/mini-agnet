import { z } from 'zod';
import type { ToolRegistryPort } from '../core/tools/ports.js';
import type { ToolArtifacts } from '../infra/storage/tool-artifacts.js';

export function registerArtifactTools(registry: ToolRegistryPort, store: ToolArtifacts): void {
  registry.register({
    name: 'read_tool_output',
    description:
      'Read an archived tool output by id with character offset/limit, without rerunning a tool.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    validator: z
      .object({
        id: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100000).default(12000),
      })
      .strict(),
    execute: async ({ id, offset, limit }) =>
      store.read(id as string, offset as number, limit as number),
  });
}
