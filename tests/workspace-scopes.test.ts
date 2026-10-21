import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/infra/files.js';

test('launch directory is writable; outside directory is read-only until granted', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mini-agent-scopes-'));
  try {
    const project = join(base,'project');
    const outside = join(base,'outside');
    await mkdir(project); await mkdir(outside);
    await writeFile(join(outside,'data.txt'),'external');
    const store=join(base,'private','grants.json');
    const ws=await Workspace.create(project,store);
    assert.equal(await ws.writablePath('app.ts'),join(project,'app.ts'));
    assert.equal(await ws.safePath(join(outside,'data.txt')),join(outside,'data.txt'));
    await assert.rejects(ws.writablePath(join(outside,'data.txt')),/WRITE_SCOPE_DENIED/);
    await ws.addDirectory(outside,false);
    assert.equal(await ws.writablePath(join(outside,'data.txt')),join(outside,'data.txt'));
    const restored=await Workspace.create(project,store);
    assert.equal(await restored.writablePath(join(outside,'data.txt')),join(outside,'data.txt'));
  } finally { await rm(base,{recursive:true,force:true}); }
});

test('missing directory creation is opt-in and file symlinks are rejected',async()=>{
  const base=await mkdtemp(join(tmpdir(),'mini-agent-create-'));
  try {
    const project=join(base,'project');await mkdir(project);
    const ws=await Workspace.create(project,join(base,'private','grants.json'));
    const extra=join(base,'new');
    await assert.rejects(ws.addDirectory(extra,false),/DIRECTORY_MISSING/);
    await ws.addDirectory(extra,true);
    assert.equal(ws.isWritable(join(extra,'a.ts')),true);
  }finally { await rm(base,{recursive:true,force:true}); }
});
