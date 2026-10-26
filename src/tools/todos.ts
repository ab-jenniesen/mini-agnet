import { z } from 'zod';
import type { ToolRegistryPort } from '../core/tools/ports.js';
import type { TodoStore } from '../infra/storage/todo-store.js';
import type { Todo } from '../core/execution/todo.js';

export function registerTodoTools(registry: ToolRegistryPort, store: TodoStore) {
  registry.register({
    name: 'todo_list',
    description: 'List current session task plan and progress.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    validator: z.object({}).strict(),
    execute: async () => store.list(),
  });
  registry.register({
    name: 'todo_add',
    description: 'Add a task to the current session task plan. Does not alter code.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
    validator: z.object({ title: z.string().min(1).max(200) }).strict(),
    execute: async ({ title }) => store.add(title as string),
  });
  registry.register({
    name: 'todo_update',
    description: 'Update the status of a current session task. Does not alter code.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    validator: z
      .object({ id: z.string().uuid(), status: z.enum(['pending', 'in_progress', 'completed']) })
      .strict(),
    execute: async ({ id, status }) => store.set(id as string, status as Todo['status']),
  });
}
