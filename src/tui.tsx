import { currentEnvironment } from './infra/environment.js';
import {loadLayeredSettings} from './infra/layered-settings.js';
import {ProjectState} from './infra/project-state.js';
import {connectProjectMcp} from './infra/project-mcp.js';
import {homedir} from 'node:os';
import {registerWorkspaceTools} from './tools/workspace.js';
import {ModelPicker} from './presentation/ink/components/ModelPicker.js';
import {ConversationPanel} from './presentation/ink/components/ConversationPanel.js';
import {AssistantPanel} from './presentation/ink/components/AssistantPanel.js';
import {TerminalHeader} from './presentation/ink/components/TerminalHeader.js';
import {InputPrompt} from './presentation/ink/components/InputPrompt.js';
import {ThinkingPanel} from './presentation/ink/components/ThinkingPanel.js';
import {ToolOutputPanel} from './presentation/ink/components/ToolOutputPanel.js';
import {TodoPanel} from './presentation/ink/components/TodoPanel.js';
import {StatsBar} from './presentation/ink/components/StatsBar.js';
import {PermissionManager,type PermissionMode} from './core/permissions/manager.js';
import {approvalPreview} from './presentation/terminal/approval.js';
import {PermissionStatus} from './presentation/ink/components/PermissionStatus.js';
import {DiffApproval} from './presentation/ink/components/DiffApproval.js';
import {PresentationBus} from './presentation/events.js';
import {ExecutionJournal} from './infra/execution-journal.js';
import {CompactionStore} from './infra/compaction.js';
import {registerHistoryTools} from './tools/history.js';
import {ContextManager} from './core/context/manager.js';
import {resolveContextCapability} from './core/context/capabilities.js';
import {ToolArtifacts,registerArtifactTools} from './infra/tool-artifacts.js';
/** Ink terminal interface; the classic readline interface remains at npm run dev:classic. */
import 'dotenv/config';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {render, Box, Text, useApp, useInput} from 'ink';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {Agent, type AgentEvent} from './core/agent.js';
import {PROVIDERS, providerById, modelFor, loadSelection, saveSelection, type Selection} from './core/providers.js';
import type {Model} from './core/types.js';
import {ToolRegistry} from './core/registry.js';
import {Workspace} from './infra/files.js';
import {diffPreview} from './infra/diff.js';
import {TodoStore, registerTodoTools} from './infra/todos.js';
import {loadLayeredSkills} from './infra/skills.js';
import {loadSession, saveSession} from './infra/memory.js';
import {ScopedMemory} from './infra/scoped-memory.js';
import {registerMemoryTools} from './tools/memory.js';
import {registerLocalTools} from './tools/local.js';
import {registerCommandTools} from './tools/command.js';
import {connectMcpStdio} from './infra/mcp.js';
import {CredentialStore} from './infra/credentials.js';
import {discoverModels, type ModelCatalog} from './core/model-discovery.js';

type Line = {id:number;kind:'user'|'assistant'|'tool'|'info'|'error';text:string};
type OutputView = {id:string;offset:number;total:number;content:string;query:string};
type PendingApproval = {name:string;args:unknown;preview:string;resolve:(ok:boolean)=>void};
type ThinkingMode = 'expanded'|'collapsed'|'hidden';
type Picker = {kind:'providers'} | {kind:'models';provider:string} | {kind:'key';provider:string;model:string} | {kind:'save';provider:string;model:string;key:string} | {kind:'manual';provider:string};
const cutoff=(s:string,n=6000)=>s.length>n?s.slice(-n):s;
const selectionPath=resolve(process.env.AGENT_MODEL_STATE_FILE??resolve(homedir(),'.config/mini-agent/model-selection.json'));

function TerminalApp(){
  const {exit}=useApp();
  const [draft,setDraft]=useState('');
  const [commandHistory,setCommandHistory]=useState<string[]>([]);
  const [historyIndex,setHistoryIndex]=useState(-1);
  const draftBeforeHistory=useRef('');
  const [picker,setPicker]=useState<Picker|null>(null);
  const [pickerIndex,setPickerIndex]=useState(0);
  const [catalog,setCatalog]=useState<ModelCatalog|null>(null);
  const [catalogLoading,setCatalogLoading]=useState(false);
  const discoverySerial=useRef(0);
  const [secret,setSecret]=useState('');
  const [manualId,setManualId]=useState('');
  const projectStateRef=useRef<ProjectState|null>(null);
  const credentialsRef=useRef<CredentialStore|null>(null);
  const [lines,setLines]=useState<Line[]>([]);
  const [outputs,setOutputs]=useState<Array<{id:string;name:string}>>([]);
  const [outputView,setOutputView]=useState<OutputView|null>(null);
  const artifactsRef=useRef<ToolArtifacts|null>(null);
  const [mode,setMode]=useState<ThinkingMode>('expanded');
  const [thinking,setThinking]=useState('');
  const [thinkingSource,setThinkingSource]=useState('');
  const [answer,setAnswer]=useState('');
  const [step,setStep]=useState(0);
  const [busy,setBusy]=useState(false);
  const [ready,setReady]=useState(false);
  const [approval,setApproval]=useState<PendingApproval|null>(null);
  const [approvalOffset,setApprovalOffset]=useState(0);
  const [permissionMode,setPermissionMode]=useState<PermissionMode>('ask');
  const permissionRef=useRef<PermissionManager|null>(null);
  const workspaceRef=useRef<Workspace|null>(null);
  const [workspaceDisplay,setWorkspaceDisplay]=useState({root:process.cwd(),extra:0});
  const busRef=useRef(new PresentationBus());
  const [selection,setSelection]=useState<Selection>({provider:'deepseek',model:'deepseek-chat'});
  const [stats,setStats]=useState({modelCalls:0,toolCalls:0,totalTokens:0,lastRunMs:0});
  const [tasks,setTasks]=useState<Array<{title:string;status:string}>>([]);
  const nextId=useRef(0);
  const agentRef=useRef<Agent|null>(null);
  const contextRef=useRef<ContextManager|null>(null);
  const sessionRef=useRef('default');
  const registryRef=useRef<ToolRegistry|null>(null);
  const memoryRef=useRef<ScopedMemory|null>(null);
  const todoRef=useRef<TodoStore|null>(null);
  const controllerRef=useRef<AbortController|null>(null);
  const cleanupRef=useRef<(()=>Promise<void>)|null>(null);
  const activeRef=useRef(false);
  const add=useCallback((kind:Line['kind'],text:string)=>setLines(old=>[...old.slice(-32),{id:++nextId.current,kind,text}]),[]);
  const refresh=useCallback(()=>{
    if(agentRef.current)setStats({...agentRef.current.metrics});
    if(todoRef.current)setTasks(todoRef.current.list().map(t=>({title:t.title,status:t.status})));
  },[]);
  const emit=useCallback((e:AgentEvent)=>{
    busRef.current.emit({kind:'agent',event:e});
    if(e.type==='step'){setStep(e.step);setAnswer('');setThinking('');setThinkingSource('');}
    if(e.type==='text')setAnswer(v=>cutoff(v+e.text,12000));
    if(e.type==='thinking'){setThinking(v=>cutoff(v+e.text,10000));setThinkingSource(e.source);}
    if(e.type==='tool_start')add('tool',`▶ ${e.name} ${JSON.stringify(e.args).slice(0,180)}`);
    if(e.type==='tool_end'){if(e.name==='request_write_directory' && workspaceRef.current)setWorkspaceDisplay({root:workspaceRef.current.root,extra:workspaceRef.current.listWritable().length-1});if(e.artifactId)setOutputs(v=>[...v.slice(-49),{id:e.artifactId!,name:e.name}]);add('tool',`✓ ${e.name} ${(e.ms/1000).toFixed(2)}s — ${e.result.replace(/\n/g,' ').slice(0,130)}`);refresh();}
    if(e.type==='compact')add('info',`上下文压缩：移除 ${e.removedMessages} 条旧消息`);
    if(e.type==='context')add('info',`上下文约 ${e.estimatedTokens}/${e.budget} Token · 召回 ${e.recalledMemories} 条记忆 · 截断 ${e.truncatedToolResults} 条工具结果`);
    if(e.type==='usage')setStats(v=>({...v,totalTokens:v.totalTokens+e.usage.totalTokens}));
  },[add,refresh]);
  useEffect(()=>{
    let mounted=true;
    (async()=>{
      const choice=await loadSelection(selectionPath);
      const credentials=await CredentialStore.open(resolve(process.env.AGENT_CREDENTIALS_FILE??resolve(homedir(),'.config/mini-agent/credentials.json')));
      credentialsRef.current=credentials;
      const workspace=await Workspace.create(resolve(process.env.AGENT_WORKSPACE??process.cwd()));
      const projectState=await ProjectState.open(workspace.root);projectStateRef.current=projectState;
      workspaceRef.current=workspace;setWorkspaceDisplay({root:workspace.root,extra:workspace.listWritable().length-1});
      const registry=new ToolRegistry(); registryRef.current=registry;
      const permissions=new PermissionManager(projectState.path('approvals',`${process.env.AGENT_SESSION_ID??'default'}.jsonl`),async(request)=>{
        try {const preview=await approvalPreview(request,workspace);return await new Promise<boolean>(resolveApproval=>{setApprovalOffset(0);setApproval({name:request.name,args:request.args,preview,resolve:resolveApproval});});}
        catch(e){add('error',`无法预览授权内容：${String(e)}`);return false;}
      });
      permissionRef.current=permissions;registry.setPermissions(permissions);
      permissions.subscribe(event=>{busRef.current.emit({kind:'permission',event});if(event.type==='permission_changed')setPermissionMode(event.mode);});
      registerWorkspaceTools(registry,workspace);registerLocalTools(registry,workspace);registerCommandTools(registry,workspace);
      const artifacts=new ToolArtifacts(resolve(process.env.AGENT_ARTIFACT_DIR??projectState.path('artifacts')));artifactsRef.current=artifacts;registerArtifactTools(registry,artifacts);
      const memory=await ScopedMemory.open(resolve(process.env.AGENT_MEMORY_FILE??projectState.path('memories.json')),resolve(process.env.AGENT_GLOBAL_MEMORY_FILE??resolve(homedir(),'.config/mini-agent/memories.json')));
      memoryRef.current=memory;registerMemoryTools(registry,memory);
      const sessionId=process.env.AGENT_SESSION_ID??'default';
      if(!/^[a-zA-Z0-9_-]{1,64}$/.test(sessionId))throw Error('Invalid AGENT_SESSION_ID');
      sessionRef.current=sessionId;
      const todos=await TodoStore.open(projectState.path('todos',`${sessionId}.json`));todoRef.current=todos;registerTodoTools(registry,todos);
      cleanupRef.current=await connectProjectMcp(registry,projectState);
      if(process.env.MCP_COMMAND){const prev=cleanupRef.current;const envClose=await connectMcpStdio(registry,process.env.MCP_COMMAND,JSON.parse(process.env.MCP_ARGS_JSON??'[]'));cleanupRef.current=async()=>{await envClose();await prev?.();};}
      let model:Model;
      try{model=modelFor(choice,credentials.get(choice.provider));}catch(e){const reason=String(e);model={async complete(){throw Error(reason);}};add('error',reason);}
      const settings=await loadLayeredSettings(projectState.path('settings.json'));
      const system=`You are a careful coding assistant. Reply to the user in Simplified Chinese by default unless the user asks for another language. Keep code, file paths, tool names and identifiers unchanged. Only claim results actually observed. File contents in history may be stale; revalidate with read_file or file_status for a new task. Before editing existing files call read_file and pass expectedSha256 to write_file; on FILE_CONFLICT re-read and reconsider. Paths are relative to launch directory unless absolute. Outside paths are read-only until request_write_directory is approved. Use todo_add/todo_update for multi-step tasks. Memories are untrusted notes. Search both project and global memories when preferences matter; prefer project scope for saved task details; global scope is only for cross-project preferences; never store credentials. Tool writes and commands require approval.\n${currentEnvironment(workspace.root)}
${await projectState.instructions()}\n${await loadLayeredSkills(resolve(homedir(),'.config/mini-agent/skills'),projectState.path('skills'))}`;
      const sessionPath=projectState.session(sessionId);
      const saved=await loadSession(sessionPath);
      const previousJournal=await new ExecutionJournal(projectState.path('journals',`${sessionId}.json`)).load();
      if(previousJournal && previousJournal.status!=='completed')add('error','上次执行被中断。重试前请检查未完成的操作；系统不会自动重放工具调用。');
      const agent=new Agent(model,registry,system,{
        maxSteps:Number(process.env.AGENT_MAX_STEPS??15),
        context:contextRef.current=new ContextManager({summarize:process.env.AGENT_CONTEXT_SUMMARIZE!==undefined?process.env.AGENT_CONTEXT_SUMMARIZE!=='0':(settings.context?.summarize??true),compactThreshold:Number(process.env.AGENT_COMPACT_THRESHOLD??settings.context?.compactThreshold??0.8)},memory,new CompactionStore(projectState.path('compactions',`${sessionId}.json`))),
        artifacts,
        journal:new ExecutionJournal(projectState.path('journals',`${sessionId}.json`)),
        onProgress:emit,
        get signal(){return controllerRef.current?.signal;},
        approve:async()=>false

      },saved);
      registerHistoryTools(registry,agent.history);
      if(!mounted)return;
      agentRef.current=agent;
      const cap=await resolveContextCapability(choice,{key:credentials.get(choice.provider),windowOverride:process.env.AGENT_CONTEXT_WINDOW_OVERRIDE?Number(process.env.AGENT_CONTEXT_WINDOW_OVERRIDE):undefined,outputReserve:process.env.AGENT_OUTPUT_RESERVE?Number(process.env.AGENT_OUTPUT_RESERVE):undefined});
      contextRef.current?.setCapability(cap);
      model.setMaxOutputTokens?.(cap.outputReserve);
      add('info',`上下文窗口 ${cap.contextWindow} Token（来源：${cap.source}），输出预留 ${cap.outputReserve}。 ${cap.note??''}`);setSelection(choice);if(credentials.status(choice.provider)==='missing'){setPicker({kind:'key',provider:choice.provider,model:choice.model});add('info',`请先配置 ${providerById(choice.provider).label} 的 API Key。`);}
      setTasks(todos.list().map(t=>({title:t.title,status:t.status})));setReady(true);
      add('info',`工作区：${workspace.root} · 会话：${sessionId}`);
    })().catch(e=>add('error',`初始化失败：${String(e)}`));
    return ()=>{mounted=false;void cleanupRef.current?.();};
  },[add,emit]);
  const switchModel=useCallback(async(provider:string,model:string,key?:string)=>{
    try{
      const next={provider,model};
      const instance=modelFor(next,key??credentialsRef.current?.get(provider));
      const cap=await resolveContextCapability(next,{key:key??credentialsRef.current?.get(provider),windowOverride:process.env.AGENT_CONTEXT_WINDOW_OVERRIDE?Number(process.env.AGENT_CONTEXT_WINDOW_OVERRIDE):undefined,outputReserve:process.env.AGENT_OUTPUT_RESERVE?Number(process.env.AGENT_OUTPUT_RESERVE):undefined});
      contextRef.current?.setCapability(cap);
      instance.setMaxOutputTokens?.(cap.outputReserve);
      agentRef.current?.setModel(instance);
      add('info',`上下文窗口 ${cap.contextWindow} Token（来源：${cap.source}）；输出预留 ${cap.outputReserve}。 ${cap.note??''}`);
      await saveSelection(selectionPath,next);
      setSelection(next);
      add('info',`已切换为 ${provider}/${model}；会话与长期记忆已保留。`);
      setPicker(null);setSecret('');setPickerIndex(0);
    }catch(e){add('error',String(e));}
  },[add]);
  const openModelPicker=useCallback(async(provider:string)=>{
    setPicker({kind:'models',provider});setPickerIndex(0);setCatalog(null);setCatalogLoading(true);
    const serial=++discoverySerial.current;
    const result=await discoverModels({providerId:provider,key:credentialsRef.current?.get(provider)});
    if(serial===discoverySerial.current){setCatalog(result);setCatalogLoading(false);}
  },[]);
  const pickModel=useCallback((provider:string,model:string)=>{
    if(credentialsRef.current?.status(provider)==='missing')setPicker({kind:'key',provider,model});
    else void switchModel(provider,model);
    setPickerIndex(0);
  },[switchModel]);
  const providerOptions=PROVIDERS;
  const pickerOptions=picker?.kind==='providers'?providerOptions.map(p=>`${p.label} (${p.id}) · ${credentialsRef.current?.status(p.id)==='missing'?'需要密钥':credentialsRef.current?.status(p.id)}`):picker?.kind==='models'?(catalog?.models.map(m=>m.label===m.id?m.id:`${m.label} (${m.id})`)??[]):[];
  const openOutput=useCallback(async(id:string,offset=0,query='')=>{
    try {
      const value=await artifactsRef.current!.read(id,offset,3000);
      const header=value.indexOf('\n');
      const match=/chars=(\d+)/.exec(value.slice(0,header));
      setOutputView({id,offset,total:Number(match?.[1]??0),content:value.slice(header+1),query});
    } catch(e){add('error',String(e));}
  },[add]);
  const submit=useCallback(async(input:string)=>{
    const cmd=input.trim();if(!cmd||!ready||busy)return;
    setCommandHistory(history=>[...history.filter(item=>item!==cmd),cmd].slice(-100));
    setHistoryIndex(-1);draftBeforeHistory.current='';
    setDraft('');
    if(cmd==='/exit'){exit();return;}
    if(cmd==='/thinking'||cmd.startsWith('/thinking ')){
      const arg=cmd.split(/\s+/)[1];if(arg==='on')setMode('expanded');else if(arg==='off')setMode('hidden');else if(arg==='collapse')setMode('collapsed');else setMode(v=>v==='expanded'?'collapsed':v==='collapsed'?'hidden':'expanded');return;
    }
    if(cmd==='/outputs'){add('info',outputs.length?outputs.map(v=>`${v.name}: ${v.id}`).join('\n'):'当前界面会话没有工具输出归档');return;}
    if(cmd.startsWith('/output ')){const [,id,offset]=cmd.split(/\s+/);await openOutput(id,Number(offset??0));return;}
    if(cmd==='/close-output'){setOutputView(null);return;}
    if(cmd==='/help'){add('info','命令帮助：/dirs 查看可写目录 · /addDir <路径> 授权目录 · /model 选择模型 · /model <供应商> [模型ID] · /models 选择供应商 · /refresh-models 刷新模型 · /key <供应商> 设置密钥 · /permission 查看/切换权限 · /thinking 切换思考 · /outputs 查看归档 · /output <id> [偏移] 查看输出 · /close-output 关闭输出 · /memories 查看记忆 · /todos 待办 · /stats 统计 · /reset 清空对话 · /exit 退出');return;}
    if(cmd==='/refresh-models'){void openModelPicker(selection.provider);return;}
    if(cmd==='/models'){setPicker({kind:'providers'});setPickerIndex(0);return;}
    if(cmd.startsWith('/key ')){try{const p=providerById(cmd.split(/\s+/)[1]);setPicker({kind:'key',provider:p.id,model:selection.provider===p.id?selection.model:p.defaultModel});setSecret('');}catch(e){add('error',String(e));}return;}
    if(cmd.startsWith('/permission')){const v=cmd.split(/\s+/)[1];if(v==='read-only'||v==='ask'||v==='allow'){permissionRef.current?.setMode(v);add('info',`本次运行权限已切换为 ${v}`);}else add('info',`当前权限：${permissionRef.current?.getMode()??'ask'} · /permission read-only|ask|allow`);return;}
    if(cmd==='/dirs'||cmd==='dirs'){add('info',`主工作区：${workspaceRef.current?.root}\n可写目录：\n${workspaceRef.current?.listWritable().join('\n')}`);return;}
    if(cmd.startsWith('/addDir ')||cmd.startsWith('addDir ')){
      const requested=cmd.replace(/^\/?addDir\s+/, '').trim();
      const workspace=workspaceRef.current!;
      try{
        const target=await workspace.safePath(requested);
        const {stat}=await import('node:fs/promises');
        let missing=false;
        try {if(!(await stat(target)).isDirectory())throw Error('该路径不是目录');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')missing=true;else throw e;}
        const preview=`目录：${target}\n${missing?'该目录不存在，授权时需要创建。':'该目录已存在。'}\n是否允许递归写入该目录？`;
        const accepted=await new Promise<boolean>(done=>{setApprovalOffset(0);setApproval({name:'request_write_directory',args:{path:target,createIfMissing:missing},preview,resolve:done});});
        if(accepted){add('info',`已授权可写目录：${await workspace.addDirectory(target,missing)}`);setWorkspaceDisplay({root:workspace.root,extra:workspace.listWritable().length-1});}
        else add('info','已拒绝目录写入授权');
      }catch(e){add('error',String(e));}return;
    }
    if(cmd==='/tools'){add('info',registryRef.current?.list().map(t=>t.name).join(', ')??'');return;}
    if(cmd==='/todos'){refresh();add('info',todoRef.current?.list().map(t=>`${t.status} ${t.title}`).join('\n')||'暂无待办事项');return;}
    if(cmd==='/memories'||cmd.startsWith('/memories ')){const scope=cmd.split(/\s+/)[1];if(scope&&scope!=='project'&&scope!=='global'){add('error','用法：/memories [project|global]（项目记忆/全局记忆）');return;}add('info',JSON.stringify(memoryRef.current?.list(scope as 'project'|'global'|undefined)??[],null,2).slice(0,10000));return;}
    if(cmd==='/stats'){refresh();add('info',JSON.stringify(agentRef.current?.metrics??{},null,2));return;}
    if(cmd==='/reset'){const agent=agentRef.current;if(agent){agent.history.splice(1);await saveSession(projectStateRef.current!.session(sessionRef.current),agent.history);await todoRef.current?.clear();refresh();add('info','对话和待办已清空，长期记忆已保留。');}return;}
    if(cmd==='/model'||cmd.startsWith('/model ')){
      const [,id,custom]=cmd.split(/\s+/);if(!id){setPicker({kind:'providers'});setPickerIndex(0);return;}
      try{const provider=providerById(id);if(!custom){void openModelPicker(id);}else pickModel(provider.id,custom);}catch(e){add('error',String(e));}return;
    }
    add('user',cmd);setBusy(true);setThinking('');setAnswer('');setStep(0);
    const controller=new AbortController();controllerRef.current=controller;
    try{const result=await agentRef.current!.run(cmd);add('assistant',result);}catch(e){add('error',String(e));}
    finally{controllerRef.current=null;setBusy(false);refresh();await saveSession(projectStateRef.current!.session(sessionRef.current),agentRef.current!.history);}
  },[ready,busy,selection,add,refresh,exit,pickModel,outputs,openOutput]);
  useInput((input,key)=>{
    if(outputView&&!picker&&!approval){
      if(key.escape){setOutputView(null);return;}
      if(key.downArrow||key.pageDown){void openOutput(outputView.id,Math.min(Math.max(0,outputView.total-1),outputView.offset+3000),outputView.query);return;}
      if(key.upArrow||key.pageUp){void openOutput(outputView.id,Math.max(0,outputView.offset-3000),outputView.query);return;}
      if(input==='/'&&!key.ctrl){setOutputView(v=>v?{...v,query:''}:v);return;}
      if(outputView.query!==undefined&&input==='n'&&outputView.query){const pos=outputView.content.indexOf(outputView.query);if(pos>=0)void openOutput(outputView.id,outputView.offset+pos+outputView.query.length,outputView.query);return;}
    }
    if(picker){
      if(picker.kind==='manual'){
        if(key.escape){setPicker({kind:'models',provider:picker.provider});setManualId('');return;}
        if(key.return){const id=manualId.trim();if(id){pickModel(picker.provider,id);setManualId('');}return;}
        if(key.backspace||key.delete){setManualId(v=>v.slice(0,-1));return;}
        if(!key.ctrl&&!key.meta&&input)setManualId(v=>(v+input).slice(0,300));return;
      }
      if(picker.kind==='models'&&input.toLowerCase()==='m'){setPicker({kind:'manual',provider:picker.provider});setManualId('');return;}
      if(picker.kind==='models'&&input.toLowerCase()==='r'){void openModelPicker(picker.provider);return;}
      if(key.escape){++discoverySerial.current;setPicker(null);setCatalogLoading(false);setSecret('');return;}
      if(picker.kind==='key'){
        if(key.return){if(!secret.trim()){add('error','请输入非空 API Key');return;}setPicker({kind:'save',provider:picker.provider,model:picker.model,key:secret});setSecret('');return;}
        if(key.backspace||key.delete){setSecret(v=>v.slice(0,-1));return;}
        if(!key.ctrl&&!key.meta&&input)setSecret(v=>(v+input).slice(0,8192));return;
      }
      if(picker.kind==='save'){
        if(input.toLowerCase()==='s'||input.toLowerCase()==='t'){
          const persist=input.toLowerCase()==='s';
          const {provider,model,key:apiKey}=picker;
          void (async()=>{try{await credentialsRef.current!.set(provider,apiKey,persist);await switchModel(provider,model,persist?undefined:apiKey);add('info',persist?'密钥已保存到本地（0600 权限；未加密）。':'密钥仅在当前进程中使用。');}catch(e){add('error',String(e));setPicker({kind:'key',provider,model});}})();
        }return;
      }
      if(key.upArrow){if(pickerOptions.length)setPickerIndex(v=>(v+pickerOptions.length-1)%pickerOptions.length);return;}
      if(key.downArrow){if(pickerOptions.length)setPickerIndex(v=>(v+1)%pickerOptions.length);return;}
      const numeric=/^[1-9]$/.test(input)?Number(input)-1:undefined;
      if(key.return||numeric!==undefined){const index=numeric??pickerIndex;if(index>=pickerOptions.length)return;
        if(picker.kind==='providers'){void openModelPicker(PROVIDERS[index].id);}
        else if(catalog?.models[index])pickModel(picker.provider,catalog.models[index].id);return;
      }
      return;
    }
    if(approval){if(key.downArrow){setApprovalOffset(v=>v+1);return;}if(key.upArrow){setApprovalOffset(v=>Math.max(0,v-1));return;}if(key.pageDown){setApprovalOffset(v=>v+15);return;}if(key.pageUp){setApprovalOffset(v=>Math.max(0,v-15));return;}if(key.ctrl&&input==='c'){approval.resolve(false);setApproval(null);controllerRef.current?.abort();return;}if(input.toLowerCase()==='y') {approval.resolve(true);setApproval(null);}else if(input.toLowerCase()==='n'||key.escape){approval.resolve(false);setApproval(null);}return;}
    if(key.ctrl&&input==='t'){setMode(v=>v==='expanded'?'collapsed':v==='collapsed'?'hidden':'expanded');return;}
    if(key.ctrl&&input==='c'){controllerRef.current?.abort();return;}
    if(busy||!ready)return;
    if(key.upArrow){
      if(!commandHistory.length)return;
      setHistoryIndex(index=>{
        const next=index<0?commandHistory.length-1:Math.max(0,index-1);
        if(index<0)draftBeforeHistory.current=draft;
        setDraft(commandHistory[next]);return next;
      });return;
    }
    if(key.downArrow){
      setHistoryIndex(index=>{
        if(index<0)return index;
        const next=index+1;
        if(next>=commandHistory.length){setDraft(draftBeforeHistory.current);draftBeforeHistory.current='';return -1;}
        setDraft(commandHistory[next]);return next;
      });return;
    }
    if(key.return){void submit(draft);return;}
    if(key.backspace||key.delete){setHistoryIndex(-1);draftBeforeHistory.current='';setDraft(v=>v.slice(0,-1));return;}
    if(key.escape){setHistoryIndex(-1);draftBeforeHistory.current='';setDraft('');return;}
    if(!key.ctrl&&!key.meta&&input&& !key.leftArrow&&!key.rightArrow){setHistoryIndex(-1);draftBeforeHistory.current='';setDraft(v=>(v+input).slice(0,Number(process.env.AGENT_MAX_INPUT_CHARS??65536)));}
  });
  const recent=lines.slice(-12);
  return <Box flexDirection="column" paddingX={1}>
    <TerminalHeader provider={selection.provider} model={selection.model} session={sessionRef.current} mode={mode} permission={permissionMode} workspaceRoot={workspaceDisplay.root} extraWritable={workspaceDisplay.extra}/>
    <ToolOutputPanel view={outputView}/>
    <ConversationPanel lines={recent}/>
    <ThinkingPanel mode={mode} thinking={thinking} thinkingSource={thinkingSource} busy={busy} step={step}/>
    <AssistantPanel busy={busy} answer={answer}/>
    <TodoPanel tasks={tasks}/>
    <StatsBar stats={stats}/>
    <ModelPicker picker={picker} pickerOptions={pickerOptions} pickerIndex={pickerIndex} catalogLoading={catalogLoading} catalog={catalog} manualId={manualId} secret={secret}/>
    {approval?<DiffApproval name={approval.name} preview={approval.preview} offset={approvalOffset}/>:<InputPrompt busy={busy} ready={ready} picking={!!picker} draft={draft}/>}
  </Box>;
}
render(<TerminalApp/>);
