import React from 'react';import {Box,Text} from 'ink';
export function TodoPanel({tasks}:{tasks:Array<{title:string;status:string}>}){
 if(!tasks.length)return null;
 return <Box marginTop={1} flexDirection="column"><Text color="yellow">待办 · {tasks.filter(t=>t.status==='completed').length}/{tasks.length}</Text>{tasks.slice(-5).map((t,i)=><Text key={i} dimColor>{t.status==='completed'?'✓':t.status==='in_progress'?'◉':'○'} {t.title}</Text>)}</Box>;
}
