import React from 'react';import {Box,Text} from 'ink';
import {providerById} from '../../../core/providers.js';
import type {ModelCatalog} from '../../../core/model-discovery.js';
type Picker = {kind:'providers'} | {kind:'models';provider:string} | {kind:'key';provider:string;model:string} | {kind:'save';provider:string;model:string;key:string} | {kind:'manual';provider:string};
export function ModelPicker({picker,pickerOptions,pickerIndex,catalogLoading,catalog,manualId,secret}:{picker:Picker|null;pickerOptions:string[];pickerIndex:number;catalogLoading:boolean;catalog:ModelCatalog|null;manualId:string;secret:string}){
 if(!picker)return null;
 return <Box borderStyle="double" borderColor="blue" flexDirection="column" paddingX={1} marginTop={1}>
 <Text bold color="blue">{picker.kind==='providers'?'选择模型供应商':picker.kind==='models'?`选择 ${providerById(picker.provider).label} 模型`:picker.kind==='key'?`输入 ${providerById(picker.provider).label} API Key`:picker.kind==='manual'?'输入模型 ID':'保存 API 凭据？'}</Text>
 {picker.kind==='models'&&<Text dimColor>{catalogLoading?'正在获取模型列表…':catalog?.source==='live'?`在线 API · ${catalog.models.length} 个模型`:`使用备用列表 · ${catalog?.note??'API 不可用'}`}</Text>}
 {(picker.kind==='providers'||picker.kind==='models')&&pickerOptions.map((option,i)=><Text key={i} color={i===pickerIndex?'green':undefined}>{i===pickerIndex?'❯':' '} {i+1}. {option}</Text>)}
 {picker.kind==='manual'&&<Text color="green">{manualId}▋ <Text dimColor>回车确认 · Esc 返回</Text></Text>}
 {picker.kind==='key'&&<><Text color="yellow">输入已隐藏，不会写入模型对话历史。按回车继续。</Text><Text>{'●'.repeat(Math.min(secret.length,48))}{secret.length>48?'…':''}</Text></>}
 {picker.kind==='save'&&<><Text>按 S 保存在本机（权限 0600，未加密）；按 T 仅本次运行使用。</Text><Text dimColor>建议使用环境变量或系统密钥管理器提高安全性。</Text></>}
 <Text dimColor>{picker.kind==='providers'||picker.kind==='models'?'↑↓ 选择 · 回车确认 · 1–9 快选 · M 手动输入 ID · R 刷新 · Esc 取消':'Esc 取消'}</Text>
 </Box>;
}
