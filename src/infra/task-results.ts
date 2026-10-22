import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TaskResult } from '../app/tasks.js';
import { atomicJson } from './memory.js';

const finish = z.enum(['stop', 'tool_calls', 'length', 'blocked', 'pause', 'error', 'unknown']);
const count = z.number().finite().nonnegative();
const command = z.object({
  kind: z.literal('command'),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  purpose: z.enum(['task', 'verification']),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
  logPath: z.string(),
});
const resultSchema: z.ZodType<TaskResult> = z.object({
  runId: z.string().uuid(),
  sessionId: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled', 'blocked']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  summary: z.string(),
  finishReason: finish.optional(),
  rawFinishReason: z.string().optional(),
  changes: z.array(z.string()),
  evidence: z.array(
    z.union([z.object({ kind: z.literal('file_change'), path: z.string() }), command]),
  ),
  verification: z.object({
    status: z.enum(['not_run', 'passed', 'failed']),
    checks: z.array(command),
  }),
  remaining: z.array(z.string()),
  metrics: z.object({
    modelCalls: count,
    toolCalls: count,
    promptTokens: count,
    completionTokens: count,
    totalTokens: count,
    modelMs: count,
    toolMs: count,
    lastRunMs: count,
  }),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

/** Last terminal result per session; this is not a checkpoint or permission to resume a task. */
export class TaskResultStore {
  constructor(private readonly file: string) {}
  async load(): Promise<TaskResult | undefined> {
    try {
      const stored: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      return resultSchema.parse(stored);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async save(result: TaskResult): Promise<void> {
    await atomicJson(this.file, resultSchema.parse(result));
  }
}
