import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { atomicJson } from './atomic-json.js';
import type { Message } from '../../core/model/types.js';
export type CompactionRecord = {
  coveredCount: number;
  prefixDigest: string;
  summary: string;
  updatedAt: string;
};
export const digestMessages = (messages: Message[]) =>
  createHash('sha256').update(JSON.stringify(messages)).digest('hex');
/** Persisted only after successful summarization; old messages stay in the canonical session. */
export class CompactionStore {
  constructor(private readonly file: string) {}
  async read(history: Message[]): Promise<CompactionRecord | undefined> {
    try {
      const v = JSON.parse(await readFile(this.file, 'utf8')) as CompactionRecord;
      if (
        !Number.isSafeInteger(v.coveredCount) ||
        v.coveredCount < 1 ||
        v.coveredCount > history.length ||
        typeof v.summary !== 'string' ||
        v.prefixDigest !== digestMessages(history.slice(0, v.coveredCount))
      )
        return undefined;
      return v;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
  async save(history: Message[], coveredCount: number, summary: string): Promise<void> {
    if (!Number.isSafeInteger(coveredCount) || coveredCount < 1 || coveredCount > history.length)
      throw Error('Invalid compaction coverage');
    await atomicJson(this.file, {
      coveredCount,
      prefixDigest: digestMessages(history.slice(0, coveredCount)),
      summary,
      updatedAt: new Date().toISOString(),
    } satisfies CompactionRecord);
  }
}
