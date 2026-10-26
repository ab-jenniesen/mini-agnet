import { reportSchema, type CompletenessReport, type DeliveryChecklist } from './types.js';

/** A checker supplies observations. The kernel validates ownership and derives completeness. */
export function validateCompletenessReport(
  value: CompletenessReport,
  scope: { taskId: string; runId: string; goalRevision: number },
  checklist: DeliveryChecklist,
): CompletenessReport {
  const report = reportSchema.parse(value);
  if (
    report.taskId !== scope.taskId ||
    report.runId !== scope.runId ||
    report.goalRevision !== scope.goalRevision ||
    report.checklistVersion !== checklist.version
  )
    throw new Error('Checker returned a report for a different task, run or checklist');
  if (checklist.mode === 'response') {
    if (report.items.length || report.status !== 'not_applicable')
      throw new Error('Response delivery must mark file acceptance not applicable');
    return report;
  }
  if (!checklist.files.length || report.items.length !== checklist.files.length)
    throw new Error('Checker must report every required file exactly once');
  const seen = new Set<string>();
  for (const item of report.items) {
    const required = checklist.files.find((file) => file.id === item.itemId);
    if (!required || required.path !== item.path || seen.has(item.itemId))
      throw new Error('Checker returned a duplicate or unknown delivery item');
    if (item.status === 'present' && item.byteLength === undefined)
      throw new Error('Present files require an observed byte length');
    seen.add(item.itemId);
  }
  report.status = report.items.some((item) => item.status === 'error')
    ? 'error'
    : report.items.some((item) => item.status === 'missing')
      ? 'incomplete'
      : 'passed';
  return report;
}
