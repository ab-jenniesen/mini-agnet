import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export type FileSnapshot = {
  bytes: Buffer;
  sha256: string;
  mtimeMs: number;
  sizeBytes: number;
  source: 'disk' | 'validated-cache';
};
/** Never trust mtime alone. Hash freshly read bytes on EVERY access; reuse decoded content separately. */
export class VerifiedFileCache {
  private readonly values = new Map<string, { sha256: string; text: string }>();
  constructor(private readonly capacity = 64) {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error('Invalid file cache capacity');
  }
  async read(path: string): Promise<FileSnapshot & { text: string }> {
    const bytes = await readFile(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const cached = this.values.get(path);
    const source = cached?.sha256 === sha256 ? ('validated-cache' as const) : ('disk' as const);
    const text = source === 'validated-cache' ? cached!.text : bytes.toString('utf8');
    this.values.delete(path);
    this.values.set(path, { sha256, text });
    while (this.values.size > this.capacity) this.values.delete(this.values.keys().next().value!);
    const metadata = await stat(path);
    return { bytes, sha256, sizeBytes: bytes.length, mtimeMs: metadata.mtimeMs, text, source };
  }
  invalidate(path: string): void {
    this.values.delete(path);
  }
  clear(): void {
    this.values.clear();
  }
}
