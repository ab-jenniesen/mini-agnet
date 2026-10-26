import { z } from 'zod';
import { jsonSchema, workflowSchema } from '../workflow/definition.js';

const id = z.string().min(1).max(100);
const time = z.string().datetime();
export const taskStatusSchema = z.enum([
  'ready',
  'active',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
]);
export const runStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'paused',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);
const nodeStatus = z.enum([
  'pending',
  'running',
  'waiting',
  'paused',
  'interrupted',
  'completed',
  'failed',
  'cancelled',
]);
export const phaseSchema = z.enum([
  'preparing',
  'executing',
  'verifying',
  'finalizing',
  'finalized',
]);
const data = z.record(jsonSchema);
const error = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
});
const metrics = z.object({
  modelCalls: z.number().nonnegative(),
  toolCalls: z.number().nonnegative(),
  promptTokens: z.number().nonnegative(),
  completionTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  modelMs: z.number().nonnegative(),
  toolMs: z.number().nonnegative(),
  lastRunMs: z.number().nonnegative(),
});
const evidence = z.union([
  z.object({ kind: z.literal('file_change'), path: z.string() }),
  z.object({
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
  }),
]);
export const checklistInputSchema = z
  .object({
    mode: z.enum(['files', 'response']),
    files: z.array(z.string().min(1).max(4096)).max(200),
    plan: z.array(z.string().min(1).max(2000)).max(100).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.mode === 'files' && !value.files.length) ||
      (value.mode === 'response' && value.files.length)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Files mode requires files; response mode requires an empty files list',
      });
  });
export const checklistSchema = z.object({
  id,
  taskId: id,
  version: z.number().int().positive(),
  goalRevision: z.number().int().positive(),
  mode: z.enum(['files', 'response']),
  files: z.array(z.object({ id, path: z.string().min(1) })),
  createdAt: time,
});
const plan = z.object({
  version: z.number().int().positive(),
  status: z.enum(['draft', 'active', 'completed', 'cancelled']),
  approval: z.enum(['not_required', 'pending', 'approved', 'rejected']),
  steps: z.array(
    z.object({
      id,
      text: z.string(),
      status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
    }),
  ),
});
export const goalSchema = z.object({
  id,
  sessionId: id,
  title: z.string(),
  goal: z.string(),
  goalRevision: z.number().int().positive(),
  status: taskStatusSchema,
  createdAt: time,
  updatedAt: time,
  finishedAt: time.optional(),
  workflow: workflowSchema,
  checklist: checklistSchema.optional(),
  plan: plan.optional(),
  goalHistory: z
    .array(z.object({ revision: z.number().int().positive(), text: z.string() }))
    .default([]),
  runIds: z.array(id),
  activeRunId: id.optional(),
  lastRunId: id.optional(),
  artifactIds: z.array(id),
  summary: z.string().optional(),
  statusReason: z.string().optional(),
});
export const reportSchema = z.object({
  id,
  taskId: id,
  runId: id,
  checklistVersion: z.number().int().positive(),
  goalRevision: z.number().int().positive(),
  checkedAt: time,
  status: z.enum(['passed', 'incomplete', 'error', 'not_applicable']),
  items: z.array(
    z.object({
      itemId: id,
      path: z.string(),
      status: z.enum(['present', 'missing', 'error']),
      byteLength: z.number().nonnegative().optional(),
      error: z.string().optional(),
    }),
  ),
});
export const runSchema = z.object({
  id,
  sessionId: id,
  taskId: id,
  status: runStatusSchema,
  phase: phaseSchema,
  createdAt: time,
  updatedAt: time,
  startedAt: time,
  finishedAt: time.optional(),
  input: z.string(),
  goalRevision: z.number().int().positive(),
  workflow: workflowSchema,
  state: z.object({ revision: z.number().int().nonnegative(), data }),
  cursor: z.string(),
  currentNodeRunId: id.optional(),
  nodeRunIds: z.array(id),
  checklistVersion: z.number().int().positive().optional(),
  checklist: checklistSchema.optional(),
  planSnapshot: plan.optional(),
  reportIds: z.array(id),
  feedback: z.array(z.string()),
  summary: z.string().default(''),
  metrics,
  evidence: z.array(evidence).default([]),
  finishReason: z
    .enum(['stop', 'tool_calls', 'length', 'blocked', 'pause', 'error', 'unknown'])
    .optional(),
  rawFinishReason: z.string().optional(),
  error: error.optional(),
  config: z.object({
    provider: z.string(),
    model: z.string(),
    contextWindow: z.number().positive(),
    outputReserve: z.number().positive(),
    permissionMode: z.enum(['read-only', 'ask', 'allow']),
  }),
});
export const nodeRunSchema = z.object({
  id,
  runId: id,
  taskId: id,
  sessionId: id,
  nodeId: id,
  status: nodeStatus,
  createdAt: time,
  finishedAt: time.optional(),
  inputStateRevision: z.number().int().nonnegative(),
  inputs: data,
  outputs: data.optional(),
  committedStateRevision: z.number().int().nonnegative().optional(),
  attempts: z.array(
    z.object({
      id,
      number: z.number().int().positive(),
      status: nodeStatus,
      startedAt: time,
      finishedAt: time.optional(),
      error: error.optional(),
    }),
  ),
  metrics,
  error: error.optional(),
});
export const waitSchema = z.object({
  id,
  taskId: id,
  runId: id,
  nodeRunId: id.optional(),
  kind: z.enum(['user_input', 'plan_approval', 'recovery']),
  status: z.enum(['pending', 'resolved', 'cancelled']),
  prompt: z.string(),
  createdAt: time,
  resolvedAt: time.optional(),
  response: jsonSchema.optional(),
});
export const artifactSchema = z.object({
  id,
  taskId: id,
  runId: id,
  path: z.string(),
  createdAt: time,
  byteLength: z.number().nonnegative(),
});
export const operationSchema = z.object({
  id,
  runId: id,
  taskId: id,
  nodeRunId: id.optional(),
  kind: z.enum(['model', 'tool', 'context', 'completeness']),
  name: z.string(),
  status: z.enum(['running', 'completed', 'failed', 'denied', 'interrupted']),
  createdAt: time,
  finishedAt: time.optional(),
  durationMs: z.number().nonnegative().optional(),
  details: data.optional(),
});
export const executionSchema = z.object({
  schemaVersion: z.literal(1),
  generationId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  session: z.object({
    id,
    status: z.enum(['open', 'closed', 'archived']),
    createdAt: time,
    updatedAt: time,
  }),
  selectedTaskId: id.optional(),
  selectedWorkflowId: z.string().default('general'),
  history: z.array(jsonSchema).default([]),
  tasks: z.array(goalSchema),
  runs: z.array(runSchema),
  nodes: z.array(nodeRunSchema),
  reports: z.array(reportSchema),
  waits: z.array(waitSchema),
  artifacts: z.array(artifactSchema),
  operations: z.array(operationSchema),
});

export type GoalTask = z.infer<typeof goalSchema>;
export type WorkflowRun = z.infer<typeof runSchema>;
export type NodeRun = z.infer<typeof nodeRunSchema>;
export type DeliveryChecklist = z.infer<typeof checklistSchema>;
export type CompletenessReport = z.infer<typeof reportSchema>;
export type WaitRequest = z.infer<typeof waitSchema>;
export type ExecutionState = z.infer<typeof executionSchema>;
export type ExecutionOperation = z.infer<typeof operationSchema>;

export const emptyMetrics = () => ({
  modelCalls: 0,
  toolCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  modelMs: 0,
  toolMs: 0,
  lastRunMs: 0,
});
