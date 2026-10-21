import React from 'react';import {Box,Text} from 'ink';
export function InputPrompt({busy,ready,picking,draft}:{busy:boolean;ready:boolean;picking:boolean;draft:string}){
 return <Box marginTop={1} flexDirection="column"><Box><Text color="green">{picking?'正在选择…':busy?'正在执行…':ready?'你 > ':'正在初始化…'} </Text>{!busy&&!picking&&<Text>{draft}<Text color="gray">▋</Text></Text>}</Box>{ready&&!busy&&!picking&&<Text dimColor>↑↓ 浏览命令历史 · Enter 执行 · Esc 清空</Text>}</Box>;
}
