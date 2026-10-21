import React from 'react';import {Box,Text} from 'ink';
export function ThinkingPanel({mode,thinking,thinkingSource,busy,step}:{mode:'expanded'|'collapsed'|'hidden';thinking:string;thinkingSource:string;busy:boolean;step:number}){
 if(mode==='hidden')return null;
 return <Box marginTop={1} borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
 <Text bold color="magenta">◈ 思考 {busy?`· 第 ${step} 轮`:''} <Text dimColor>{thinkingSource?`(${thinkingSource})`:''}</Text></Text>
 {mode==='expanded'&&<Text dimColor>{thinking?thinking.slice(-1800):'当前模型尚未返回可展示的思考内容（并非所有模型/API 都提供）。'}</Text>}
 {mode==='collapsed'&&<Text dimColor>{thinking?`${thinking.length} 字符 · Ctrl+T 展开`:'尚未收到思考内容'}</Text>}
 </Box>;
}
