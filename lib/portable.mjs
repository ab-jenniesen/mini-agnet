import { readFile, writeFile, mkdir, readdir, lstat, realpath, rm } from 'node:fs/promises';
import { resolve, join, relative, dirname, sep, isAbsolute, parse } from 'node:path';
import { homedir, platform, arch, release } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const MAX_ITEMS = 12000;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const safeRelative = (p) =>
  typeof p === 'string' &&
  p.length > 0 &&
  p.length < 1024 &&
  !p.includes('\\') &&
  !/[<>:"|?*]/.test(p) &&
  !p.includes('\0') &&
  !p.split('/').some((x) => x === '' || x === '.' || x === '..') &&
  !p.startsWith('/');
const known = [
  'PROJECT.md',
  'settings.json',
  'mcp.json',
  'memories.json',
  'skills',
  'sessions',
  'compactions',
  'todos',
  'artifacts',
  'journals',
  'tasks',
  'executions',
  'workflows.json',
  'tools.json',
  'approvals',
  'workspace-grants.json',
];
const secretPattern =
  /(?:sk-[A-Za-z0-9_-]{24,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9_]{30,}|(?:api[_-]?key|access[_-]?token|secret[_-]?key|password)\s*[=:]\s*['\"]?[A-Za-z0-9_./+\-=]{20,})/i;
const sensitive = (name) =>
  /(^|\/)(credentials\.json|\.env(?:\..*)?|id_rsa|id_ed25519|.*\.pem|.*\.key)$/i.test(name);
async function collect(root) {
  const items = [];
  let size = 0;
  async function walk(absolute, name) {
    if (!safeRelative(name) || sensitive(name)) return;
    const s = await lstat(absolute);
    if (s.isSymbolicLink()) throw Error(`Symlinks cannot be exported: ${name}`);
    if (s.isDirectory()) {
      const names = await readdir(absolute);
      for (const child of names) {
        if (child === '.gitignore') continue;
        await walk(join(absolute, child), `${name}/${child}`);
      }
      return;
    }
    if (!s.isFile()) return;
    if (s.size > MAX_FILE) throw Error(`Export file too large: ${name}`);
    size += s.size;
    if (size > MAX_TOTAL || items.length >= MAX_ITEMS)
      throw Error('Export exceeds size/file count limit');
    const data = await readFile(absolute);
    items.push({
      path: name,
      sha256: sha256(data),
      bytes: data.length,
      data: data.toString('base64'),
    });
  }
  for (const name of known) {
    try {
      await walk(join(root, name), name);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return items;
}
export async function exportBundle({
  cwd = process.cwd(),
  out,
  includeGlobal = false,
  allowSensitive = false,
}) {
  const project = await realpath(cwd);
  const root = join(project, '.mini-agent');
  const s = await lstat(root).catch(() => null);
  if (!s?.isDirectory())
    throw Error('No .mini-agent directory in current project; launch mini-agent once first');
  const files = (await collect(root)).map((x) => ({ ...x, path: `project/${x.path}` }));
  if (includeGlobal) {
    const globalRoot = join(homedir(), '.config', 'mini-agent');
    for (const x of await collectGlobal(globalRoot)) files.push({ ...x, path: `global/${x.path}` });
  }
  if (files.length > MAX_ITEMS || files.reduce((total, file) => total + file.bytes, 0) > MAX_TOTAL)
    throw Error('Export exceeds size/file count limit');
  // History/artifacts may contain pasted secrets even when credentials.json is excluded.
  const suspect = files
    .filter((x) => secretPattern.test(Buffer.from(x.data, 'base64').toString('utf8')))
    .map((x) => x.path);
  if (suspect.length && !allowSensitive)
    throw Error(
      `Potential secrets in: ${suspect.join(', ')}. Review and redact before export, or use --allow-sensitive after explicit review.`,
    );
  const manifest = {
    format: 'mini-agent-portable',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source: { platform: platform(), arch: arch(), node: process.version, release: release() },
    includesGlobal: includeGlobal,
    files,
  };
  const target = resolve(out ?? join(cwd, `mini-agent-export-${Date.now()}.magent`));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, gzipSync(Buffer.from(JSON.stringify(manifest))), {
    flag: 'wx',
    mode: 0o600,
  });
  return {
    target,
    count: files.length,
    bytes: files.reduce((n, f) => n + f.bytes, 0),
    includesGlobal: includeGlobal,
  };
}
async function collectGlobal(root) {
  const arr = [];
  for (const n of ['memories.json', 'settings.json', 'mcp.json', 'skills']) {
    try {
      const entries = await collectOne(root, n);
      arr.push(...entries);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return arr;
}
async function collectOne(root, name) {
  const out = [];
  async function walk(abs, p) {
    const s = await lstat(abs);
    if (s.isSymbolicLink()) throw Error('Refusing to export symlink');
    if (s.isDirectory()) {
      for (const c of await readdir(abs)) await walk(join(abs, c), `${p}/${c}`);
    } else if (s.isFile() && !sensitive(p)) {
      if (s.size > MAX_FILE) throw Error('File too large');
      const d = await readFile(abs);
      out.push({ path: p, sha256: sha256(d), bytes: d.length, data: d.toString('base64') });
    }
  }
  await walk(join(root, name), name);
  return out;
}
export async function inspectBundle(file) {
  const data = await readFile(resolve(file));
  if (data.length > MAX_TOTAL) throw Error('Bundle too large');
  const raw = gunzipSync(data, { maxOutputLength: MAX_TOTAL * 2 });
  const manifest = JSON.parse(raw.toString('utf8'));
  if (
    manifest?.format !== 'mini-agent-portable' ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > MAX_ITEMS
  )
    throw Error('Unsupported portable bundle');
  let bytes = 0;
  const seen = new Set();
  for (const x of manifest.files) {
    if (
      !safeRelative(x.path) ||
      !/^(project|global)\//.test(x.path) ||
      sensitive(x.path) ||
      seen.has(x.path)
    )
      throw Error(`Invalid archive path: ${x.path}`);
    seen.add(x.path);
    if (
      typeof x.data !== 'string' ||
      !/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(x.data)
    )
      throw Error('Invalid file encoding');
    const b = Buffer.from(x.data, 'base64');
    bytes += b.length;
    if (b.length !== x.bytes || b.length > MAX_FILE || bytes > MAX_TOTAL || sha256(b) !== x.sha256)
      throw Error(`Checksum or size mismatch: ${x.path}`);
  }
  return manifest;
}
// Validate each destination component, including its root. Never follow a symlink
// from an untrusted archive into another project or global directory.
async function assertSafeDestination(root, target) {
  const base = resolve(root);
  const rel = relative(base, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw Error('Destination escapes scope');
  const check = async (p) => {
    const st = await lstat(p).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (st?.isSymbolicLink()) throw Error(`Symlink destination denied: ${p}`);
    if (st && !st.isDirectory() && p !== target) throw Error(`Parent is not directory: ${p}`);
    return st;
  };
  let cur = parse(base).root;
  for (const part of base.slice(cur.length).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    await check(cur);
  }
  for (const part of rel.split(sep).filter(Boolean)) {
    cur = join(cur, part);
    await check(cur);
  }
}
function preparedContents(entry) {
  let bytes = Buffer.from(entry.data, 'base64');
  if (entry.path.endsWith('/mcp.json')) {
    const config = JSON.parse(bytes.toString('utf8'));
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      !config.servers ||
      typeof config.servers !== 'object' ||
      Array.isArray(config.servers)
    )
      throw Error(`Invalid MCP configuration: ${entry.path}`);
    for (const value of Object.values(config.servers)) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Invalid MCP server entry');
      value.enabled = false;
    }
    bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n');
  }
  if (entry.path.endsWith('/settings.json') || entry.path.endsWith('/memories.json'))
    JSON.parse(bytes.toString('utf8'));
  return bytes;
}
export async function importBundle({
  file,
  cwd = process.cwd(),
  includeGlobal = false,
  apply = false,
}) {
  const manifest = await inspectBundle(file);
  const project = await realpath(cwd);
  const projectRoot = join(project, '.mini-agent');
  const globalRoot = join(homedir(), '.config', 'mini-agent');
  const plan = [];
  const prepared = new Map();
  for (const entry of manifest.files) {
    const [scope, ...parts] = entry.path.split('/');
    if (scope === 'global' && !includeGlobal) continue;
    const rel = parts.join('/');
    const root = scope === 'project' ? projectRoot : globalRoot;
    if (!safeRelative(rel)) throw Error('Unsafe path');
    if (rel === 'workspace-grants.json') {
      const target = resolve(projectRoot, 'imported-workspace-grants.review.json');
      await assertSafeDestination(projectRoot, target);
      const exists = await lstat(target).catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      const action = exists ? 'exists-skip' : 'skipped-write-grants';
      plan.push({ path: entry.path, action, target });
      if (!exists) prepared.set(target, Buffer.from(entry.data, 'base64'));
      continue;
    }
    const target = resolve(root, rel);
    await assertSafeDestination(root, target);
    const previous = await lstat(target).catch((e) => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if (previous) {
      plan.push({ path: entry.path, action: 'exists-skip' });
      continue;
    }
    // Parse and transform all payloads before writing ANY destination file.
    const data = preparedContents(entry);
    prepared.set(target, data);
    plan.push({ path: entry.path, action: 'create', target });
  }
  if (!apply)
    return {
      source: manifest.source,
      plan,
      applied: false,
      skippedGlobal: manifest.includesGlobal && !includeGlobal,
    };
  // Stage all files first; every file is written with exclusive-create semantics.
  // On an application error, remove all files created by this import. We cannot
  // promise atomicity across process crashes or unrelated concurrent writers.
  const created = [];
  const staged = [];
  try {
    for (const [target, data] of prepared) {
      const parent = dirname(target);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const root = target.startsWith(projectRoot + sep) ? projectRoot : globalRoot;
      await assertSafeDestination(root, target);
      const temp = join(parent, `.mini-agent-import-${randomUUID()}.tmp`);
      await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
      staged.push(temp);
    }
    for (const [target] of prepared) {
      const root = target.startsWith(projectRoot + sep) ? projectRoot : globalRoot;
      await assertSafeDestination(root, target);
      // Exclusive destination creation: never overwrite a file that appeared
      // after planning, and never follow a symlink at the target.
      const data = prepared.get(target);
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
      created.push(target);
    }
  } catch (error) {
    const cleanupErrors = [];
    for (const target of created.reverse()) {
      try {
        await rm(target, { force: true });
      } catch (e) {
        cleanupErrors.push(e.message);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        [error, ...cleanupErrors.map((e) => Error(e))],
        'Import failed; rollback incomplete',
      );
    throw error;
  } finally {
    for (const temp of staged) await rm(temp, { force: true }).catch(() => {});
  }
  return {
    source: manifest.source,
    plan,
    applied: true,
    skippedGlobal: manifest.includesGlobal && !includeGlobal,
  };
}
