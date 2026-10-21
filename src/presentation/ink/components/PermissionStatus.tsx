import React from 'react';
import {Text} from 'ink';
import type {PermissionMode} from '../../../core/permissions/manager.js';
export function PermissionStatus({mode}:{mode:PermissionMode}){
 return <Text color={mode==='read-only'?'red':mode==='ask'?'yellow':'green'}>权限：{mode==='read-only'?'只读':mode==='ask'?'写入前询问':'自动允许写入'} （执行命令始终需要审批）</Text>;
}
