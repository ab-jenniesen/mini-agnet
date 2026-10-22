import type {
  AgentClient,
  Command,
  CommandResult,
  RuntimeEvent,
  RuntimeSnapshot,
} from '../../app/contracts.js';

/** Browser-compatible adapter: only fetch, streams and shared type declarations. */
export class HttpAgentClient implements AgentClient {
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  private readonly controller = new AbortController();
  private startup?: Promise<RuntimeSnapshot>;
  private streamTask?: Promise<void>;

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  initialize(): Promise<RuntimeSnapshot> {
    this.startup ??= this.connect();
    return this.startup;
  }

  private async connect(): Promise<RuntimeSnapshot> {
    const response = await fetch(`${this.url}/api/events`, {
      headers: { authorization: `Bearer ${this.token}` },
      signal: this.controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`Event stream HTTP ${response.status}`);
    let resolveInitial!: (state: RuntimeSnapshot) => void;
    let rejectInitial!: (error: unknown) => void;
    let initialized = false;
    const initial = new Promise<RuntimeSnapshot>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    this.streamTask = this.readEvents(response.body, (event) => {
      if (!initialized && event.type === 'state') {
        initialized = true;
        resolveInitial(event.state);
      }
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(event));
        } catch {
          /* view owns errors */
        }
      }
    }).catch((error) => {
      rejectInitial(error);
      if (!this.controller.signal.aborted)
        for (const listener of this.listeners) {
          try {
            listener({ type: 'notice', level: 'error', text: `连接中断：${String(error)}` });
          } catch {
            /* view owns errors */
          }
        }
    });
    return initial;
  }

  private async readEvents(
    body: ReadableStream<Uint8Array>,
    emit: (event: RuntimeEvent) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Event stream closed');
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (data) emit(JSON.parse(data) as RuntimeEvent);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async dispatch<C extends Command>(command: C): Promise<CommandResult<C>> {
    const response = await fetch(`${this.url}/api/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: this.controller.signal,
    });
    const data = (await response.json()) as { result?: CommandResult<C>; error?: string };
    if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
    return (data.result === null ? undefined : data.result) as CommandResult<C>;
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.streamTask;
    this.listeners.clear();
  }
}
