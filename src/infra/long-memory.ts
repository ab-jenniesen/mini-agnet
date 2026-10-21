import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicJson } from './memory.js';

export type MemoryEntry = {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

/** Small local persistent knowledge store: no external embedding API required. */
export class LongTermMemory {
  private entries: MemoryEntry[] = [];
  private constructor(private readonly file: string) {}
  static async open(file: string): Promise<LongTermMemory> {
    const store = new LongTermMemory(file);
    try {
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (!Array.isArray(value) || !value.every(isEntry))
        throw new Error('Invalid long-term memory file');
      store.entries = value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return store;
  }
  list(): MemoryEntry[] {
    return this.entries.map((m) => ({ ...m, tags: [...m.tags] }));
  }
  search(query: string, limit = 5): MemoryEntry[] {
    const q = tokenize(query);
    if (!q.length) return [];
    return this.entries
      .map((m) => {
        const hay = tokenize(`${m.text} ${m.tags.join(' ')}`);
        const score = q.reduce(
          (n, token) =>
            n +
            (hay.includes(token)
              ? 2
              : hay.some((w) => w.includes(token) || token.includes(w))
                ? 1
                : 0),
          0,
        );
        return { m, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.updatedAt.localeCompare(a.m.updatedAt))
      .slice(0, Math.max(0, Math.min(limit, 20)))
      .map((x) => ({ ...x.m, tags: [...x.m.tags] }));
  }
  async add(text: string, tags: string[] = []): Promise<MemoryEntry> {
    const normalized = text.trim();
    if (!normalized || normalized.length > 4000)
      throw new Error('Memory text must be 1–4000 characters');
    if (this.entries.length >= 1000) throw new Error('Memory capacity reached');
    const now = new Date().toISOString();
    const entry: MemoryEntry = {
      id: randomUUID(),
      text: normalized,
      tags: tags.slice(0, 10).map((s) => s.slice(0, 40)),
      createdAt: now,
      updatedAt: now,
    };
    await this.persist([...this.entries, entry]);
    return { ...entry, tags: [...entry.tags] };
  }
  async update(id: string, text: string): Promise<MemoryEntry> {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) throw new Error('Memory not found');
    const value = text.trim();
    if (!value || value.length > 4000) throw new Error('Memory text must be 1–4000 characters');
    const updated = { ...entry, text: value, updatedAt: new Date().toISOString() };
    await this.persist(this.entries.map((item) => (item.id === id ? updated : item)));
    return { ...updated, tags: [...updated.tags] };
  }
  async remove(id: string): Promise<boolean> {
    const old = this.entries.length;
    const next = this.entries.filter((m) => m.id !== id);
    if (next.length === old) return false;
    await this.persist(next);
    return true;
  }
  private async persist(next: MemoryEntry[]): Promise<void> {
    await atomicJson(this.file, next);
    this.entries = next;
  }
}
function isEntry(x: unknown): x is MemoryEntry {
  if (!x || typeof x !== 'object') return false;
  const v = x as Partial<MemoryEntry>;
  return (
    typeof v.id === 'string' &&
    typeof v.text === 'string' &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === 'string') &&
    typeof v.createdAt === 'string' &&
    typeof v.updatedAt === 'string'
  );
}
function tokenize(s: string): string[] {
  // CJK character bigrams and Latin words; educational lexical retrieval, not semantic embeddings.
  const words = s.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9fff]+/g) ?? [];
  return [
    ...new Set(
      words.flatMap((w) =>
        /^[\u3400-\u9fff]+$/.test(w) && w.length > 1
          ? [w, ...Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2))]
          : [w],
      ),
    ),
  ];
}
