/** Transport-neutral presentation contracts. No Ink, DOM or terminal dependencies. */
import type {AgentEvent} from '../core/agent.js';
import type {PermissionEvent,ApprovalRequest} from '../core/permissions/manager.js';
export type PresentationEvent =
 | {kind:'agent';event:AgentEvent}
 | {kind:'permission';event:PermissionEvent}
 | {kind:'message';level:'info'|'error';text:string};
export class PresentationBus {
 private listeners=new Set<(event:PresentationEvent)=>void>();
 emit(e:PresentationEvent){for(const listener of this.listeners)listener(e);}
 subscribe(listener:(event:PresentationEvent)=>void){this.listeners.add(listener);return ()=>this.listeners.delete(listener);}
}
export type ApprovalUI={requestApproval(request:ApprovalRequest):Promise<boolean>};
