import type { AgentClient, RuntimeSnapshot } from '../app/contracts.js';
import { commands } from './commands.js';

export type CommandEffect =
  | { type: 'exit' | 'help' | 'providers' | 'close-output' }
  | { type: 'models'; provider: string }
  | { type: 'key'; provider: string }
  | { type: 'thinking'; mode?: 'on' | 'collapse' | 'off' }
  | { type: 'delete-session'; id: string }
  | { type: 'output'; id: string; offset: number }
  | { type: 'status'; text: string }
  | { type: 'panel'; title: string; text: string }
  | { type: 'run'; input: string };

/** Slash syntax belongs to clients. The application API uses structured commands. */
export async function routeInput(
  input: string,
  client: AgentClient,
  state: RuntimeSnapshot,
): Promise<CommandEffect> {
  const text = input.trim();
  const [command, ...args] = text.split(/\s+/);
  const rest = text.slice(command.length).trim();
  const panel = (content: string): CommandEffect => ({
    type: 'panel',
    title: command,
    text: content,
  });
  const status = (content: string): CommandEffect => ({ type: 'status', text: content });
  switch (command) {
    case '/exit':
      return { type: 'exit' };
    case '/help':
      return { type: 'help' };
    case '/model':
      if (!args[0]) return { type: 'providers' };
      if (!args[1]) return { type: 'models', provider: args[0] };
      await client.dispatch({ type: 'models.select', provider: args[0], model: args[1] });
      return status(`已切换到 ${args[0]}/${args[1]}`);
    case '/models':
      return { type: 'providers' };
    case '/refresh-models':
      return { type: 'models', provider: state.selection.provider };
    case '/key':
      if (!args[0]) throw new Error('用法：/key <provider>');
      return { type: 'key', provider: args[0] };
    case '/session':
      if (!rest)
        return panel(
          `当前会话：${state.id}\n可用会话：\n${(await client.dispatch({ type: 'sessions.list' })).join('\n')}`,
        );
      if (args[0] === 'delete') {
        if (args.length !== 2) throw new Error('用法：/session delete <id>');
        return { type: 'delete-session', id: args[1] };
      }
      if (args.length !== 1) throw new Error('用法：/session <id>');
      await client.dispatch({ type: 'sessions.switch', id: rest });
      return status(`已切换到会话 ${rest}`);
    case '/reset':
      await client.dispatch({ type: 'sessions.reset' });
      return status('当前对话和 Todo 已清空');
    case '/permission':
      if (!rest) return status(`当前权限：${state.permissionMode}`);
      if (rest !== 'read-only' && rest !== 'ask' && rest !== 'allow')
        throw new Error('用法：/permission read-only|ask|allow');
      await client.dispatch({ type: 'permissions.set', mode: rest });
      return status(`权限已切换为 ${rest}`);
    case '/dirs':
    case 'dirs': {
      const workspace = await client.dispatch({ type: 'workspace.status' });
      return panel(`主工作区：${workspace.root}\n可写目录：\n${workspace.writable.join('\n')}`);
    }
    case '/addDir':
    case 'addDir': {
      if (!rest) throw new Error('用法：/addDir <path>');
      const result = await client.dispatch({ type: 'workspace.grant', path: rest });
      return status(result.accepted ? `已授权：${result.path}` : '未授权目录写入');
    }
    case '/thinking':
      if (rest && rest !== 'on' && rest !== 'collapse' && rest !== 'off')
        throw new Error('用法：/thinking on|collapse|off');
      return { type: 'thinking', mode: rest || undefined } as CommandEffect;
    case '/todos':
      return panel(
        state.todos.map((todo) => `${todo.status} ${todo.title}`).join('\n') || '暂无待办',
      );
    case '/stats':
      return panel(JSON.stringify(state.metrics, null, 2));
    case '/tools':
      return panel((await client.dispatch({ type: 'tools.list' })).join('\n'));
    case '/memories':
      if (rest && rest !== 'project' && rest !== 'global')
        throw new Error('用法：/memories [project|global]');
      return panel(
        JSON.stringify(
          await client.dispatch({ type: 'memories.list', scope: rest || undefined } as {
            type: 'memories.list';
            scope?: 'project' | 'global';
          }),
          null,
          2,
        ),
      );
    case '/outputs':
      return panel(
        (await client.dispatch({ type: 'artifacts.list' }))
          .map((item) => `${item.name}: ${item.id}`)
          .join('\n') || '当前会话没有归档输出',
      );
    case '/output': {
      const offset = Number(args[1] ?? 0);
      if (!args[0] || !Number.isSafeInteger(offset) || offset < 0)
        throw new Error('用法：/output <id> [非负偏移]');
      return { type: 'output', id: args[0], offset };
    }
    case '/close-output':
      return { type: 'close-output' };
    default:
      if (command.startsWith('/')) throw new Error(`未知命令 ${command}，输入 /help 查看用法`);
      return { type: 'run', input };
  }
}

export function helpText(): string {
  return commands
    .map(
      (entry) =>
        `类型：${entry.type}\n命令：${entry.command}\n内容：${entry.detail}\n示例：${entry.example}`,
    )
    .join('\n\n');
}
