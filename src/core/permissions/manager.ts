import { randomUUID, createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool } from '../types.js';
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
export class PermissionManager {
  private mode: PermissionMode = 'ask';
  private listeners = new Set<(event: PermissionEvent) => void>();
  constructor(
    private auditPath: string,
    private readonly presenter: ApprovalPresenter,
  ) {}
  setAuditPath(path: string) {
    this.auditPath = path;
  }
  getMode() {
    return this.mode;
  }
  setMode(mode: PermissionMode) {
    if (!['read-only', 'ask', 'allow'].includes(mode)) throw new Error('Invalid permission mode');
    this.mode = mode;
    this.emit({ type: 'permission_changed', mode });
  }
  subscribe(listener: (event: PermissionEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(e: PermissionEvent) {
    for (const l of this.listeners) l(e);
  }
  async authorize(
    tool: Tool,
    args: Record<string, unknown>,
    toolCallId?: string,
  ): Promise<{ allowed: boolean; decision: ApprovalDecision; request: ApprovalRequest }> {
    const request: ApprovalRequest = {
      id: randomUUID(),
      toolCallId,
      name: tool.name,
      args,
      mode: this.mode,
      ...(tool.name === 'write_file' && typeof args.content === 'string'
        ? { proposedSha256: createHash('sha256').update(args.content).digest('hex') }
        : {}),
    };
    // Commands can have arbitrary side effects even without a shell. Always require confirmation unless read-only (deny).
    let decision: ApprovalDecision;
    if (this.mode === 'read-only') decision = 'blocked';
    else if (
      this.mode === 'allow' &&
      tool.name !== 'run_command' &&
      tool.name !== 'request_write_directory' &&
      !tool.name.startsWith('mcp_')
    )
      decision = 'auto';
    else decision = (await this.presenter(request)) ? 'approved' : 'denied';
    await mkdir(dirname(this.auditPath), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      id: request.id,
      toolCallId,
      name: tool.name,
      mode: this.mode,
      decision,
      proposedSha256: request.proposedSha256,
      path: typeof args.path === 'string' ? args.path : undefined,
    };
    await appendFile(this.auditPath, JSON.stringify(record) + '\n', { mode: 0o600 });
    this.emit({ type: 'approval_result', request, decision });
    return { allowed: decision === 'approved' || decision === 'auto', decision, request };
  }
}
