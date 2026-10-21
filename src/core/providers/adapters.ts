import type { Message, Model, ModelEvent, ModelReply, Tool, Usage } from '../types.js';
function usage(prompt=0,completion=0):Usage {return {promptTokens:prompt,completionTokens:completion,totalTokens:prompt+completion};}
function requestSignal(signal?:AbortSignal):{ signal:AbortSignal;cleanup:()=>void } {
  const c=new AbortController();const timer=setTimeout(()=>c.abort(new Error('Model timeout')),120000);
  const onAbort=()=>c.abort(signal?.reason);signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)c.abort(signal.reason);
  return {signal:c.signal,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}};
}
async function* sse(response:Response):AsyncGenerator<{event:string;data:any}> {
  if(!response.body)throw new Error('No response stream');
  const reader=response.body.getReader();const dec=new TextDecoder();let buf='';
  try { while(true){const {value,done}=await reader.read();buf+=dec.decode(value??new Uint8Array(),{stream:!done});
    let m:RegExpExecArray|null;
    while((m=/\r?\n\r?\n/.exec(buf))){const frame=buf.slice(0,m.index);buf=buf.slice(m.index+m[0].length);
      let event='message';const lines:string[]=[];for(const line of frame.split(/\r?\n/)){if(line.startsWith('event:'))event=line.slice(6).trim();if(line.startsWith('data:'))lines.push(line.slice(5).trimStart());}
      const data=lines.join('\n');if(data&&data!=='[DONE]')yield {event,data:JSON.parse(data)};
    }
    if(done)break;
  }}finally{reader.releaseLock();}
}
function anthroMessages(messages:Message[]) {
  const out:Array<{role:'user'|'assistant';content:any}>=[];
  for(const m of messages) {
    if(m.role==='system')continue;
    if(m.role==='user')out.push({role:'user',content:m.content});
    if(m.role==='assistant') {const content:any[]=[];if(m.content)content.push({type:'text',text:m.content});for(const c of m.tool_calls??[])content.push({type:'tool_use',id:c.id,name:c.function.name,input:JSON.parse(c.function.arguments)});if(content.length)out.push({role:'assistant',content});}
    if(m.role==='tool') {const last=out.at(-1);const result={type:'tool_result',tool_use_id:m.tool_call_id,content:m.content};if(last?.role==='user'&&Array.isArray(last.content))last.content.push(result);else out.push({role:'user',content:[result]});}
  }
  return out;
}
export class AnthropicModel implements Model {
  private maxOutputTokens=4096;
  setMaxOutputTokens(tokens:number):void {if(Number.isSafeInteger(tokens)&&tokens>0)this.maxOutputTokens=tokens;}
  constructor(private readonly baseURL:string,private readonly key:string,private readonly model:string){}
  async complete(messages:Message[],tools:Tool[],options:{onEvent?:(e:ModelEvent)=>void;signal?:AbortSignal}={}):Promise<ModelReply>{
    const r=requestSignal(options.signal);
    try{const response=await fetch(`${this.baseURL.replace(/\/$/,'')}/messages`,{method:'POST',signal:r.signal,headers:{'x-api-key':this.key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:this.model,max_tokens:this.maxOutputTokens,...(Number(process.env.AGENT_ANTHROPIC_THINKING_BUDGET)>0?{thinking:{type:'enabled',budget_tokens:Number(process.env.AGENT_ANTHROPIC_THINKING_BUDGET)}}:{}),system:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n'),messages:anthroMessages(messages),...(tools.length?{tools:tools.map(t=>({name:t.name,description:t.description,input_schema:t.parameters}))}:{}),stream:!!options.onEvent})});
      if(!response.ok)throw new Error(`Anthropic HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
      if(!options.onEvent){const data=await response.json() as any;const content=data.content??[];return {content:content.filter((x:any)=>x.type==='text').map((x:any)=>x.text).join('')||null,toolCalls:content.filter((x:any)=>x.type==='tool_use').map((x:any)=>({id:x.id,name:x.name,arguments:JSON.stringify(x.input)})),usage:usage(data.usage?.input_tokens,data.usage?.output_tokens)};}
      let text='';const calls=new Map<number,{id:string;name:string;arguments:string}>();let used:Usage|undefined;
      for await(const e of sse(response)){
        const d=e.data;
        if(e.event==='message_start')used=usage(d.message?.usage?.input_tokens,0);
        if(e.event==='content_block_start'&&d.content_block?.type==='tool_use')calls.set(d.index,{id:d.content_block.id,name:d.content_block.name,arguments:''});
        if(e.event==='content_block_delta'){if(d.delta?.type==='thinking_delta' && typeof d.delta.thinking==='string')options.onEvent({type:'thinking',text:d.delta.thinking,source:'summary'});if(d.delta?.type==='text_delta'){text+=d.delta.text;options.onEvent({type:'text',text:d.delta.text});}if(d.delta?.type==='input_json_delta'){const c=calls.get(d.index);if(c)c.arguments+=d.delta.partial_json;}}
        if(e.event==='message_delta'&&d.usage){used=usage(used?.promptTokens,d.usage.output_tokens);}
      }
      if(used)options.onEvent({type:'usage',usage:used});
      return {content:text||null,toolCalls:[...calls.values()].map(c=>({...c,arguments:c.arguments||'{}'})),usage:used};
    }finally{r.cleanup();}
  }
}
function geminiMessages(messages:Message[]){const out:any[]=[];for(const m of messages){
  if(m.role==='system')continue;
  if(m.role==='user')out.push({role:'user',parts:[{text:m.content}]});
  if(m.role==='assistant'){const parts:any[]=[];if(m.content)parts.push({text:m.content});for(const c of m.tool_calls??[])parts.push({functionCall:{name:c.function.name,args:JSON.parse(c.function.arguments)}});if(parts.length)out.push({role:'model',parts});}
  if(m.role==='tool'){const assistant=[...messages].reverse().find(x=>x.role==='assistant'&&x.tool_calls?.some(c=>c.id===m.tool_call_id));const toolName=assistant?.role==='assistant'?assistant.tool_calls?.find(c=>c.id===m.tool_call_id)?.function.name:'unknown';const last=out.at(-1);const part={functionResponse:{name:toolName,response:{result:m.content}}};if(last?.role==='user'&&last.parts?.[0]?.functionResponse)last.parts.push(part);else out.push({role:'user',parts:[part]});}
}return out;}
export class GeminiModel implements Model {
  private maxOutputTokens?:number;
  setMaxOutputTokens(tokens:number):void {if(Number.isSafeInteger(tokens)&&tokens>0)this.maxOutputTokens=tokens;}
  constructor(private readonly baseURL:string,private readonly key:string,private readonly model:string){}
  async complete(messages:Message[],tools:Tool[],options:{onEvent?:(e:ModelEvent)=>void;signal?:AbortSignal}={}):Promise<ModelReply>{
    const r=requestSignal(options.signal);try{
      const endpoint=options.onEvent?'streamGenerateContent?alt=sse':'generateContent';
      const response=await fetch(`${this.baseURL.replace(/\/$/,'')}/models/${encodeURIComponent(this.model)}:${endpoint}`,{method:'POST',signal:r.signal,headers:{'x-goog-api-key':this.key,'content-type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:messages.filter(m=>m.role==='system').map(m=>m.content).join('\n')}]},contents:geminiMessages(messages),...(this.maxOutputTokens || process.env.AGENT_GEMINI_THOUGHTS==='1'?{generationConfig:{...(this.maxOutputTokens?{maxOutputTokens:this.maxOutputTokens}:{}),...(process.env.AGENT_GEMINI_THOUGHTS==='1'?{thinkingConfig:{includeThoughts:true}}:{})}}:{}),...(tools.length?{tools:[{functionDeclarations:tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))}]}:{})})});
      if(!response.ok)throw new Error(`Gemini HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
      let text='';let used:Usage|undefined;const calls:{id:string;name:string;arguments:string}[]=[];
      let index=0;
      const consume=(d:any)=>{for(const part of d.candidates?.[0]?.content?.parts??[]){if(part.text){if(part.thought===true)options.onEvent?.({type:'thinking',text:part.text,source:'summary'});else{text+=part.text;options.onEvent?.({type:'text',text:part.text});}}if(part.functionCall)calls.push({id:`gemini-${index++}`,name:part.functionCall.name,arguments:JSON.stringify(part.functionCall.args??{})});}if(d.usageMetadata){used=usage(d.usageMetadata.promptTokenCount,d.usageMetadata.candidatesTokenCount);}};
      if(options.onEvent){for await(const e of sse(response))consume(e.data);}else consume(await response.json());
      if(used)options.onEvent?.({type:'usage',usage:used});return {content:text||null,toolCalls:calls,usage:used};
    }finally{r.cleanup();}
  }
}
