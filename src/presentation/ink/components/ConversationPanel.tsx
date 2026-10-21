import React from 'react';import {Box,Text,useStdout} from 'ink';
type Line={id:number;kind:'user'|'assistant'|'tool'|'info'|'error';text:string};
export function ConversationPanel({lines}:{lines:Line[]}){
 const {stdout}=useStdout();const width=Math.max(36,(stdout.columns??100)-6);
 const visible=lines.slice(-8);
 if(!visible.length)return <Box marginTop={1}><Text dimColor>准备就绪 · 输入任务开始对话</Text></Box>;
 return <Box flexDirection="column" marginTop={1}>
  {visible.map(l=>{
   const color=l.kind==='error'?'red':l.kind==='user'?'green':l.kind==='tool'?'cyan':l.kind==='assistant'?'white':'gray';
   const label=l.kind==='user'?'你':l.kind==='assistant'?'助手':l.kind==='tool'?'工具':l.kind==='error'?'错误':'提示';
   const content=l.text.length>2400?`…${l.text.slice(-2400)}`:l.text;
   const chunks=content.split('\n').flatMap(row=>{const out:string[]=[];for(let i=0;i<row.length;i+=width)out.push(row.slice(i,i+width));return out.length?out:[''];});
   return <Box key={l.id} flexDirection="column" marginBottom={1}>
    <Text color={color} bold>{label}</Text>
    {chunks.map((row,i)=><Text key={i} color={color} wrap="truncate">{row}</Text>)}
   </Box>;
  })}
 </Box>;
}
