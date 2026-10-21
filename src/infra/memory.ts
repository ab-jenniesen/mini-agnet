import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Message } from '../core/types.js';

/** Short-term memory: full messages saved per session, separate from curated long-term facts. */
export async function loadSession(file: string): Promise<Message[] | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(value) || !value.every(m => m && typeof m === 'object' && ['system','user','assistant','tool'].includes(m.role))) throw new Error('Invalid session file');
    return value as Message[];
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
export async function atomicJson(file: string, data: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { await rename(temp, file); } catch (error) { const { rm } = await import('node:fs/promises'); await rm(temp, {force:true}); throw error; }
}
export async function saveSession(file: string, messages: Message[]): Promise<void> { await atomicJson(file, messages); }
