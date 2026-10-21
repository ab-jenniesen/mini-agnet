import { VerifiedFileCache } from '../infra/file-cache.js';
import { readFile, readdir, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { relative, dirname } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolRegistry } from '../core/registry.js';
import { Workspace } from '../infra/files.js';

export function registerLocalTools(registry: ToolRegistry, workspace: Workspace): void {
  const cache = new VerifiedFileCache();
  registry.register({
    name: 'list_files', description: 'List files in a directory. Absolute paths outside the writable workspace are read-only.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Directory relative to workspace, default .' } }, additionalProperties: false },
    validator: z.object({ path: z.string().default('.') }).strict(),
    execute: async ({ path }) => { const entries = await readdir(await workspace.safePath(path as string), { withFileTypes: true }); return entries.slice(0, 100).map(e => `${e.isDirectory() ? 'dir' : 'file'} ${e.name}`).join('\n'); }
  });
  registry.register({
    name: 'read_file', description: 'Read CURRENT file bytes from disk; returns SHA-256 to use as expectedSha256 when editing. Previous tool results may be stale. Offset/limit are characters.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset:{type:'integer'}, limit:{type:'integer'} }, required: ['path'], additionalProperties: false },
    validator: z.object({ path: z.string(),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100000).default(16000) }).strict(),
    execute: async ({path,offset,limit}) => {
      const target = await workspace.safePath(path as string);
      const snapshot = await cache.read(target);
      const body = snapshot.text;
      return JSON.stringify({path, sha256:snapshot.sha256, sizeBytes:snapshot.sizeBytes,mtimeMs:snapshot.mtimeMs,source:snapshot.source,totalChars:body.length,offset,next:Math.min(body.length,(offset as number)+(limit as number)),content:body.slice(offset as number,(offset as number)+(limit as number))});
    }
  });
  registry.register({
    name:'file_status',description:'Get CURRENT SHA-256 and size of file without returning its text. Use to verify whether earlier file observations are still current.',
    parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false},
    validator:z.object({path:z.string()}).strict(),
    execute:async({path})=>{const target=await workspace.safePath(path as string);const snapshot=await cache.read(target);return JSON.stringify({path,sha256:snapshot.sha256,sizeBytes:snapshot.sizeBytes,mtimeMs:snapshot.mtimeMs,source:snapshot.source});}
  });

  registry.register({
    name: 'write_file', description: 'Overwrite a UTF-8 file in an explicitly writable directory; existing files require expectedSha256.', write: true,
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, expectedSha256: {type:'string',description:'SHA-256 returned by read_file; required when overwriting existing file'} }, required: ['path', 'content'], additionalProperties: false },
    validator: z.object({ path: z.string(), content: z.string().max(200_000), expectedSha256:z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict(),
    execute: async ({ path, content, expectedSha256 }) => {
      const target = await workspace.writablePath(path as string);
      await mkdir(dirname(target), { recursive: true });
      let existing:Buffer|undefined;
      try {existing=await readFile(target);} catch(e) {if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e;}
      if (existing) {
        if (!expectedSha256) throw Error('FILE_CONFLICT: existing file requires expectedSha256 from fresh read_file');
        const actual=createHash('sha256').update(existing).digest('hex');
        if (actual!==expectedSha256) throw Error(`FILE_CONFLICT: external modification detected; expected=${expectedSha256} actual=${actual}. Re-read before editing.`);
      } else if (expectedSha256) throw Error('FILE_CONFLICT: expected existing file but it no longer exists');
      // Best-effort optimistic check + atomic replacement; external writers not using this protocol can race between check and rename.
      const temporary=`${target}.${randomUUID()}.tmp`;
      try {await writeFile(temporary,content as string,{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temporary,target);}
      catch(error){await rm(temporary,{force:true});throw error;}

      cache.invalidate(target);
      return `Wrote ${relative(workspace.root, target)}`;
    }
  });
}
