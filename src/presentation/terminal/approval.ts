import {readFile} from 'node:fs/promises';
import type {ApprovalRequest} from '../../core/permissions/manager.js';
import type {Workspace} from '../../infra/files.js';
import {diffPreview} from '../../infra/diff.js';
/** Build a human-readable preview for any UI. No CLI/UI libraries used. */
export async function approvalPreview(request:ApprovalRequest, workspace:Workspace):Promise<string>{
 if(request.name!=='write_file')return JSON.stringify(request.args,null,2);
 const path=String(request.args.path), proposed=String(request.args.content);
 const target=await workspace.safePath(path);
 let before='';try{before=await readFile(target,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
 return `文件：${path}\n${diffPreview(before,proposed,100000)}`;
}
