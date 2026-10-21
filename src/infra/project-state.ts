import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';

/** All runtime paths belong to the primary launch directory, never to granted auxiliary directories. */
export class ProjectState {
  readonly root: string;
  readonly directory: string;
  private constructor(root: string) {
    this.root = root;
    this.directory = join(root, '.mini-agent');
  }
  static async open(root: string): Promise<ProjectState> {
    const state = new ProjectState(resolve(root));
    await mkdir(state.directory, { recursive: true, mode: 0o700 });
    await mkdir(state.path('sessions'), { recursive: true, mode: 0o700 });
    await mkdir(state.path('skills'), { recursive: true, mode: 0o700 });
    await mkdir(state.path('artifacts'), { recursive: true, mode: 0o700 });
    await mkdir(state.path('compactions'), { recursive: true, mode: 0o700 });
    await mkdir(state.path('journals'), { recursive: true, mode: 0o700 });
    await mkdir(state.path('todos'), { recursive: true, mode: 0o700 });
    await mkdir(state.path('approvals'), { recursive: true, mode: 0o700 });
    await ensureFile(state.path('.gitignore'), '*\n!.gitignore\n');
    await ensureFile(
      state.path('PROJECT.md'),
      '# Project Instructions\n\nDescribe project structure and coding conventions here.\n',
    );
    await ensureFile(state.path('mcp.json'), JSON.stringify({ servers: {} }, null, 2) + '\n');
    await ensureFile(
      state.path('settings.json'),
      JSON.stringify({ schemaVersion: 1 }, null, 2) + '\n',
    );
    return state;
  }
  path(...segments: string[]): string {
    return join(this.directory, ...segments);
  }
  session(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('Invalid session ID');
    return this.path('sessions', `${id}.json`);
  }
  async deleteSession(id: string): Promise<void> {
    this.session(id); // Validate the ID before building any path.
    for (const [directory, extension] of [
      ['todos', '.json'],
      ['compactions', '.json'],
      ['journals', '.json'],
      ['approvals', '.jsonl'],
      ['sessions', '.json'],
    ] as const)
      await rm(this.path(directory, `${id}${extension}`), { force: true });
  }
  async instructions(): Promise<string> {
    return readFile(this.path('PROJECT.md'), 'utf8');
  }
}
async function ensureFile(file: string, content: string): Promise<void> {
  try {
    await writeFile(file, content, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}
