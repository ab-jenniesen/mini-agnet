import type { TaskSnapshot } from '../app/tasks.js';

export const taskLabels = {
  running: '运行中',
  waiting_approval: '等待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  blocked: '受阻',
};
const verificationLabels = { not_run: '未验证', passed: '检查通过', failed: '检查失败' };

export function taskStatusText(task: TaskSnapshot): string {
  const result = task.result;
  const details =
    result && (result.changes.length || result.verification.checks.length)
      ? ` · 修改 ${result.changes.length} 个文件 · ${verificationLabels[result.verification.status]}`
      : '';
  return `任务${taskLabels[task.status]}${details}`;
}

export function taskReport(task: TaskSnapshot | undefined): string {
  if (!task) return '当前会话还没有任务结果';
  const result = task.result;
  const lines = [
    `任务：${task.runId}`,
    `会话：${task.sessionId}`,
    `状态：${taskLabels[task.status]}`,
    `开始：${task.startedAt}`,
  ];
  if (!result) return lines.join('\n');
  lines.push(
    `结束：${result.finishedAt}`,
    `模型结束原因：${result.finishReason ?? '未提供'}${result.rawFinishReason ? `（${result.rawFinishReason}）` : ''}`,
    `验证：${verificationLabels[result.verification.status]}`,
    '',
    '修改文件：',
    ...result.changes.map((path) => `- ${path}`),
    '',
    '检查命令：',
    ...result.verification.checks.map(
      (check) =>
        `- ${check.command} ${check.args.join(' ')}\n  目录：${check.cwd} · 退出码：${check.exitCode} · ${check.ok ? '通过' : '失败'}\n  日志：${check.logPath}`,
    ),
    '',
    '未完成事项：',
    ...(result.remaining.length ? result.remaining.map((text) => `- ${text}`) : ['无已记录事项']),
    '',
    `模型调用：${result.metrics.modelCalls} · 工具调用：${result.metrics.toolCalls} · Token：${result.metrics.totalTokens}`,
  );
  return lines.join('\n');
}
