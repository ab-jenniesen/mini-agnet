import { z } from 'zod';

/** Shared configuration contract for files and client commands. */
export const contextSettingsSchema = z
  .object({
    maxInputTokens: z.number().int().min(1024).optional(),
    reservedOutputTokens: z.number().int().positive().optional(),
    recentTurns: z.number().int().nonnegative().optional(),
    maxToolResultTokens: z.number().int().nonnegative().optional(),
    maxMemoryTokens: z.number().int().nonnegative().optional(),
    memoryLimit: z.number().int().min(0).max(20).optional(),
    summarize: z.boolean().optional(),
    compactThreshold: z.number().min(0.2).max(1).optional(),
    safetyMargin: z.number().min(0).max(0.49).optional(),
    applyMemory: z.boolean().optional(),
    generateMemory: z.boolean().optional(),
    warnThreshold: z.number().min(0.1).max(1).optional(),
    showWarnings: z.boolean().optional(),
    overflowBehavior: z.enum(['trim', 'error']).optional(),
  })
  .strict();

export type ContextSettings = z.infer<typeof contextSettingsSchema>;
