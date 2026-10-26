import { realpath, mkdir, lstat, readFile } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute, parse, join } from 'node:path';
import { atomicJson } from '../storage/atomic-json.js';
import { homedir } from 'node:os';

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};

/** One active project; outside files may be read, never written without an explicit grant. */
export class Workspace {
  readonly root: string;
  private readonly writable = new Set<string>();
  private constructor(
    root: string,
    private readonly grantsPath: string,
  ) {
    this.root = root;
    this.writable.add(root);
  }
  static async create(root: string, grantsPath?: string): Promise<Workspace> {
    // Never create the launching project implicitly.
    const actual = await realpath(root);
    const ws = new Workspace(
      actual,
      grantsPath ?? resolve(actual, '.mini-agent/workspace-grants.json'),
    );
    try {
      const stored: unknown = JSON.parse(await readFile(ws.grantsPath, 'utf8'));
      if (Array.isArray(stored))
        for (const path of stored) {
          if (typeof path !== 'string' || !isAbsolute(path)) continue;
          try {
            if ((await realpath(path)) === path && (await lstat(path)).isDirectory())
              ws.writable.add(path);
          } catch {
            /* removed grants are ignored */
          }
        }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    return ws;
  }
  /** Resolve paths relative to launch directory; absolute paths are allowed for READ operations. No symlink traversals. */
  async safePath(file: string): Promise<string> {
    if (!file || file.includes('\0')) throw new Error('Invalid path');
    const target = resolve(this.root, file);
    // Inspect all components from filesystem root, not just from workspace.
    const absolute = resolve(target);
    let current = parse(absolute).root;
    for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error(`Symlink access denied: ${current}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    return target;
  }
  async writablePath(file: string): Promise<string> {
    const path = await this.safePath(file);
    if (
      inside(resolve(homedir(), '.config/mini-agent'), path) ||
      inside(resolve(this.root, '.agent-state'), path) ||
      inside(resolve(this.root, '.mini-agent'), path)
    )
      throw new Error('PROTECTED_STATE: Agent file tools cannot modify private Agent state');
    if (![...this.writable].some((dir) => inside(dir, path)))
      throw new Error(
        'WRITE_SCOPE_DENIED: directory has not been granted; use /addDir or request_write_directory',
      );
    return path;
  }
  listWritable(): string[] {
    return [...this.writable].sort();
  }
  isWritable(path: string): boolean {
    const target = resolve(this.root, path);
    return [...this.writable].some((dir) => inside(dir, target));
  }
  async addDirectory(path: string, createIfMissing: boolean): Promise<string> {
    const target = await this.safePath(path);
    try {
      const info = await lstat(target);
      if (!info.isDirectory()) throw new Error('The requested path exists but is not a directory');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      if (!createIfMissing)
        throw new Error('DIRECTORY_MISSING: request creation approval to create this directory');
      await mkdir(target, { recursive: true });
    }
    const real = await realpath(target);
    if (real !== target) throw new Error('Directory changed or resolves through symlinks');
    const next = [...new Set([...this.writable, real])].filter((path) => path !== this.root).sort();
    await atomicJson(this.grantsPath, next);
    this.writable.add(real);
    return real;
  }
}
