import type {PresentationEvent} from './events.js';
import type {PermissionMode} from '../core/permissions/manager.js';
/** Pure projection: an arbitrary UI framework can render these states. */
export type PresentationState={permission:PermissionMode;thinking:string;answer:string;step:number;toolEvents:Array<{name:string;status:'running'|'finished';ms?:number}>;notices:string[]};
export const initialPresentationState=():PresentationState=>({permission:'ask',thinking:'',answer:'',step:0,toolEvents:[],notices:[]});
export function reducePresentation(state:PresentationState,input:PresentationEvent):PresentationState{
 if(input.kind==='permission')return input.event.type==='permission_changed'?{...state,permission:input.event.mode}:state;
 if(input.kind==='message')return {...state,notices:[...state.notices.slice(-99),input.text]};
 const event=input.event;
 switch(event.type){
 case 'step':return {...state,step:event.step,thinking:'',answer:''};
 case 'text':return {...state,answer:state.answer+event.text};
 case 'thinking':return {...state,thinking:state.thinking+event.text};
 case 'tool_start':return {...state,toolEvents:[...state.toolEvents.slice(-99),{name:event.name,status:'running'}]};
 case 'tool_end':return {...state,toolEvents:[...state.toolEvents.slice(-99),{name:event.name,status:'finished',ms:event.ms}]};
 default:return state;
 }
}
