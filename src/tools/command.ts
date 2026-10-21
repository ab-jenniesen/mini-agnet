import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolRegistry } from '../core/registry.js';
import type { Workspace } from '../infra/files.js';

/** Educational command execution, NOT a security boundary. Run in a disposable project/container. */
export async function runCommand(workspace: Workspace, command: string, args: string[], cwd = '.', timeoutMs = 20_000): Promise<string> {
  // No shell, no arbitrary executable paths and no command string interpolation.
  const allowed = new Set(['node', 'npm', 'npx', 'git', 'python3', 'pytest']);
  if (!allowed.has(command)) throw new Error('Command not allowlisted');
  if (args.some(a => a.includes('\0') || a.includes('\n') || a.startsWith('@'))) throw new Error('Invalid command argument');
  const dir = await workspace.writablePath(cwd);
  const logDir = join(workspace.root,'.agent-command-logs');
  await mkdir(logDir,{recursive:true,mode:0o700});
  const logPath = join(logDir,`${randomUUID()}.log`);
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {cwd:dir, shell:false, env:{ PATH: process.env.PATH ?? '', HOME: workspace.root, CI:'1', NO_COLOR:'1' }, stdio:['ignore','pipe','pipe']});
    const log = createWriteStream(logPath,{mode:0o600,flags:'wx'});
    let preview='', totalBytes=0, overflow=false, timedOut=false;
    const append=(buf:Buffer)=>{
      totalBytes+=buf.length;
      if(preview.length<12000)preview+=buf.toString('utf8').slice(0,12000-preview.length);
      if(!log.write(buf)) { child.stdout.pause(); child.stderr.pause(); log.once('drain',()=>{child.stdout.resume();child.stderr.resume();}); }
    };
    child.stdout.on('data',append);child.stderr.on('data',append);
    log.on('error',()=>{overflow=true;child.kill('SIGKILL');});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    child.on('error',error=>{clearTimeout(timer);log.end();reject(error);});
    child.on('close',(code,signal)=>{clearTimeout(timer);log.end(()=>resolve(JSON.stringify({ok:code===0&&!timedOut&&!overflow,exitCode:code,signal,timedOut,logPath,totalBytes,preview,warning:overflow?'Log persistence failed':undefined})));});
  });
}
export function registerCommandTools(registry: ToolRegistry, workspace: Workspace) {
  registry.register({ name:'run_command', description:'Run an allowlisted executable (node/npm/npx/git/python3/pytest) in workspace with shell=false. Requires approval. This is NOT an OS sandbox; commands may execute arbitrary code.',write:true,
    parameters:{type:'object',properties:{command:{type:'string'},args:{type:'array',items:{type:'string'}},cwd:{type:'string'},timeoutMs:{type:'integer'}},required:['command','args'],additionalProperties:false},
    validator:z.object({command:z.enum(['node','npm','npx','git','python3','pytest']),args:z.array(z.string().max(300)).max(30),cwd:z.string().default('.'),timeoutMs:z.number().int().min(1000).max(60_000).default(20_000)}).strict(),
    execute:async({command,args,cwd,timeoutMs}) => runCommand(workspace,command as string,args as string[],cwd as string,timeoutMs as number)
  });
}
