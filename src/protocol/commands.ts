import { z } from 'zod';
import type { Command } from './contracts.js';
import { jsonSchema, workflowSchema } from '../core/workflow/definition.js';
import { contextSettingsSchema } from '../core/context/settings.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const provider = z.string().min(1).max(80);
const noArgs = <T extends string>(type: T) => z.object({ type: z.literal(type) }).strict();

/** Validate untrusted transport data at the application boundary. */
export const commandSchema: z.ZodType<Command, z.ZodTypeDef, unknown> = z.discriminatedUnion(
  'type',
  [
    z.object({ type: z.literal('run'), input: z.string().min(1).max(1_000_000) }).strict(),
    z.object({ type: z.literal('tasks.run'), input: z.string().min(1).max(1_000_000) }).strict(),
    noArgs('tasks.current'),
    noArgs('tasks.list'),
    noArgs('execution.get'),
    noArgs('workflows.list'),
    noArgs('runs.pause'),
    noArgs('context.get'),
    noArgs('runtime.capabilities'),
    noArgs('tools.describe'),
    z.object({ type: z.literal('context.configure'), settings: contextSettingsSchema }).strict(),
    z
      .object({
        type: z.literal('tasks.create'),
        input: z.string().trim().min(1).max(1_000_000),
        workflowId: z.string().max(64).optional(),
      })
      .strict(),
    z.object({ type: z.literal('tasks.select'), id }).strict(),
    z
      .object({
        type: z.literal('tasks.continue'),
        id,
        input: z.string().max(1_000_000).optional(),
      })
      .strict(),
    z.object({ type: z.literal('tasks.cancel'), id }).strict(),
    z.object({ type: z.literal('runs.get'), id }).strict(),
    z
      .object({ type: z.literal('runs.resume'), id, confirmReplay: z.boolean().optional() })
      .strict(),
    z.object({ type: z.literal('waits.respond'), id, response: jsonSchema }).strict(),
    z.object({ type: z.literal('workflows.select'), id }).strict(),
    z.object({ type: z.literal('workflows.register'), definition: workflowSchema }).strict(),
    noArgs('cancel'),
    noArgs('sessions.list'),
    noArgs('sessions.reset'),
    z.object({ type: z.literal('sessions.switch'), id }).strict(),
    z.object({ type: z.literal('sessions.delete'), id }).strict(),
    noArgs('models.providers'),
    z.object({ type: z.literal('models.discover'), provider }).strict(),
    z
      .object({ type: z.literal('models.select'), provider, model: z.string().min(1).max(300) })
      .strict(),
    z
      .object({
        type: z.literal('credentials.set'),
        provider,
        key: z.string().min(1).max(8192),
        persist: z.boolean(),
      })
      .strict(),
    z
      .object({ type: z.literal('permissions.set'), mode: z.enum(['read-only', 'ask', 'allow']) })
      .strict(),
    noArgs('workspace.status'),
    z.object({ type: z.literal('workspace.grant'), path: z.string().min(1).max(4096) }).strict(),
    noArgs('tools.list'),
    z
      .object({ type: z.literal('memories.list'), scope: z.enum(['project', 'global']).optional() })
      .strict(),
    noArgs('artifacts.list'),
    z
      .object({
        type: z.literal('artifacts.read'),
        id: z.string().uuid(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(100000).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal('approvals.respond'),
        id: z.string().uuid(),
        accepted: z.boolean(),
      })
      .strict(),
  ],
);
