/** Local development key store. Files are owner-only (0600), NOT encrypted. */
import {readFile, writeFile, mkdir, chmod, rename} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {providerById} from '../core/providers.js';

export type CredentialStatus = 'env'|'saved'|'local'|'missing';
export class CredentialStore {
  private cache:Record<string,string>={};
  private constructor(readonly path:string){}
  static async open(path:string){
    const store=new CredentialStore(path);
    try {
      const raw=JSON.parse(await readFile(path,'utf8')) as unknown;
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('Invalid credentials file');
      for(const [k,v] of Object.entries(raw))if(typeof v==='string'&&v.trim())store.cache[k]=v;
    }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    return store;
  }
  status(id:string):CredentialStatus{
    const provider=providerById(id);
    if(process.env[provider.envKey]?.trim())return 'env';
    if(this.cache[id])return 'saved';
    if(id==='ollama'||id==='custom')return 'local';
    return 'missing';
  }
  get(id:string):string|undefined{
    const provider=providerById(id);
    return process.env[provider.envKey]?.trim()||this.cache[id]||(id==='ollama'||id==='custom'?'ollama':undefined);
  }
  /** No automatic logging of secrets. Only persist with explicit opt-in. */
  async set(id:string,value:string,persist:boolean){
    const provider=providerById(id);
    const key=value.trim();
    if(!key||/\s/.test(key)||key.length>8192)throw new Error('Invalid API key');
    if(persist){
      this.cache[id]=key;
      await mkdir(dirname(this.path),{recursive:true});
      const temp=`${this.path}.${randomUUID()}.tmp`;
      try{
        await writeFile(temp,JSON.stringify(this.cache,null,2),{mode:0o600,flag:'wx'});
        await chmod(temp,0o600);
        await rename(temp,this.path);
        await chmod(this.path,0o600);
      }catch(e){const {rm}=await import('node:fs/promises');await rm(temp,{force:true});throw e;}
    }else{process.env[provider.envKey]=key;}
  }
}
