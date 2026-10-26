import { readFile } from 'node:fs/promises';
import {
  defaultWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
} from '../../core/workflow/definition.js';
import { atomicJson } from '../storage/atomic-json.js';

/** Only validated definitions are loaded. Configuration never evaluates JavaScript. */
export class WorkflowLibrary {
  private definitions = new Map<string, WorkflowDefinition>([
    [defaultWorkflow.id, defaultWorkflow],
  ]);
  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!Array.isArray(value))
        throw new Error('workflows.json must contain an array of workflows');
      const definitions = value.map(validateWorkflow);
      const ids = new Set(definitions.map((item) => item.id));
      if (ids.size !== definitions.length) throw new Error('Duplicate workflow IDs');
      this.definitions = new Map([
        [defaultWorkflow.id, defaultWorkflow],
        ...definitions.map((item) => [item.id, item] as const),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list(): WorkflowDefinition[] {
    return structuredClone([...this.definitions.values()]);
  }
  get(id: string): WorkflowDefinition {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown workflow: ${id}`);
    return structuredClone(definition);
  }
  async register(value: unknown): Promise<WorkflowDefinition> {
    const definition = validateWorkflow(value);
    const old = this.definitions.get(definition.id);
    if (old && definition.version <= old.version)
      throw new Error('A workflow update must increase its version');
    const next = new Map(this.definitions).set(definition.id, definition);
    await atomicJson(this.file, [...next.values()]);
    this.definitions = next;
    return structuredClone(definition);
  }
}
