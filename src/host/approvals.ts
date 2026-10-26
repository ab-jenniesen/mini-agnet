import type { ApprovalView, RuntimeEvent } from '../protocol/contracts.js';

/** Requests remain in the host; clients only receive data and reply by ID. */
export class ApprovalQueue {
  private readonly pending = new Map<
    string,
    { view: ApprovalView; resolve: (accepted: boolean) => void }
  >();

  constructor(private readonly emit: (event: RuntimeEvent) => void) {}

  list(): ApprovalView[] {
    return structuredClone([...this.pending.values()].map((entry) => entry.view));
  }

  request(view: ApprovalView, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const abort = () => this.respond(view.request.id, false);
      this.pending.set(view.request.id, {
        view,
        resolve: (accepted) => {
          signal?.removeEventListener('abort', abort);
          resolve(accepted);
        },
      });
      signal?.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'approval_requested', approval: structuredClone(view) });
    });
  }

  respond(id: string, accepted: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    entry.resolve(accepted);
    this.emit({ type: 'approval_resolved', id, accepted });
    return true;
  }

  cancelAll(): void {
    for (const id of this.pending.keys()) this.respond(id, false);
  }
}
