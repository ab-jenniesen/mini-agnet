import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { LongTermMemory, type MemoryEntry } from './long-memory.js';

export type MemoryScope = 'project' | 'global';
export type ScopedMemoryEntry = MemoryEntry & { scope: MemoryScope };
/** Separate physical stores. Project is the default write target; retrieval can see both. */
export class ScopedMemory {
  private constructor(readonly project: LongTermMemory, readonly global: LongTermMemory) {}
  static async open(projectFile: string, globalFile = join(homedir(), '.config', 'mini-agent', 'memories.json')): Promise<ScopedMemory> {
    await mkdir(dirname(globalFile), { recursive: true, mode: 0o700 });
    return new ScopedMemory(await LongTermMemory.open(projectFile), await LongTermMemory.open(globalFile));
  }
  private store(scope: MemoryScope): LongTermMemory { return scope === 'global' ? this.global : this.project; }
  list(scope?: MemoryScope): ScopedMemoryEntry[] {
    const scopes: MemoryScope[] = scope ? [scope] : ['project', 'global'];
    return scopes.flatMap(s => this.store(s).list().map(m => ({...m, scope:s})));
  }
  search(query: string, limit=5, scope?: MemoryScope): ScopedMemoryEntry[] {
    if (scope) return this.store(scope).search(query,limit).map(m=>({...m,scope}));
    // Reserve candidates from both scopes, rank by the same token coverage mechanism in each store.
    const project=this.project.search(query,limit).map(m=>({...m,scope:'project' as const}));
    const global=this.global.search(query,limit).map(m=>({...m,scope:'global' as const}));
    const normalized=query.toLowerCase().split(/\s+/).filter(Boolean);
    const score=(m:ScopedMemoryEntry)=>normalized.reduce((n,part)=>n+((m.text+' '+m.tags.join(' ')).toLowerCase().includes(part)?1:0),0);
    return [...project,...global].sort((a,b)=>score(b)-score(a)|| (a.scope==='project'?-1:1)).slice(0,limit);
  }
  async add(text:string,tags:string[]=[],scope:MemoryScope='project'):Promise<ScopedMemoryEntry>{return {...await this.store(scope).add(text,tags),scope};}
  async update(id:string,text:string,scope:MemoryScope='project'):Promise<ScopedMemoryEntry>{return {...await this.store(scope).update(id,text),scope};}
  async remove(id:string,scope:MemoryScope='project'):Promise<boolean>{return this.store(scope).remove(id);}
}
