import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { executionSchema, type ExecutionState } from '../../core/execution/types.js';
import { atomicJson } from './atomic-json.js';
import { validateWorkflow } from '../../core/workflow/definition.js';

function validateLinks(value: ExecutionState): ExecutionState {
  const unique = (ids: string[], label: string): void => {
    if (new Set(ids).size !== ids.length)
      throw new Error(`Duplicate ${label} identity in execution store`);
  };
  for (const [label, records] of Object.entries({
    tasks: value.tasks,
    runs: value.runs,
    nodes: value.nodes,
    reports: value.reports,
    waits: value.waits,
    artifacts: value.artifacts,
  }))
    unique(
      records.map((record) => record.id),
      label,
    );
  const tasks = new Map(value.tasks.map((task) => [task.id, task]));
  const runs = new Map(value.runs.map((run) => [run.id, run]));
  const nodes = new Map(value.nodes.map((node) => [node.id, node]));
  if (value.selectedTaskId && !tasks.has(value.selectedTaskId))
    throw new Error('Selected task does not exist');
  for (const task of value.tasks) {
    validateWorkflow(task.workflow);
    if (
      task.sessionId !== value.session.id ||
      task.runIds.some((id) => runs.get(id)?.taskId !== task.id)
    )
      throw new Error('Task/session/run ownership mismatch');
    if (task.activeRunId && runs.get(task.activeRunId)?.taskId !== task.id)
      throw new Error('Active run ownership mismatch');
    if (task.checklist && task.checklist.taskId !== task.id)
      throw new Error('Checklist ownership mismatch');
  }
  for (const run of value.runs) {
    validateWorkflow(run.workflow);
    if (run.sessionId !== value.session.id || !tasks.get(run.taskId)?.runIds.includes(run.id))
      throw new Error('Run ownership mismatch');
    if (run.nodeRunIds.some((id) => nodes.get(id)?.runId !== run.id))
      throw new Error('Node/run ownership mismatch');
    if (run.currentNodeRunId && nodes.get(run.currentNodeRunId)?.runId !== run.id)
      throw new Error('Active node ownership mismatch');
  }
  for (const record of [
    ...value.nodes,
    ...value.reports,
    ...value.waits,
    ...value.artifacts,
    ...value.operations,
  ])
    if (runs.get(record.runId)?.taskId !== record.taskId)
      throw new Error('Execution record ownership mismatch');
  return value;
}

/** One atomic manifest per session keeps goals, runs, nodes and reports at one commit. */
export class ExecutionStore {
  private writes: Promise<void> = Promise.resolve();
  constructor(
    private readonly file: string,
    private readonly sessionId: string,
  ) {}

  async load(): Promise<ExecutionState> {
    try {
      const value = executionSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
      if (value.session.id !== this.sessionId) throw new Error('Execution session mismatch');
      return validateLinks(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const now = new Date().toISOString();
      return {
        schemaVersion: 1,
        generationId: randomUUID(),
        revision: 0,
        session: { id: this.sessionId, status: 'open', createdAt: now, updatedAt: now },
        selectedWorkflowId: 'general',
        history: [],
        tasks: [],
        runs: [],
        nodes: [],
        reports: [],
        waits: [],
        artifacts: [],
        operations: [],
      };
    }
  }

  save(state: ExecutionState): Promise<ExecutionState> {
    state.revision++;
    state.session.updatedAt = new Date().toISOString();
    const snapshot = executionSchema.parse(structuredClone(state));
    const write = this.writes.then(async () => {
      await atomicJson(this.file, snapshot);
      return snapshot;
    });
    this.writes = write.then(
      () => {},
      () => {},
    );
    return write;
  }

  async flush(): Promise<void> {
    await this.writes;
  }
}
