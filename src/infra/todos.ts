import { z } from 'zod';
import type { ToolRegistry } from '../core/registry.js';
import { atomicJson } from './memory.js';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
export type Todo = { id: string; title: string; status: 'pending' | 'in_progress' | 'completed'; createdAt: string };
export class TodoStore {
  private items: Todo[] = [];
  private constructor(private file: string, private onChange?: (todos: Todo[]) => void) {}
  static async open(file: string, onChange?: (todos: Todo[]) => void) {
    const t = new TodoStore(file, onChange);
    try { const parsed: unknown = JSON.parse(await readFile(file, 'utf8')); t.items = z.array(z.object({id:z.string(),title:z.string(),status:z.enum(['pending','in_progress','completed']),createdAt:z.string()})).parse(parsed); }
    catch(e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    return t;
  }
  list() { return this.items.map(t => ({ ...t })); }
  private async persist() { await atomicJson(this.file, this.items); this.onChange?.(this.list()); }
  async add(title: string) { if (this.items.length >= 100) throw new Error('Todo capacity reached'); const task: Todo = { id:randomUUID(), title, status:'pending', createdAt:new Date().toISOString() }; this.items.push(task); await this.persist(); return task; }
  async set(id: string, status: Todo['status']) { const t = this.items.find(x=>x.id===id); if(!t) throw new Error('Todo not found'); t.status=status; await this.persist(); return t; }
  async clear() { this.items=[]; await this.persist(); }
}
export function registerTodoTools(registry: ToolRegistry, store: TodoStore) {
  registry.register({ name:'todo_list', description:'List current session task plan and progress.', parameters:{type:'object',properties:{},additionalProperties:false},validator:z.object({}).strict(),execute:async()=>store.list() });
  registry.register({ name:'todo_add', description:'Add a task to the current session task plan. Does not alter code.', parameters:{type:'object',properties:{title:{type:'string'}},required:['title'],additionalProperties:false},validator:z.object({title:z.string().min(1).max(200)}).strict(),execute:async({title})=>store.add(title as string) });
  registry.register({ name:'todo_update', description:'Update the status of a current session task. Does not alter code.', parameters:{type:'object',properties:{id:{type:'string'},status:{type:'string',enum:['pending','in_progress','completed']}},required:['id','status'],additionalProperties:false},validator:z.object({id:z.string().uuid(),status:z.enum(['pending','in_progress','completed'])}).strict(),execute:async({id,status})=>store.set(id as string,status as Todo['status']) });
}
