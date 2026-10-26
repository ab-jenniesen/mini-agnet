import { executeAgentNode } from './agent.js';
import { executeModelNode } from './model.js';
import { executeToolNode } from './tool.js';
import type { NodeExecutor, NodeExecutorCatalog } from './types.js';

export function createNodeExecutors(
  extensions: Record<string, NodeExecutor> = {},
): NodeExecutorCatalog {
  const entries = new Map<string, NodeExecutor>([
    ['agent', executeAgentNode],
    ['model', executeModelNode],
    ['tool', executeToolNode],
  ]);
  for (const [name, executor] of Object.entries(extensions)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name) || name === 'human')
      throw new Error(`Invalid node executor name: ${name}`);
    entries.set(name, executor);
  }
  return {
    get(name) {
      const executor = entries.get(name);
      if (!executor) throw new Error(`Unknown node executor: ${name}`);
      return executor;
    },
    names: () => [...entries.keys()],
  };
}
