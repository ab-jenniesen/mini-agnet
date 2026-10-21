import React from 'react';import {Box,Text,useStdout} from 'ink';
import {PermissionStatus} from './PermissionStatus.js';
import {WorkspaceStatus} from './WorkspaceStatus.js';
import type {PermissionMode} from '../../../core/permissions/manager.js';
export function TerminalHeader({provider,model,session,mode,permission,workspaceRoot,extraWritable}:{provider:string;model:string;session:string;mode:string;permission:PermissionMode;workspaceRoot:string;extraWritable:number}){
 const {stdout}=useStdout();
 const narrow=(stdout.columns??100)<86;
 const shortRoot=workspaceRoot.length>(narrow?42:72)?`…${workspaceRoot.slice(-(narrow?39:69))}`:workspaceRoot;
 return <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
 <Box justifyContent="space-between"><Text bold color="cyan">Mini Agent <Text dimColor>v1 · {provider}/{model}</Text></Text><Text dimColor>会话 {session}</Text></Box>
 <Box flexDirection={narrow?'column':'row'} justifyContent="space-between"><PermissionStatus mode={permission}/><Text dimColor>思考 {mode==='expanded'?'展开':mode==='collapsed'?'折叠':'隐藏'} · Ctrl+T</Text></Box>
 <Text dimColor>工作区：{shortRoot} · 额外可写目录：{extraWritable}{narrow?'':' · /dirs 查看 · /addDir 授权'}</Text>
 <Text dimColor>{narrow?'/help 帮助 · Ctrl+C 取消':'/help 帮助 · /permission 权限 · Ctrl+C 取消任务'}</Text>
 </Box>;
}
