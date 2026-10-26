import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { contextSettingsSchema } from '../../core/context/settings.js';
const schema = z
  .object({
    schemaVersion: z.number().int().optional(),
    context: contextSettingsSchema.optional(),
  })
  .strict();
export type AgentSettings = z.infer<typeof schema>;
async function read(file: string): Promise<AgentSettings> {
  try {
    return schema.parse(JSON.parse(await readFile(file, 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
}
export async function loadLayeredSettings(
  projectFile: string,
  globalFile = join(homedir(), '.config', 'mini-agent', 'settings.json'),
): Promise<AgentSettings> {
  const global = await read(globalFile),
    project = await read(projectFile);
  return { ...global, ...project, context: { ...global.context, ...project.context } };
}
