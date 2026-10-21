import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Workspace} from '../src/infra/files.js';
import {ToolRegistry} from '../src/core/registry.js';
import {registerLocalTools} from '../src/tools/local.js';
import {CompactionStore} from '../src/infra/compaction.js';
import type {Message,Model} from '../src/core/types.js';
import {ContextManager} from '../src/core/context/manager.js';

test('fresh reads detect external edits, stale expected hash rejects overwrite',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mini-agent-cas-'));
 try{
  await writeFile(join(root,'demo.ts'),'const x = 1;');
  const registry=new ToolRegistry();registerLocalTools(registry,await Workspace.create(root));
  const approve=async()=>true;
  const before=JSON.parse(await registry.invoke('read_file',{path:'demo.ts'},approve));
  await writeFile(join(root,'demo.ts'),'const x = 2;');
  const conflict=await registry.invoke('write_file',{path:'demo.ts',content:'const x = 3;',expectedSha256:before.sha256},approve);
  assert.match(conflict,/FILE_CONFLICT/);
  assert.equal(await readFile(join(root,'demo.ts'),'utf8'),'const x = 2;');
  const after=JSON.parse(await registry.invoke('read_file',{path:'demo.ts'},approve));
  assert.notEqual(before.sha256,after.sha256);
  assert.match(await registry.invoke('write_file',{path:'demo.ts',content:'const x = 3;',expectedSha256:after.sha256},approve),/Wrote/);
  assert.equal(await readFile(join(root,'demo.ts'),'utf8'),'const x = 3;');
 } finally {await rm(root,{recursive:true,force:true});}
});

test('compaction checkpoint rejects changed historical prefix',async()=>{
 const root=await mkdtemp(join(tmpdir(),'mini-agent-compaction-'));
 try{
  const store=new CompactionStore(join(root,'summary.json'));
  const history:Message[]=[{role:'system',content:'rules'},{role:'user',content:'initial'}, {role:'assistant',content:'response'}, {role:'user',content:'new request'}];
  await store.save(history,3,'Earlier task finished');
  assert.equal((await store.read(history))?.summary,'Earlier task finished');
  const changed:Message[]=structuredClone(history);changed[1]={role:'user',content:'changed history'};
  assert.equal(await store.read(changed),undefined);
 } finally {await rm(root,{recursive:true,force:true});}
});

test('context preserves archived output reference during second-stage truncation',async()=>{
 const manager=new ContextManager({maxInputTokens:12000,reservedOutputTokens:512,maxToolResultTokens:150,safetyMargin:0,compactThreshold:1});
 const ref='[ARCHIVED id=11111111-1111-4111-8111-111111111111 totalChars=30000; use read_tool_output(id, offset, limit)]';
 const messages:Message[]=[{role:'system',content:'system'}, {role:'user',content:'inspect'}, {role:'assistant',content:null,tool_calls:[{id:'x',type:'function',function:{name:'read_file',arguments:'{}'}}]}, {role:'tool',tool_call_id:'x',content:ref+'\n'+'x'.repeat(10000)}];
 const prepared=await manager.prepare(messages);
 const tool=prepared.messages.find(m=>m.role==='tool');
 assert.ok(tool?.role==='tool'&&tool.content.includes('11111111-1111-4111-8111-111111111111'));
});

test('tool errors become model-visible messages, agent can continue',async()=>{
 const {Agent}=await import('../src/core/agent.js');
 const registry=new ToolRegistry();
 let turns=0;
 const model:Model={async complete(){turns++;return turns===1?{content:null,toolCalls:[{id:'1',name:'missing_tool',arguments:'{}'}]}:{content:'Recovered after tool error',toolCalls:[]};}};
 const agent=new Agent(model,registry,'system');
 assert.equal(await agent.run('go'),'Recovered after tool error');
 assert.equal(turns,2);
 assert.ok(agent.history.some(m=>m.role==='tool'&&m.content.includes('Unknown tool')));
});
