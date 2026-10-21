import { z } from 'zod';
import type { ToolRegistry } from '../core/registry.js';
import type { ScopedMemory, MemoryScope } from '../infra/scoped-memory.js';

const scope = z.enum(['project','global']);
/** Project memory is default; global writes always require the existing write approval flow. */
export function registerMemoryTools(registry:ToolRegistry, memory:ScopedMemory):void {
  registry.register({ name:'memory_search', description:'Search project and global long-term notes. Optional scope limits the search.',
    parameters:{type:'object',properties:{query:{type:'string'},limit:{type:'integer'},scope:{type:'string',enum:['project','global']}},required:['query'],additionalProperties:false},
    validator:z.object({query:z.string().min(1),limit:z.number().int().min(1).max(20).optional(),scope:scope.optional()}).strict(),
    execute:async ({query,limit,scope:s})=>JSON.stringify(memory.search(query as string,limit as number|undefined,s as MemoryScope|undefined)) });
  registry.register({name:'memory_list',description:'List memories with their project/global scope and IDs.',
    parameters:{type:'object',properties:{scope:{type:'string',enum:['project','global']}},additionalProperties:false},
    validator:z.object({scope:scope.optional()}).strict(),execute:async ({scope:s})=>JSON.stringify(memory.list(s as MemoryScope|undefined).slice(0,100)) });
  registry.register({name:'memory_save',description:'Save a note; defaults to this project. Global notes apply across all projects and must only contain broadly applicable preferences, never secrets. Approval required.',write:true,
    parameters:{type:'object',properties:{text:{type:'string'},tags:{type:'array',items:{type:'string'}},scope:{type:'string',enum:['project','global']}},required:['text'],additionalProperties:false},
    validator:z.object({text:z.string().min(1).max(4000),tags:z.array(z.string().max(40)).max(10).optional(),scope:scope.optional()}).strict(),
    execute:async ({text,tags,scope:s})=>JSON.stringify(await memory.add(text as string,tags as string[]|undefined,s as MemoryScope|undefined))});
  registry.register({name:'memory_update',description:'Update a note by ID and explicit memory scope. Approval required.',write:true,
    parameters:{type:'object',properties:{id:{type:'string'},text:{type:'string'},scope:{type:'string',enum:['project','global']}},required:['id','text','scope'],additionalProperties:false},
    validator:z.object({id:z.string().uuid(),text:z.string().min(1).max(4000),scope}).strict(),
    execute:async ({id,text,scope:s})=>JSON.stringify(await memory.update(id as string,text as string,s as MemoryScope))});
  registry.register({name:'memory_delete',description:'Delete memory by ID and explicit scope. Approval required.',write:true,
    parameters:{type:'object',properties:{id:{type:'string'},scope:{type:'string',enum:['project','global']}},required:['id','scope'],additionalProperties:false},
    validator:z.object({id:z.string().uuid(),scope}).strict(),execute:async ({id,scope:s})=>JSON.stringify({deleted:await memory.remove(id as string,s as MemoryScope)})});
}
