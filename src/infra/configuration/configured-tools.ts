import { readFile } from 'node:fs/promises';
import { z, type ZodTypeAny } from 'zod';
import type { ToolRegistryPort } from '../../core/tools/ports.js';
import { jsonSchema } from '../../core/workflow/definition.js';

type Parameter = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  properties?: Record<string, Parameter>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Parameter;
  enum?: string[];
};
const parameter: z.ZodType<Parameter> = z.lazy(() =>
  z
    .object({
      type: z.enum(['object', 'string', 'number', 'integer', 'boolean', 'array']),
      properties: z.record(parameter).optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.boolean().optional(),
      items: parameter.optional(),
      enum: z.array(z.string()).min(1).optional(),
    })
    .strict(),
);
const schema = z
  .array(
    z
      .object({
        name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
        description: z.string().min(1).max(4000),
        target: z.string().min(1),
        fixed: z.record(jsonSchema).default({}),
        parameters: parameter,
      })
      .strict(),
  )
  .max(100);

function validator(value: Parameter, depth = 0): ZodTypeAny {
  if (depth > 8) throw new Error('Custom tool parameter schema is too deep');
  if (value.enum && value.type !== 'string') throw new Error('Only string enums are supported');
  if (value.items && value.type !== 'array') throw new Error('items requires array type');
  if (
    (value.properties || value.required || value.additionalProperties !== undefined) &&
    value.type !== 'object'
  )
    throw new Error('Object schema keywords require object type');
  switch (value.type) {
    case 'string':
      return value.enum ? z.enum(value.enum as [string, ...string[]]) : z.string();
    case 'number':
      return z.number().finite();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'array':
      if (!value.items) throw new Error('Array parameters require items');
      return z.array(validator(value.items, depth + 1));
    case 'object': {
      const fields: Record<string, ZodTypeAny> = {};
      for (const key of value.required ?? [])
        if (!Object.hasOwn(value.properties ?? {}, key))
          throw new Error(`Unknown required parameter: ${key}`);
      for (const [key, property] of Object.entries(value.properties ?? {})) {
        if (['__proto__', 'prototype', 'constructor'].includes(key))
          throw new Error('Invalid parameter name');
        const item = validator(property, depth + 1);
        fields[key] = value.required?.includes(key) ? item : item.optional();
      }
      return value.additionalProperties === true
        ? z.object(fields).passthrough()
        : z.object(fields).strict();
    }
  }
}

/** Aliases keep the target tool's validation and permission policy. */
export async function registerConfiguredTools(
  registry: ToolRegistryPort,
  file: string,
): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const definitions = schema.parse(raw);
  const targets = new Set(registry.list().map((tool) => tool.name));
  for (const definition of definitions) {
    if (!targets.has(definition.target))
      throw new Error(`Custom tool target must already be registered: ${definition.target}`);
    if (definition.parameters.type !== 'object')
      throw new Error('Tool parameters must have object type');
    registry.register({
      name: definition.name,
      write: !!registry.list().find((tool) => tool.name === definition.target)?.write,
      description: definition.description,
      parameters: {
        ...definition.parameters,
        type: 'object',
        properties: definition.parameters.properties ?? {},
      },
      validator: validator(definition.parameters),
      delegate: { name: definition.target, fixed: definition.fixed },
      execute: async () => {
        throw new Error('Delegated tools are executed by the registry');
      },
    });
  }
}
