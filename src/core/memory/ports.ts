import type { MemoryScope, ScopedMemoryEntry } from './types.js';

/** Synchronous reads keep tool listings and context retrieval predictable. */
export interface MemoryPort {
  list(scope?: MemoryScope): ScopedMemoryEntry[];
  search(query: string, limit?: number, scope?: MemoryScope): ScopedMemoryEntry[];
  add(text: string, tags?: string[], scope?: MemoryScope): Promise<ScopedMemoryEntry>;
  update(id: string, text: string, scope?: MemoryScope): Promise<ScopedMemoryEntry>;
  remove(id: string, scope?: MemoryScope): Promise<boolean>;
}
