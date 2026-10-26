import { jsonSchema } from '../../core/workflow/definition.js';
import type { Json } from '../../core/workflow/definition.js';
import type { NodeExecutor } from './types.js';

export const executeToolNode: NodeExecutor = async (context) => {
  const text = await context.runTool();
  let value: Json = text;
  try {
    value = jsonSchema.parse(JSON.parse(text));
  } catch {
    // Plain text is a valid tool output.
  }
  return { outputs: { value, text } };
};
