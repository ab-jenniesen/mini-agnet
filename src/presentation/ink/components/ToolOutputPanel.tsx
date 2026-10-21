import React from 'react';import {Box,Text} from 'ink';
export function ToolOutputPanel({view}:{view:{id:string;offset:number;total:number;content:string}|null}){
 if(!view)return null;
 return <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
 <Text color="yellow" bold>工具输出归档 {view.id.slice(0,8)} · {view.offset}/{view.total} 字符</Text>
 <Text>{view.content.slice(0,3000)}</Text>
 <Text dimColor>↑↓ 每次翻页 3000 字符 · Esc 关闭 · /output ID OFFSET</Text>
 </Box>;
}
