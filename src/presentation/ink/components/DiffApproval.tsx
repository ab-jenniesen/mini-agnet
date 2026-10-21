import React from 'react';
import {Box,Text} from 'ink';
export function DiffApproval({name,preview,offset,rows=18}:{name:string;preview:string;offset:number;rows?:number}){
 const lines=preview.split('\n');const top=Math.max(0,Math.min(offset,Math.max(0,lines.length-rows)));
 return <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
   <Text bold color="yellow">需要授权：{name} · 行 {top+1}-{Math.min(lines.length,top+rows)}/{lines.length}</Text>
   {lines.slice(top,top+rows).map((line,i)=><Text key={top+i} color={line.startsWith('+')?'green':line.startsWith('-')?'red':undefined}>{line||' '}</Text>)}
   <Text dimColor>↑↓ 滚动 · PageUp/PageDown 翻页 · Y 同意 · N/Esc 拒绝</Text>
 </Box>;
}
