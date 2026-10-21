export type CommandEntry = {
  type: string;
  command: string;
  example: string;
  detail: string;
  completion: string;
};

// Keep the help panel and the input suggestions in sync with TUI commands.
export const commands: CommandEntry[] = [
  {
    type: '模型',
    command: '/model [provider] [model-id]',
    example: '/model deepseek deepseek-chat',
    detail: '选择供应商和模型',
    completion: '/model ',
  },
  {
    type: '模型',
    command: '/models',
    example: '/models',
    detail: '打开供应商列表',
    completion: '/models',
  },
  {
    type: '模型',
    command: '/refresh-models',
    example: '/refresh-models',
    detail: '刷新当前供应商的模型列表',
    completion: '/refresh-models',
  },
  {
    type: '模型',
    command: '/key <provider>',
    example: '/key openai',
    detail: '配置 API Key',
    completion: '/key ',
  },
  {
    type: '会话',
    command: '/session',
    example: '/session',
    detail: '列出当前项目的会话',
    completion: '/session',
  },
  {
    type: '会话',
    command: '/session <id>',
    example: '/session feature_work',
    detail: '切换或创建会话',
    completion: '/session ',
  },
  {
    type: '会话',
    command: '/session delete <id>',
    example: '/session delete feature_work',
    detail: '确认后删除会话及其专属数据',
    completion: '/session delete ',
  },
  {
    type: '权限',
    command: '/permission [read-only|ask|allow]',
    example: '/permission ask',
    detail: '查看或切换写入权限',
    completion: '/permission ',
  },
  { type: '权限', command: '/dirs', example: '/dirs', detail: '查看可写目录', completion: '/dirs' },
  {
    type: '权限',
    command: '/addDir <path>',
    example: '/addDir ../shared',
    detail: '申请可写目录',
    completion: '/addDir ',
  },
  {
    type: '显示',
    command: '/thinking [on|collapse|off]',
    example: '/thinking collapse',
    detail: '控制思考面板；Ctrl+T 循环切换',
    completion: '/thinking ',
  },
  {
    type: '任务',
    command: '/todos',
    example: '/todos',
    detail: '查看待办事项',
    completion: '/todos',
  },
  {
    type: '任务',
    command: '/stats',
    example: '/stats',
    detail: '查看运行统计',
    completion: '/stats',
  },
  {
    type: '任务',
    command: '/tools',
    example: '/tools',
    detail: '查看已注册工具',
    completion: '/tools',
  },
  {
    type: '记忆',
    command: '/memories [project|global]',
    example: '/memories project',
    detail: '查看长期记忆',
    completion: '/memories ',
  },
  {
    type: '输出',
    command: '/outputs',
    example: '/outputs',
    detail: '列出归档工具输出',
    completion: '/outputs',
  },
  {
    type: '输出',
    command: '/output <id> [offset]',
    example: '/output 11111111-1111-4111-8111-111111111111 3000',
    detail: '查看归档工具输出',
    completion: '/output ',
  },
  {
    type: '输出',
    command: '/close-output',
    example: '/close-output',
    detail: '关闭归档输出面板',
    completion: '/close-output',
  },
  {
    type: '会话',
    command: '/reset',
    example: '/reset',
    detail: '清空当前对话和 Todo，保留长期记忆',
    completion: '/reset',
  },
  { type: '通用', command: '/help', example: '/help', detail: '显示命令帮助', completion: '/help' },
  { type: '通用', command: '/exit', example: '/exit', detail: '退出', completion: '/exit' },
];

export function commandSuggestions(draft: string): CommandEntry[] {
  if (!draft.startsWith('/') || draft.includes('\n')) return [];
  const query = draft.toLowerCase();
  return commands.filter((entry) => entry.completion.toLowerCase().startsWith(query));
}
