import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {importBundle,exportBundle} from '../lib/portable.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const entry=(path,txt)=>{const b=Buffer.from(txt);return {path,bytes:b.length,sha256:sha(b),data:b.toString('base64')};};
async function archive(file,files){await writeFile(file,gzipSync(Buffer.from(JSON.stringify({format:'mini-agent-portable',schemaVersion:1,includesGlobal:false,source:{},files}))));}
async function missing(path){await assert.rejects(access(path));}
test('invalid MCP JSON fails before writing any import files',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'agent-invalid-'));
 try{const target=join(tmp,'target');await mkdir(target);const bundle=join(tmp,'data.magent');await archive(bundle,[entry('project/PROJECT.md','valid'),entry('project/mcp.json','not-json')]);await assert.rejects(importBundle({file:bundle,cwd:target,apply:true}));await missing(join(target,'.mini-agent','PROJECT.md'));}
 finally{await rm(tmp,{recursive:true,force:true});}
});
test('symlink destination is rejected even when importing new file',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'agent-link-'));
 try{const target=join(tmp,'target'),elsewhere=join(tmp,'elsewhere');await mkdir(target);await mkdir(elsewhere);await symlink(elsewhere,join(target,'.mini-agent'));const bundle=join(tmp,'data.magent');await archive(bundle,[entry('project/PROJECT.md','do not write')]);await assert.rejects(importBundle({file:bundle,cwd:target,apply:true}),/Symlink/);await missing(join(elsewhere,'PROJECT.md'));}
 finally{await rm(tmp,{recursive:true,force:true});}
});
test('export blocks obvious API tokens unless explicitly acknowledged',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'agent-secret-'));
 try{await mkdir(join(tmp,'source','.mini-agent','sessions'),{recursive:true});await writeFile(join(tmp,'source','.mini-agent','sessions','a.json'),JSON.stringify({token:'sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno'}));await assert.rejects(exportBundle({cwd:join(tmp,'source'),out:join(tmp,'export.magent')}),/Potential secrets/);await missing(join(tmp,'export.magent'));const ok=await exportBundle({cwd:join(tmp,'source'),out:join(tmp,'ack.magent'),allowSensitive:true});assert.equal(ok.count,1);}
 finally{await rm(tmp,{recursive:true,force:true});}
});
