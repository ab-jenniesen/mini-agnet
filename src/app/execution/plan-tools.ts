import { z } from 'zod';
import type { RegisteredTool } from '../../core/tools/registry.js';
import type { GoalTask } from '../../core/execution/types.js';

/** Progress changes cannot alter the approved plan text or the delivery contract. */
export function planTools(task: GoalTask, checkpoint: () => Promise<void>): RegisteredTool[] {
  if (!task.plan) return [];
  const schema = z
    .object({
      stepId: z.string(),
      status: z.enum(['pending', 'running', 'completed', 'failed', 'skipped']),
    })
    .strict();
  return [
    {
      name: 'task_plan_update',
      description:
        'Update the status of an existing action-plan step. This does not mark the user goal complete or change acceptance.',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'running', 'completed', 'failed', 'skipped'],
          },
        },
        required: ['stepId', 'status'],
        additionalProperties: false,
      },
      validator: schema,
      execute: async (input) => {
        const value = schema.parse(input);
        const step = task.plan!.steps.find((item) => item.id === value.stepId);
        if (!step) throw new Error('Unknown plan step');
        step.status = value.status;
        await checkpoint();
        return { id: step.id, status: step.status };
      },
    },
  ];
}
