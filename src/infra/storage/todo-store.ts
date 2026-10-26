import { z } from 'zod';
import { atomicJson } from './atomic-json.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Todo } from '../../core/execution/todo.js';
export type { Todo } from '../../core/execution/todo.js';
export class TodoStore {
  private items: Todo[] = [];
  private constructor(
    private file: string,
    private onChange?: (todos: Todo[]) => void,
  ) {}
  static async open(file: string, onChange?: (todos: Todo[]) => void) {
    const t = new TodoStore(file, onChange);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      t.items = z
        .array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.enum(['pending', 'in_progress', 'completed']),
            createdAt: z.string(),
          }),
        )
        .parse(parsed);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return t;
  }
  list() {
    return this.items.map((t) => ({ ...t }));
  }
  private async persist(next: Todo[]) {
    await atomicJson(this.file, next);
    this.items = next;
    this.onChange?.(this.list());
  }
  async add(title: string) {
    if (this.items.length >= 100) throw new Error('Todo capacity reached');
    const task: Todo = {
      id: randomUUID(),
      title,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.persist([...this.items, task]);
    return { ...task };
  }
  async set(id: string, status: Todo['status']) {
    const t = this.items.find((x) => x.id === id);
    if (!t) throw new Error('Todo not found');
    const updated = { ...t, status };
    await this.persist(this.items.map((item) => (item.id === id ? updated : item)));
    return { ...updated };
  }
  async clear() {
    await this.persist([]);
  }
}
