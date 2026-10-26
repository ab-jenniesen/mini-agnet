import { validateWorkflow, type WorkflowDefinition } from '../../core/workflow/definition.js';
import type { NodeExecutorCatalog } from './types.js';

export function validateExecutors(
  definition: WorkflowDefinition,
  catalog: NodeExecutorCatalog,
): WorkflowDefinition {
  const workflow = validateWorkflow(definition);
  for (const node of workflow.nodes) {
    if (node.type !== 'human') catalog.get(node.config.executor ?? node.type);
  }
  return workflow;
}
