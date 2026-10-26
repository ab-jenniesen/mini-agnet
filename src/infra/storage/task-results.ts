import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TaskResult } from '../../core/execution/result.js';
import { atomicJson } from './atomic-json.js';

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
  taskId: z.string().uuid().optional(),
  runId: z.string().uuid(),
  sessionId: z.string(),
  status: z.enum([
    'completed',
    'failed',
    'cancelled',
    'blocked',
    'waiting',
    'paused',
    'interrupted',
  ]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
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
  completeness: z
    .object({
      status: z.enum(['not_run', 'passed', 'incomplete', 'error', 'not_applicable']),
      reportId: z.string().optional(),
    })
    .optional(),
});

/** Legacy-compatible response cache. V1.2 execution manifests own lifecycle and recovery. */
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
