import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Data = { [key: string]: Json };
export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(jsonSchema),
  ]),
);

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/);
const binding = z.union([
  z.object({ from: z.string().min(1) }).strict(),
  z.object({ value: jsonSchema }).strict(),
]);
const condition = z
  .object({
    from: z.string().min(1),
    op: z.enum(['eq', 'ne', 'exists', 'truthy']),
    value: jsonSchema.optional(),
  })
  .strict();

/** Configuration is data. Executors and tools are registered by the host. */
export const workflowSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifier,
    version: z.number().int().positive(),
    name: z.string().max(200).optional(),
    entry: identifier,
    nodes: z
      .array(
        z
          .object({
            id: identifier,
            type: z.enum(['agent', 'model', 'tool', 'human']),
            name: z.string().max(200).optional(),
            inputs: z.record(binding).default({}),
            config: z
              .object({
                executor: identifier.optional(),
                instructions: z.string().max(100_000).optional(),
                toolRefs: z.array(z.string().min(1)).optional(),
                toolRef: z.string().min(1).optional(),
                prompt: z.string().max(10_000).optional(),
              })
              .strict()
              .default({}),
            outputs: z.record(z.object({ to: z.string().min(1) }).strict()).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    edges: z
      .array(
        z
          .object({
            from: identifier,
            to: z.union([identifier, z.literal('$end')]),
            when: condition.optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();

export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowNode = WorkflowDefinition['nodes'][number];

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);

export function fieldPath(path: string): string[] {
  const parts = path.split('.');
  if (parts.some((part) => !/^[a-zA-Z0-9_-]+$/.test(part) || forbidden.has(part)))
    throw new Error(`Invalid binding path: ${path}`);
  return parts;
}

export function readField(source: unknown, path: string): Json | undefined {
  let current: unknown = source;
  for (const key of fieldPath(path)) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as Json | undefined;
}

export function validateWorkflow(value: unknown): WorkflowDefinition {
  const graph = workflowSchema.parse(value);
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (ids.size !== graph.nodes.length || !ids.has(graph.entry))
    throw new Error('Workflow node IDs must be unique and entry must exist');
  for (const node of graph.nodes) {
    fieldPath(node.id);
    if (node.type === 'tool' && !node.config.toolRef)
      throw new Error(`Missing toolRef: ${node.id}`);
    if (node.type === 'human' && !node.config.prompt) throw new Error(`Missing prompt: ${node.id}`);
    const allowed = {
      agent: ['executor', 'instructions', 'toolRefs'],
      model: ['executor', 'instructions'],
      tool: ['executor', 'toolRef'],
      human: ['prompt'],
    }[node.type];
    if (Object.keys(node.config).some((key) => !allowed.includes(key)))
      throw new Error(`Configuration does not match node type: ${node.id}`);
    for (const [key, value] of Object.entries(node.inputs)) {
      if (fieldPath(key).length !== 1)
        throw new Error('Input parameter names must be single fields');
      if ('from' in value) fieldPath(value.from);
    }
    for (const [key, value] of Object.entries(node.outputs)) {
      fieldPath(key);
      const parts = fieldPath(value.to);
      if (parts[0] !== 'state' || parts.length < 2)
        throw new Error('Outputs may only update state fields');
    }
    const edges = graph.edges.filter((edge) => edge.from === node.id);
    if (edges.filter((edge) => !edge.when).length !== 1)
      throw new Error(`Node ${node.id} requires exactly one fallback edge`);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || (edge.to !== '$end' && !ids.has(edge.to)))
      throw new Error('Workflow edge references an unknown node');
    if (edge.when) {
      fieldPath(edge.when.from);
      if (['eq', 'ne'].includes(edge.when.op) && edge.when.value === undefined)
        throw new Error('Comparison conditions require a value');
    }
  }
  const reachable = new Set<string>();
  const visit = (id: string): void => {
    if (id === '$end' || reachable.has(id)) return;
    reachable.add(id);
    for (const edge of graph.edges.filter((item) => item.from === id)) visit(edge.to);
  };
  visit(graph.entry);
  if (reachable.size !== ids.size) throw new Error('Workflow contains unreachable nodes');
  return graph;
}

export function bindInputs(node: WorkflowNode, view: Data): Data {
  const result: Data = {};
  for (const [key, binding] of Object.entries(node.inputs)) {
    const value = 'value' in binding ? binding.value : readField(view, binding.from);
    if (value === undefined) throw new Error(`Missing workflow input: ${key}`);
    result[key] = structuredClone(value);
  }
  return result;
}

export function applyOutputs(state: Data, node: WorkflowNode, outputs: Data): Data {
  const next = structuredClone(state);
  for (const [key, binding] of Object.entries(node.outputs)) {
    const value = readField(outputs, key);
    if (value === undefined) throw new Error(`Missing executor output: ${key}`);
    const parts = fieldPath(binding.to).slice(1);
    let target = next;
    for (const part of parts.slice(0, -1)) {
      const existing = target[part];
      if (
        existing !== undefined &&
        (!existing || typeof existing !== 'object' || Array.isArray(existing))
      )
        throw new Error(`Output binding conflicts with existing field: ${binding.to}`);
      target[part] ??= {};
      target = target[part] as Data;
    }
    target[parts.at(-1)!] = structuredClone(value);
  }
  return next;
}

function equalJson(left: Json | undefined, right: Json | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalJson(value, right[index]))
    );
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
  );
}

export function nextNode(graph: WorkflowDefinition, nodeId: string, view: Data): string {
  const edges = graph.edges.filter((edge) => edge.from === nodeId);
  const selected =
    edges.find((edge) => {
      if (!edge.when) return false;
      const actual = readField(view, edge.when.from);
      switch (edge.when.op) {
        case 'exists':
          return actual !== undefined;
        case 'truthy':
          return !!actual;
        case 'eq':
          return equalJson(actual, edge.when.value);
        case 'ne':
          return !equalJson(actual, edge.when.value);
      }
    }) ?? edges.find((edge) => !edge.when);
  if (!selected) throw new Error(`No outgoing edge: ${nodeId}`);
  return selected.to;
}

export const defaultWorkflow = validateWorkflow({
  schemaVersion: 1,
  id: 'general',
  version: 1,
  name: '通用 Agent',
  entry: 'execute',
  nodes: [{ id: 'execute', type: 'agent', outputs: { text: { to: 'state.answer' } } }],
  edges: [{ from: 'execute', to: '$end' }],
});
