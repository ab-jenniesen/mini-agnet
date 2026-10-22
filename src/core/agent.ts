import { randomUUID } from 'node:crypto';
import type { AgentMetrics, Message, Model, ModelReply, Tool, ToolCall, Usage } from './types.js';
import type { AgentEvent } from './events.js';
import type { ArtifactPort, ContextPort, JournalPort } from './ports.js';
import { ToolRegistry } from './registry.js';

export type { AgentEvent } from './events.js';
export type { ArtifactPort, ContextPort, JournalPort } from './ports.js';

export type AgentOptions = {
  maxHistoryChars?: number;
  maxInlineToolChars?: number;
  approve?: (name: string, args: unknown) => Promise<boolean>;
  onEvent?: (event: string, detail: unknown) => void;
  onProgress?: (event: AgentEvent) => void;
  onMessage?: (message: Message) => void;
  signal?: AbortSignal;
  context?: ContextPort;
  artifacts?: ArtifactPort;
  journal?: JournalPort;
};

/** Model → tool calls → tool results → model. No UI or storage implementation lives here. */
export class Agent {
  readonly history: Message[];
  readonly metrics: AgentMetrics = {
    modelCalls: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    modelMs: 0,
    toolMs: 0,
    lastRunMs: 0,
  };
  private running = false;

  constructor(
    private model: Model,
    private readonly tools: ToolRegistry,
    systemPrompt: string,
    private readonly options: AgentOptions = {},
    initial: Message[] = [],
  ) {
    // Regenerate machine paths and project instructions when reopening migrated history.
    this.history = [
      { role: 'system', content: systemPrompt },
      ...structuredClone(initial.filter((message) => message.role !== 'system')),
    ];
  }

  setModel(model: Model): void {
    this.model = model;
  }
  setContext(context: ContextPort): void {
    this.options.context = context;
  }
  setJournal(journal: JournalPort): void {
    this.options.journal = journal;
  }

  private append(message: Message): void {
    this.history.push(message);
    this.options.onMessage?.(structuredClone(message));
  }

  async run(input: string): Promise<string> {
    if (this.running) throw new Error('Agent is already running');
    if (!input.trim()) throw new Error('Input must not be empty');
    this.running = true;
    const started = performance.now();
    let turnUsage: Usage | undefined;
    let missingUsage = false;
    // Context summarization makes model calls too; account for them in the same turn.
    const meteredModel: Model = {
      complete: async (messages, tools, options) => {
        const start = performance.now();
        const reply = await this.model.complete(messages, tools, options);
        this.metrics.modelCalls++;
        this.metrics.modelMs += performance.now() - start;
        if (reply.usage) {
          this.metrics.promptTokens += reply.usage.promptTokens;
          this.metrics.completionTokens += reply.usage.completionTokens;
          this.metrics.totalTokens += reply.usage.totalTokens;
          turnUsage = {
            promptTokens: (turnUsage?.promptTokens ?? 0) + reply.usage.promptTokens,
            completionTokens: (turnUsage?.completionTokens ?? 0) + reply.usage.completionTokens,
            totalTokens: (turnUsage?.totalTokens ?? 0) + reply.usage.totalTokens,
            ...(turnUsage?.estimated || reply.usage.estimated ? { estimated: true } : {}),
          };
        } else missingUsage = true;
        return reply;
      },
    };
    try {
      this.options.signal?.throwIfAborted();
      await this.options.journal?.begin(randomUUID());
      this.append({ role: 'user', content: input });
      // Continue until the model returns a final reply without tool calls.
      for (let step = 1; ; step++) {
        this.options.signal?.throwIfAborted();
        this.options.onProgress?.({ type: 'step', step });
        const prepared = this.options.context
          ? await this.options.context.prepare(
              this.history,
              meteredModel,
              this.options.signal,
              this.tools.list(),
            )
          : undefined;
        if (prepared) {
          if (prepared.report.removedMessages) {
            this.options.onProgress?.({
              type: 'compact',
              removedMessages: prepared.report.removedMessages,
            });
          }
          this.options.onProgress?.({ type: 'context', ...prepared.report });
        } else this.compact();

        const { reply, thinkingMs } = await this.requestModel(
          meteredModel,
          prepared?.messages ?? this.history,
          this.tools.list(),
        );
        this.options.signal?.throwIfAborted();

        const calls = reply.toolCalls;
        const usage = calls.length
          ? reply.usage
          : turnUsage && missingUsage
            ? { ...turnUsage, partial: true }
            : turnUsage;
        const content = calls.length ? reply.content : (reply.content ?? '(模型未返回文本)');
        this.append({
          role: 'assistant',
          content,
          thinkingMs,
          ...(calls.length
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: 'function' as const,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }
            : {}),
          ...(usage ? { usage } : {}),
        });
        this.options.onEvent?.('model', { step, content, calls: calls.map((call) => call.name) });
        if (calls.length && content) {
          this.options.onProgress?.({ type: 'assistant_message', content, usage: reply.usage });
        }
        if (!calls.length) {
          await this.options.journal?.finish('completed');
          return content!;
        }
        for (const call of calls) await this.executeTool(call);
        this.options.signal?.throwIfAborted();
      }
    } catch (error) {
      // Repair protocol pairs even if persistence itself failed; preserve the original error.
      this.completePendingToolResults();
      await this.options.journal?.finish('interrupted').catch(() => {});
      throw error;
    } finally {
      this.metrics.lastRunMs = performance.now() - started;
      this.running = false;
    }
  }

  /** Stop at first answer text; tool-only/nonstreaming replies stop at completion. Tools are excluded. */
  private async requestModel(
    model: Model,
    messages: Message[],
    tools: Tool[],
  ): Promise<{ reply: ModelReply; thinkingMs: number }> {
    const started = performance.now();
    let thinkingMs: number | undefined;
    const finishThinking = (): number => {
      if (thinkingMs === undefined) {
        thinkingMs = performance.now() - started;
        this.options.onProgress?.({ type: 'thinking_end', ms: thinkingMs });
      }
      return thinkingMs;
    };
    this.options.onProgress?.({ type: 'model_start', startedAt: Date.now() });
    const reply = await model.complete(messages, tools, {
      signal: this.options.signal,
      onEvent: this.options.onProgress
        ? (event) => {
            if (event.type === 'text' && event.text) finishThinking();
            this.options.onProgress?.(event);
          }
        : undefined,
    });
    return { reply, thinkingMs: finishThinking() };
  }

  private async executeTool(call: ToolCall): Promise<void> {
    this.options.signal?.throwIfAborted();
    let args: unknown;
    try {
      args = JSON.parse(call.arguments);
    } catch {
      args = null;
    }
    this.options.onProgress?.({ type: 'tool_start', callId: call.id, name: call.name, args });
    await this.options.journal?.startTool(call.id, call.name);
    const start = performance.now();
    const result = await this.tools.invoke(
      call.name,
      args,
      this.options.approve ?? (async () => false),
      call.id,
      this.options.signal,
    );
    const ms = performance.now() - start;
    this.metrics.toolCalls++;
    this.metrics.toolMs += ms;
    const inline = this.options.maxInlineToolChars ?? 12000;
    let toolText = result;
    let artifactId: string | undefined;
    if (result.length > inline) {
      if (this.options.artifacts) {
        const saved = await this.options.artifacts.save(result);
        artifactId = saved.id;
        toolText = `[ARCHIVED id=${saved.id} totalChars=${saved.length}; use read_tool_output(id, offset, limit)]\n${result.slice(0, inline)}`;
      } else toolText = `${result.slice(0, inline)}\n[TRUNCATED: artifact store not configured]`;
    }
    this.append({ role: 'tool', tool_call_id: call.id, content: toolText });
    this.options.onEvent?.('tool', { name: call.name, args, result: result.slice(0, 300) });
    await this.options.journal?.finishTool(call.id, toolText);
    this.options.onProgress?.({
      type: 'tool_end',
      callId: call.id,
      name: call.name,
      result: result.slice(0, 300),
      ms,
      artifactId,
    });
  }

  private completePendingToolResults(): void {
    const lastUser = this.history.findLastIndex((message) => message.role === 'user');
    for (const message of this.history.slice(lastUser + 1)) {
      if (message.role !== 'assistant') continue;
      for (const call of message.tool_calls ?? []) {
        const completed = this.history
          .slice(lastUser + 1)
          .some((result) => result.role === 'tool' && result.tool_call_id === call.id);
        if (!completed)
          this.append({
            role: 'tool',
            tool_call_id: call.id,
            content: 'ERROR: Task interrupted before tool result was recorded',
          });
      }
    }
  }

  /** Remove whole old user turns only; never detach a tool result from its call. */
  private compact(): void {
    const budget = this.options.maxHistoryChars ?? 48_000;
    const size = () =>
      this.history.reduce((total, message) => total + JSON.stringify(message).length, 0);
    let removed = 0;
    while (size() > budget) {
      const firstUser = this.history.findIndex((message) => message.role === 'user');
      const secondUser = this.history.findIndex(
        (message, index) => index > firstUser && message.role === 'user',
      );
      if (firstUser < 0 || secondUser < 0) break;
      removed += secondUser - firstUser;
      this.history.splice(firstUser, secondUser - firstUser);
    }
    if (removed) this.options.onProgress?.({ type: 'compact', removedMessages: removed });
  }
}
