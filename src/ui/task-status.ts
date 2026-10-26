import type { TaskSnapshot } from '../protocol/index.js';

export const taskLabels = {
  running: '运行中',
  waiting_approval: '等待审批',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  blocked: '受阻',
  waiting: '等待输入',
  paused: '已暂停',
  interrupted: '中断待恢复',
};
const verificationLabels = {
  not_run: '未执行命令验证',
  passed: '命令检查通过',
  failed: '命令检查失败',
};

export function taskStatusText(task: TaskSnapshot): string {
  const result = task.result;
  const details =
    result && (result.changes.length || result.verification.checks.length)
      ? ` · 修改 ${result.changes.length} 个文件 · ${verificationLabels[result.verification.status]}`
      : '';
  const completeness = result?.completeness;
  const checked =
    completeness?.status === 'passed'
      ? ' · 交付文件齐全'
      : completeness?.status === 'not_applicable'
        ? ' · 纯回复，无文件验收'
        : '';
  return `执行${taskLabels[task.status]}${task.phase ? ` · ${task.phase}` : ''}${checked}${details}`;
}

export function taskReport(task: TaskSnapshot | undefined): string {
  if (!task) return '当前会话还没有任务结果';
  const result = task.result;
  const lines = [
    `执行：${task.runId}`,
    ...(task.taskId ? [`目标 ID：${task.taskId}`] : []),
    ...(task.phase ? [`阶段：${task.phase}`] : []),
    `会话：${task.sessionId}`,
    `状态：${taskLabels[task.status]}`,
    `开始：${task.startedAt}`,
  ];
  if (!result) return lines.join('\n');
  lines.push(
    `结束：${result.finishedAt ?? '尚未结束'}`,
    `模型结束原因：${result.finishReason ?? '未提供'}${result.rawFinishReason ? `（${result.rawFinishReason}）` : ''}`,
    `验证：${verificationLabels[result.verification.status]}`,
    `交付完整性：${result.completeness?.status ?? '旧版记录'}（文件齐全不代表内容正确）`,
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
