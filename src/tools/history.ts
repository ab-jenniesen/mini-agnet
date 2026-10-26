import { z } from 'zod';
import type { ToolRegistryPort } from '../core/tools/ports.js';
import type { Message } from '../core/model/types.js';
export function registerHistoryTools(registry: ToolRegistryPort, history: Message[]): void {
  registry.register({
    name: 'search_conversation',
    description:
      'Search prior canonical conversation text including historical tool observations; results are past observations, not proof of current file content.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      required: ['query'],
      additionalProperties: false,
    },
    validator: z
      .object({
        query: z.string().min(2).max(200),
        limit: z.number().int().min(1).max(20).default(5),
      })
      .strict(),
    execute: async ({ query, limit }) =>
      JSON.stringify(
        history
          .map((m, i) => ({ m, i }))
          .filter((x) =>
            JSON.stringify(x.m)
              .toLowerCase()
              .includes((query as string).toLowerCase()),
          )
          .slice(-(limit as number))
          .map((x) => ({
            index: x.i,
            role: x.m.role,
            preview: JSON.stringify(x.m).slice(0, 1400),
          })),
      ),
  });
}
