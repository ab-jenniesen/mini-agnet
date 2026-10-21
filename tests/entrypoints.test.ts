import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

test(
  'global entrypoint and non-TTY fallback handle piped slash commands without model requests',
  { timeout: 15000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mini-entrypoint-'));
    try {
      const root = resolve(import.meta.dirname, '..');
      const env = {
        ...process.env,
        AGENT_WORKSPACE: directory,
        AGENT_SESSION_ID: 'default',
        AGENT_MODEL_STATE_FILE: join(directory, 'selection.json'),
        AGENT_CREDENTIALS_FILE: join(directory, 'credentials.json'),
        AGENT_MEMORY_FILE: join(directory, 'memories.json'),
        AGENT_GLOBAL_MEMORY_FILE: join(directory, 'global-memory.json'),
        AGENT_CONTEXT_WINDOW_OVERRIDE: '32768',
        MCP_COMMAND: '',
        MCP_ARGS_JSON: '[]',
        DOTENV_CONFIG_PATH: join(directory, '.env'),
      };
      for (const args of [[], ['--classic']]) {
        const child = spawn(process.execPath, [join(root, 'bin/mini-agent.mjs'), ...args], {
          cwd: directory,
          env,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        const exited = new Promise<number | null>((resolve, reject) => {
          child.on('error', reject);
          child.on('close', resolve);
        });
        child.stdin.end('/session work\n/stats\n/exit\n');
        assert.equal(await exited, 0, stderr);
        assert.match(stdout, /会话 work|已切换到会话 work/);
        assert.match(stdout, /modelCalls/);
        assert.doesNotMatch(stdout, /\x1b\[\?1049h/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
