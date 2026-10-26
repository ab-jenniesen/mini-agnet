import type { Tool } from '../model/types.js';

export type PermissionMode = 'read-only' | 'ask' | 'allow';
export type ApprovalDecision = 'approved' | 'denied' | 'auto' | 'blocked';
export type ApprovalRequest = {
  id: string;
  toolCallId?: string;
  name: string;
  args: Record<string, unknown>;
  mode: PermissionMode;
  proposedSha256?: string;
};
export type ApprovalPresenter = (request: ApprovalRequest) => Promise<boolean>;
export type PermissionEvent =
  | { type: 'permission_changed'; mode: PermissionMode }
  | { type: 'approval_result'; request: ApprovalRequest; decision: ApprovalDecision };

export type PermissionAuditRecord = {
  timestamp: string;
  id: string;
  toolCallId?: string;
  name: string;
  mode: PermissionMode;
  decision: ApprovalDecision;
  proposedSha256?: string;
  path?: string;
};

export interface PermissionAuditPort {
  write(record: PermissionAuditRecord): Promise<void>;
}

/** Authorization policy can be replaced without replacing tools or clients. */
export interface PermissionPort {
  getMode(): PermissionMode;
  setMode(mode: PermissionMode): void;
  subscribe(listener: (event: PermissionEvent) => void): () => void;
  authorize(
    tool: Tool,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<{ allowed: boolean; decision: ApprovalDecision; request: ApprovalRequest }>;
}
