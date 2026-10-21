import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
export async function readSkillMap(root:string):Promise<Map<string,string>> {
  const result=new Map<string,string>(); let dirs:string[];
  try {dirs=await readdir(root);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return result;throw e;}
  for(const name of dirs.sort()){
    if(!/^[\w-]+$/.test(name))continue;
    try{result.set(name,await readFile(join(root,name,'SKILL.md'),'utf8'));}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  }
  return result;
}
export async function loadSkills(root:string):Promise<string>{const items=await readSkillMap(root);return [...items].map(([n,t])=>`## ${n}\n${t.slice(0,6000)}`).join('\n\n');}
/** Same-named project skill overrides global. Never silently merge contradictory instructions. */
export async function loadLayeredSkills(globalRoot:string,projectRoot:string):Promise<string>{
  const shared=await readSkillMap(globalRoot), local=await readSkillMap(projectRoot);
  for(const [name,content] of local) shared.set(name,content);
  return [...shared].map(([name,content])=>`## ${name} [${local.has(name)?'project':'global'}]\n${content.slice(0,6000)}`).join('\n\n');
}
