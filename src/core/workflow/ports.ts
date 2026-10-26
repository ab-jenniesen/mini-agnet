import type { WorkflowDefinition } from './definition.js';

export interface WorkflowCatalogPort {
  list(): WorkflowDefinition[];
  get(id: string): WorkflowDefinition;
  register(definition: WorkflowDefinition): Promise<WorkflowDefinition>;
}
