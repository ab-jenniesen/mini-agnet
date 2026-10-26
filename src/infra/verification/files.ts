import { randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Workspace } from '../workspace/files.js';
import type { DeliveryPort } from '../../core/execution/ports.js';
import type {
  CompletenessReport,
  DeliveryChecklist,
  GoalTask,
  WorkflowRun,
} from '../../core/execution/types.js';

export class FileDeliveryChecker implements DeliveryPort {
  constructor(private readonly workspace: Workspace) {}

  normalizePaths(files: string[]): Promise<string[]> {
    return deliveryPaths(this.workspace, files);
  }

  check(
    task: GoalTask,
    run: WorkflowRun,
    checklist: DeliveryChecklist,
  ): Promise<CompletenessReport> {
    return checkDeliveries(this.workspace, task, run, checklist);
  }
}

/** Resolve and validate targets before execution. Private runtime state cannot be a deliverable. */
export async function deliveryPaths(workspace: Workspace, files: string[]): Promise<string[]> {
  const normalized: string[] = [];
  for (const file of files) {
    if (isAbsolute(file))
      throw new Error('Delivery paths must be relative to the primary workspace');
    const path = await workspace.writablePath(file);
    const local = relative(workspace.root, path);
    if (!local || local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error(`Delivery path escapes primary workspace: ${file}`);
    const key = process.platform === 'win32' ? local.toLowerCase() : local;
    if (
      normalized.some((item) => (process.platform === 'win32' ? item.toLowerCase() : item) === key)
    )
      throw new Error(`Duplicate delivery target: ${file}`);
    normalized.push(local);
  }
  return normalized;
}

export async function checkDeliveries(
  workspace: Workspace,
  task: GoalTask,
  run: WorkflowRun,
  checklist: DeliveryChecklist,
): Promise<CompletenessReport> {
  const report: CompletenessReport = {
    id: randomUUID(),
    taskId: task.id,
    runId: run.id,
    checklistVersion: checklist.version,
    goalRevision: run.goalRevision,
    checkedAt: new Date().toISOString(),
    status: checklist.mode === 'response' ? 'not_applicable' : 'passed',
    items: [],
  };
  if (checklist.mode === 'response') return report;
  if (!checklist.files.length) throw new Error('An empty file checklist cannot pass acceptance');
  for (const item of checklist.files) {
    try {
      const path = await workspace.safePath(item.path);
      if (resolve(workspace.root, item.path) !== path) throw new Error('Delivery path changed');
      const info = await lstat(path);
      if (!info.isFile()) throw new Error('Delivery target is not a regular file');
      report.items.push({
        itemId: item.id,
        path: item.path,
        status: 'present',
        byteLength: info.size,
      });
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      report.items.push({
        itemId: item.id,
        path: item.path,
        status: missing ? 'missing' : 'error',
        ...(missing ? {} : { error: String(error) }),
      });
    }
  }
  report.status = report.items.some((item) => item.status === 'error')
    ? 'error'
    : report.items.some((item) => item.status === 'missing')
      ? 'incomplete'
      : 'passed';
  return report;
}
