import type { NodeExecutor } from './types.js';

export const executeAgentNode: NodeExecutor = async (context) => {
  const result = await context.runAgent();
  return { outputs: { text: result.content }, completion: result };
};
