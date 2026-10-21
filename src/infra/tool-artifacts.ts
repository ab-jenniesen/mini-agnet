import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from '../core/registry.js';

export class ToolArtifacts {
  constructor(private readonly directory: string) {}
  async save(value: string): Promise<{ id: string; length: number }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const id = randomUUID();
    await writeFile(join(this.directory, id + '.txt'), value, { mode: 0o600, flag: 'wx' });
    return { id, length: value.length };
  }
  async read(id: string, offset = 0, limit = 12000): Promise<string> {
    const page = await this.page(id, offset, limit);
    return `Artifact ${id} chars=${page.total}; offset=${page.offset}; next=${page.next}\n${page.content}`;
  }
  async page(id: string, offset = 0, limit = 12000) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid artifact id');
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100000
    )
      throw Error('Invalid artifact range');
    const path = resolve(this.directory, id + '.txt');
    const size = (await stat(path)).size;
    if (size > 200_000_000) throw Error('Artifact too large for in-memory inspection');
    const contents = await readFile(path, 'utf8');
    offset = Math.min(offset, contents.length);
    return {
      id,
      offset,
      total: contents.length,
      next: Math.min(contents.length, offset + limit),
      content: contents.slice(offset, offset + limit),
    };
  }
}
export function registerArtifactTools(registry: ToolRegistry, store: ToolArtifacts): void {
  registry.register({
    name: 'read_tool_output',
    description:
      'Read an archived tool output by id with character offset/limit, without rerunning a tool.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    validator: z
      .object({
        id: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100000).default(12000),
      })
      .strict(),
    execute: async ({ id, offset, limit }) =>
      store.read(id as string, offset as number, limit as number),
  });
}
