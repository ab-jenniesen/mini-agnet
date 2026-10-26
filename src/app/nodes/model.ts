import { finishReason } from '../../core/model/completion.js';
import type { NodeExecutor } from './types.js';

export const executeModelNode: NodeExecutor = async (context) => {
  const reply = await context.runModel();
  if (reply.toolCalls.length || !reply.content?.trim())
    throw new Error('Model node requires a final text response');
  return {
    outputs: { text: reply.content },
    completion: {
      finishReason: reply.finishReason ?? finishReason(reply.rawFinishReason, 0),
      rawFinishReason: reply.rawFinishReason,
    },
  };
};
