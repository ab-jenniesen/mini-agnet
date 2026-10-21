import {readFile} from 'node:fs/promises';
import {atomicJson} from './memory.js';
export type ToolJournalEntry = {callId:string;name:string;state:'pending'|'completed'|'uncertain';startedAt:string;finishedAt?:string;result?:string};
export type ExecutionRecord = {runId:string;status:'running'|'completed'|'interrupted';updatedAt:string;tools:ToolJournalEntry[]};
/** Crash-awareness only: journal records NEVER authorize automatic replay of mutating tools. */
export class ExecutionJournal {
  private record?:ExecutionRecord;
  constructor(private readonly file:string) {}
  async load():Promise<ExecutionRecord|undefined>{try{return JSON.parse(await readFile(this.file,'utf8')) as ExecutionRecord;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}}
  async begin(runId:string):Promise<void>{this.record={runId,status:'running',tools:[],updatedAt:new Date().toISOString()};await this.flush();}
  async startTool(callId:string,name:string):Promise<void>{if(!this.record)return;this.record.tools.push({callId,name,state:'pending',startedAt:new Date().toISOString()});await this.flush();}
  async finishTool(callId:string,result:string):Promise<void>{const entry=this.record?.tools.find(x=>x.callId===callId);if(!entry)return;entry.state='completed';entry.result=result.slice(0,1000);entry.finishedAt=new Date().toISOString();await this.flush();}
  async finish(status:'completed'|'interrupted'):Promise<void>{if(!this.record)return;this.record.status=status;if(status==='interrupted')for(const tool of this.record.tools)if(tool.state==='pending')tool.state='uncertain';await this.flush();}
  private async flush():Promise<void>{if(!this.record)return;this.record.updatedAt=new Date().toISOString();await atomicJson(this.file,this.record);}
}
