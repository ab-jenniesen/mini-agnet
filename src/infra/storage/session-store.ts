import { atomicJson } from './atomic-json.js';
import { readFile } from 'node:fs/promises';
import type { Message } from '../../core/model/types.js';
import { z } from 'zod';

import { messageSchema } from '../../core/model/message-schema.js';
export { messageSchema } from '../../core/model/message-schema.js';

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
export async function saveSession(file: string, messages: Message[]): Promise<void> {
  await atomicJson(file, messages);
}
