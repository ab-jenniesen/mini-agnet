import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from '../core/registry.js';
import type { Workspace } from '../infra/files.js';

function executable(command: string, args: string[]): { command: string; args: string[] } {
  if (command === 'node') return { command: process.execPath, args };
  if (process.platform === 'win32' && (command === 'npm' || command === 'npx')) {
    // .cmd shims require a shell. Invoke npm's JavaScript CLI with Node instead.
    const cli = command === 'npm' ? 'npm-cli.js' : 'npx-cli.js';
    const candidates = [
      process.env.npm_execpath ? join(dirname(process.env.npm_execpath), cli) : '',
      join(dirname(process.execPath), 'node_modules/npm/bin', cli),
    ];
    const path = candidates.find((path) => path && existsSync(path));
    if (!path)
      throw new Error(
        `Cannot locate ${command} CLI; start mini-agent through npm or install npm beside Node`,
      );
    return { command: process.execPath, args: [path, ...args] };
  }
  return { command, args };
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1' };
  for (const key of [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'APPDATA',
    'LOCALAPPDATA',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/** Educational command execution, NOT a security boundary. Run in a disposable project/container. */
export async function runCommand(
  workspace: Workspace,
  command: string,
  args: string[],
  cwd = '.',
  timeoutMs = 20_000,
  signal?: AbortSignal,
): Promise<string> {
  // No shell, no arbitrary executable paths and no command string interpolation.
  const allowed = new Set(['node', 'npm', 'npx', 'git', 'python3', 'pytest']);
  if (!allowed.has(command)) throw new Error('Command not allowlisted');
  if (args.some((a) => a.includes('\0') || a.includes('\n') || a.startsWith('@')))
    throw new Error('Invalid command argument');
  const dir = await workspace.writablePath(cwd);
  signal?.throwIfAborted();
  const program = executable(command, args);
  const logDir = join(workspace.root, '.agent-command-logs');
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const logPath = join(logDir, `${randomUUID()}.log`);
  return await new Promise((resolve, reject) => {
    const child = spawn(program.command, program.args, {
      cwd: dir,
      shell: false,
      env: commandEnvironment(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const log = createWriteStream(logPath, { mode: 0o600, flags: 'wx' });
    let preview = '',
      totalBytes = 0,
      overflow = false,
      timedOut = false;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const kill = () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill('SIGKILL'));
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const abort = () => kill();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const append = (buf: Buffer, decoder: StringDecoder) => {
      totalBytes += buf.length;
      if (preview.length < 12000) preview += decoder.write(buf).slice(0, 12000 - preview.length);
      if (overflow) return;
      if (!log.write(buf)) {
        child.stdout.pause();
        child.stderr.pause();
        log.once('drain', () => {
          child.stdout.resume();
          child.stderr.resume();
        });
      }
    };
    child.stdout.on('data', (buf) => append(buf, stdoutDecoder));
    child.stderr.on('data', (buf) => append(buf, stderrDecoder));
    log.on('error', () => {
      overflow = true;
      child.stdout.resume();
      child.stderr.resume();
      kill();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      log.end();
      reject(error);
    });
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const finish = () =>
        resolve(
          JSON.stringify({
            ok: code === 0 && !timedOut && !overflow && !signal?.aborted,
            exitCode: code,
            signal: terminationSignal,
            timedOut,
            cancelled: signal?.aborted ?? false,
            logPath,
            totalBytes,
            preview,
            warning: overflow ? 'Log persistence failed' : undefined,
          }),
        );
      if (log.destroyed) finish();
      else {
        log.once('error', finish);
        log.end(finish);
      }
    });
  });
}
export function registerCommandTools(registry: ToolRegistry, workspace: Workspace) {
  registry.register({
    name: 'run_command',
    description:
      'Run an allowlisted executable (node/npm/npx/git/python3/pytest) in workspace with shell=false. Requires approval. This is NOT an OS sandbox; commands may execute arbitrary code.',
    write: true,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeoutMs: { type: 'integer' },
      },
      required: ['command', 'args'],
      additionalProperties: false,
    },
    validator: z
      .object({
        command: z.enum(['node', 'npm', 'npx', 'git', 'python3', 'pytest']),
        args: z.array(z.string().max(300)).max(30),
        cwd: z.string().default('.'),
        timeoutMs: z.number().int().min(1000).max(60_000).default(20_000),
      })
      .strict(),
    execute: async ({ command, args, cwd, timeoutMs }, context) =>
      runCommand(
        workspace,
        command as string,
        args as string[],
        cwd as string,
        timeoutMs as number,
        context?.signal,
      ),
  });
}
