import { z } from 'zod';

const usageSchema = z.object({
  promptTokens: z.number().nonnegative().finite(),
  completionTokens: z.number().nonnegative().finite(),
  totalTokens: z.number().nonnegative().finite(),
  estimated: z.boolean().optional(),
  partial: z.boolean().optional(),
});
export const messageSchema = z.union([
  z.object({ role: z.enum(['system', 'user']), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().nullable(),
    usage: usageSchema.optional(),
    thinkingMs: z.number().nonnegative().finite().optional(),
    finishReason: z
      .enum(['stop', 'tool_calls', 'length', 'blocked', 'pause', 'error', 'unknown'])
      .optional(),
    rawFinishReason: z.string().optional(),
    tool_calls: z
      .array(
        z.object({
          id: z.string().min(1),
          type: z.literal('function'),
          function: z.object({ name: z.string().min(1), arguments: z.string() }),
        }),
      )
      .optional(),
  }),
  z.object({ role: z.literal('tool'), tool_call_id: z.string().min(1), content: z.string() }),
]);
