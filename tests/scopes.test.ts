import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScopedMemory } from '../src/infra/storage/scoped-memory.js';
import { loadLayeredSkills } from '../src/infra/extensions/skills.js';
import { resolveMcpServers } from '../src/infra/extensions/project-mcp.js';
import { loadLayeredSettings } from '../src/infra/configuration/layered-settings.js';
import { ToolRegistry } from '../src/core/tools/registry.js';
import { registerMemoryTools } from '../src/tools/memory.js';

test('memory project isolation; global visible across both', async () => {
  const base = await mkdtemp(join(tmpdir(), 'scopes-'));
  try {
    const global = join(base, 'global.json');
    const a = await ScopedMemory.open(join(base, 'a.json'), global);
    await a.add('project A database choice');
    await a.add('Prefer TypeScript across projects', [], 'global');
    // Memory stores are snapshots: a newly opened scope observes persisted global changes.
    const reopened = await ScopedMemory.open(join(base, 'b.json'), global);
    const b = reopened;
    assert.equal(reopened.search('database').length, 0);
    assert.equal(reopened.search('TypeScript').length, 1);
    assert.equal(reopened.search('TypeScript')[0]?.scope, 'global');
    const tools = new ToolRegistry();
    registerMemoryTools(tools, b);
    const denied = await tools.invoke(
      'memory_save',
      { text: 'Sensitive project detail', scope: 'global' },
      async () => false,
    );
    assert.match(denied, /denied/i);
    assert.equal(b.list('global').length, 1);
    await tools.invoke('memory_save', { text: 'Project B content' }, async () => true);
    assert.equal(b.list('project').length, 1);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project skills override same-named global; unmatched global stays', async () => {
  const base = await mkdtemp(join(tmpdir(), 'skills-'));
  try {
    const g = join(base, 'global'),
      p = join(base, 'project');
    for (const [r, n, t] of [
      [g, 'review', 'GLOBAL REVIEW'],
      [g, 'other', 'GLOBAL OTHER'],
      [p, 'review', 'PROJECT REVIEW'],
    ] as const) {
      await mkdir(join(r, n), { recursive: true });
      await writeFile(join(r, n, 'SKILL.md'), t);
    }
    const merged = await loadLayeredSkills(g, p);
    assert.match(merged, /PROJECT REVIEW/);
    assert.match(merged, /GLOBAL OTHER/);
    assert.doesNotMatch(merged, /GLOBAL REVIEW/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('project MCP override including disabled; layered settings merged safely', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mcp-'));
  try {
    const g = join(base, 'global.json'),
      p = join(base, 'project.json');
    await writeFile(
      g,
      JSON.stringify({
        servers: {
          git: { command: 'node', args: ['g.mjs'], enabled: true },
          shared: { command: 'node', enabled: true },
        },
      }),
    );
    await writeFile(
      p,
      JSON.stringify({ servers: { git: { command: 'node', args: ['p.mjs'], enabled: false } } }),
    );
    const config = await resolveMcpServers(g, p);
    assert.equal(config.git.enabled, false);
    assert.equal(config.shared.enabled, true);
    await writeFile(
      g,
      JSON.stringify({ schemaVersion: 1, context: { compactThreshold: 0.75, summarize: false } }),
    );
    await writeFile(p, JSON.stringify({ schemaVersion: 1, context: { summarize: true } }));
    const settings = await loadLayeredSettings(p, g);
    assert.equal(settings.context?.compactThreshold, 0.75);
    assert.equal(settings.context?.summarize, true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
