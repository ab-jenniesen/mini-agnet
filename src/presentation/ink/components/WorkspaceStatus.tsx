import React from 'react';
import { Text } from 'ink';
/** Read-only presentation: no filesystem or authorization logic. */
export function WorkspaceStatus({root,extra}:{root:string;extra:number}) {
  return <Text dimColor>工作区：{root} · 额外可写目录：{extra} · /dirs · /addDir &lt;路径&gt;</Text>;
}
