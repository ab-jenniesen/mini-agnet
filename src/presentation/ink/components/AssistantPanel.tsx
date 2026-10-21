import React from 'react';import {Box,Text,useStdout} from 'ink';
export function AssistantPanel({busy,answer}:{busy:boolean;answer:string}){
 if(!busy&&!answer)return null;
 const {stdout}=useStdout();const narrow=(stdout.columns??100)<70;
 return <Box marginTop={1} borderStyle="round" borderColor="green" flexDirection="column" paddingX={1}>
  <Box justifyContent="space-between"><Text color="green" bold>{busy?'正在生成':'最新回复'}</Text><Text dimColor>{busy?'Ctrl+C 取消':`${answer.length} 字符`}</Text></Box>
  <Text>{answer.slice(-(narrow?1400:2600))||'正在等待模型响应…'}</Text>
 </Box>;
}
