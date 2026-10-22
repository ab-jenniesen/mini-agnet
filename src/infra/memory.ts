import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../core/types.js';
import { z } from 'zod';

const usageSchema = z.object({
  promptTokens: z.number().nonnegative().finite(),
  completionTokens: z.number().nonnegative().finite(),
  totalTokens: z.number().nonnegative().finite(),
  estimated: z.boolean().optional(),
  partial: z.boolean().optional(),
});
const messageSchema = z.union([
  z.object({ role: z.enum(['system', 'user']), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    usage: usageSchema.optional(),
    thinkingMs: z.number().nonnegative().finite().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string().min(1),
          type: z.literal('function'),
          function: z.object({ name: z.string().min(1), arguments: z.string() }),
        }),
      )
      .optional(),
  }),
  z.object({ role: z.literal('tool'), tool_call_id: z.string().min(1), content: z.string() }),
]);

/** Short-term memory: full messages saved per session, separate from curated long-term facts. */
export async function loadSession(file: string): Promise<Message[] | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    const parsed = z.array(messageSchema).safeParse(value);
    if (!parsed.success) throw new Error(`Invalid session file: ${file}`);
    return parsed.data;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}
export async function atomicJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await rename(temp, file);
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(temp, { force: true });
    throw error;
  }
}
export async function saveSession(file: string, messages: Message[]): Promise<void> {
  await atomicJson(file, messages);
}
