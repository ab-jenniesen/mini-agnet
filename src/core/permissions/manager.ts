import { randomUUID, createHash } from 'node:crypto';
import type { Tool } from '../model/types.js';
import type {
  PermissionMode,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalPresenter,
  PermissionEvent,
  PermissionAuditPort,
  PermissionPort,
} from './ports.js';
export type {
  PermissionMode,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalPresenter,
  PermissionEvent,
} from './ports.js';
export class PermissionManager implements PermissionPort {
  private mode: PermissionMode = 'ask';
  private listeners = new Set<(event: PermissionEvent) => void>();
  constructor(
    private readonly audit: PermissionAuditPort,
    private readonly presenter: ApprovalPresenter,
  ) {}
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
    await this.audit.write(record);
    this.emit({ type: 'approval_result', request, decision });
    return { allowed: decision === 'approved' || decision === 'auto', decision, request };
  }
}
