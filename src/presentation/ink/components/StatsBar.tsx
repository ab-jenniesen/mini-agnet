import React from 'react';import {Box,Text} from 'ink';
export function StatsBar({stats}:{stats:{modelCalls:number;toolCalls:number;totalTokens:number;lastRunMs:number}}){
 const tokens=stats.totalTokens?stats.totalTokens.toLocaleString(): 'n/a';
 return <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
  <Text dimColor>模型 {stats.modelCalls} · 工具 {stats.toolCalls}</Text><Text dimColor>Token {tokens} · 最近 {(stats.lastRunMs/1000).toFixed(1)}s</Text>
 </Box>;
}
