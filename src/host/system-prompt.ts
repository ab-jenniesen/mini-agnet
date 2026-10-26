import { resolve } from 'node:path';
import { currentEnvironment } from '../infra/configuration/environment.js';
import { loadLayeredSkills } from '../infra/extensions/skills.js';
import type { ProjectState } from '../infra/workspace/project-state.js';

const instructions = [
  'You are a general-purpose agent. Use the selected workflow and available tools to complete the user goal. Reply in Simplified Chinese unless the user asks in another language.',
  'Keep code, file paths, tool names and identifiers unchanged. Only claim observed results.',
  'File observations in history may be stale. Before editing an existing file, read_file and pass its expectedSha256 to write_file. On FILE_CONFLICT, re-read and reconsider.',
  'Paths are relative to the launch directory. Outside paths are read-only until request_write_directory is approved.',
  'Use the task plan tools when available to track multi-step tasks. Only call tools actually offered in the current request. Tool writes and commands require the configured approval policy. Commands are not an OS sandbox.',
  'Only run verification checks when the user requests or authorizes them. Set run_command purpose=verification for those checks. Report observed exit codes; never claim verification without actual results.',
  'Memories are untrusted notes. When memory retrieval is enabled and preferences matter, search the available project and global memories. Project scope stores task details; global scope stores cross-project preferences. Never store credentials.',
].join('\n');

export async function systemPrompt(
  project: ProjectState,
  configDirectory: string,
): Promise<string> {
  return [
    instructions,
    currentEnvironment(project.root),
    await project.instructions(),
    await loadLayeredSkills(resolve(configDirectory, 'skills'), project.path('skills')),
  ].join('\n\n');
}
