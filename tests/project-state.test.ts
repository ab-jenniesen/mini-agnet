import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectState } from '../src/infra/project-state.js';
import { Workspace } from '../src/infra/files.js';

test('each launch folder has independent .mini-agent state', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mini-project-state-'));
  try {
    const first = join(base, 'first');
    const second = join(base, 'second');
    const extra = join(base, 'extra');
    await Promise.all([mkdir(first), mkdir(second), mkdir(extra)]);
    const a = await ProjectState.open(first);
    const b = await ProjectState.open(second);
    assert.notEqual(a.session('default'), b.session('default'));
    assert.match(await readFile(a.path('PROJECT.md'),'utf8'), /Project Instructions/);
    assert.match(await readFile(a.path('.gitignore'),'utf8'), /\*/);
    const ws = await Workspace.create(first);
    await ws.addDirectory(extra, false);
    assert.deepEqual(JSON.parse(await readFile(a.path('workspace-grants.json'),'utf8')), [extra]);
    assert.equal(await (await import('node:fs/promises')).stat(join(extra,'.mini-agent')).then(()=>true,()=>false),false);
    const secondWs = await Workspace.create(second);
    assert.equal(secondWs.listWritable().includes(extra), false);
  } finally { await rm(base,{recursive:true,force:true}); }
});
