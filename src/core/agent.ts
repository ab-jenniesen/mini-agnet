import { randomUUID } from 'node:crypto';
import type {
  AgentMetrics,
  Message,
  Model,
  ModelReply,
  Tool,
  ToolCall,
  Usage,
} from './model/types.js';
import type { AgentEvent } from './events.js';
import type { ArtifactPort, ContextPort, JournalPort } from './ports.js';
import type { ToolRegistryPort, RegisteredTool } from './tools/ports.js';
import { finishReason, ModelCompletionError, type ModelFinishReason } from './model/completion.js';

export type AgentRunResult = {
  content: string;
  finishReason: ModelFinishReason;
  rawFinishReason?: string;
};

export type AgentInvocation = {
  instructions?: string | (() => string);
  toolRefs?: string[];
  appendInput?: boolean;
  additionalTools?: RegisteredTool[];
};

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
    private readonly tools: ToolRegistryPort,
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
  getModel(): Model {
    return this.model;
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
    return (await this.runDetailed(input)).content;
  }

  async runDetailed(
    input: string,
    runId: string = randomUUID(),
    invocation: AgentInvocation = {},
  ): Promise<AgentRunResult> {
    if (this.running) throw new Error('Agent is already running');
    if (!input.trim()) throw new Error('Input must not be empty');
    const tools = this.tools.scoped(invocation.toolRefs);
    for (const tool of invocation.additionalTools ?? []) tools.register(tool);
    this.running = true;
    const started = performance.now();
    let turnUsage: Usage | undefined;
    let missingUsage = false;
    // Context summarization makes model calls too; account for them in the same turn.
    const meteredModel: Model = {
      complete: async (messages, tools, options) => {
        const start = performance.now();
        const id = randomUUID();
        this.metrics.modelCalls++;
        this.options.onProgress?.({ type: 'model_call', id, status: 'started' });
        try {
          const reply = await this.model.complete(messages, tools, options);
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
          this.options.onProgress?.({
            type: 'model_call',
            id,
            status: 'completed',
            ms: performance.now() - start,
            usage: reply.usage,
          });
          return reply;
        } catch (error) {
          this.options.onProgress?.({
            type: 'model_call',
            id,
            status: 'failed',
            ms: performance.now() - start,
          });
          throw error;
        } finally {
          this.metrics.modelMs += performance.now() - start;
        }
      },
    };
    try {
      this.options.signal?.throwIfAborted();
      await this.options.journal?.begin(runId);
      if (invocation.appendInput !== false) this.append({ role: 'user', content: input });
      // Continue until the model returns a final reply without tool calls.
      for (let step = 1; ; step++) {
        this.options.signal?.throwIfAborted();
        this.options.onProgress?.({ type: 'step', step });
        const instructions =
          typeof invocation.instructions === 'function'
            ? invocation.instructions()
            : invocation.instructions;
        const requestHistory: Message[] = instructions
          ? [
              { role: 'system', content: `${this.history[0]?.content ?? ''}\n\n${instructions}` },
              ...this.history.slice(1),
            ]
          : this.history;
        const prepared = this.options.context
          ? await this.options.context.prepare(
              requestHistory,
              meteredModel,
              this.options.signal,
              tools.list(),
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
          prepared?.messages ?? requestHistory,
          tools.list(),
        );
        this.options.signal?.throwIfAborted();

        const calls = reply.toolCalls;
        const reason = reply.finishReason ?? finishReason(reply.rawFinishReason, calls.length);
        const incomplete = ['length', 'blocked', 'pause', 'error'].includes(reason);
        const usage =
          calls.length && !incomplete
            ? reply.usage
            : turnUsage && missingUsage
              ? { ...turnUsage, partial: true }
              : turnUsage;
        const content = reply.content;
        // Preserve partial text for inspection, but never execute a truncated or blocked tool call.
        if (content?.trim() || (calls.length && !incomplete))
          this.append({
            role: 'assistant',
            content,
            thinkingMs,
            finishReason: reason,
            ...(reply.rawFinishReason ? { rawFinishReason: reply.rawFinishReason } : {}),
            ...(calls.length && !incomplete
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
        this.assertReply(reason, reply);
        this.options.onEvent?.('model', { step, content, calls: calls.map((call) => call.name) });
        if (calls.length && content) {
          this.options.onProgress?.({ type: 'assistant_message', content, usage: reply.usage });
        }
        if (!calls.length) {
          await this.options.journal?.finish('completed');
          return {
            content: content!,
            finishReason: reason,
            rawFinishReason: reply.rawFinishReason,
          };
        }
        for (const call of calls) await this.executeTool(call, tools);
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

  private assertReply(reason: ModelFinishReason, reply: ModelReply): void {
    const failure = (code: ModelCompletionError['code'], message: string): never => {
      throw new ModelCompletionError(code, message, reason, reply.rawFinishReason);
    };
    switch (reason) {
      case 'length':
        failure('output_truncated', '模型输出达到长度上限，回复被截断，任务尚未完成');
        break;
      case 'blocked':
        failure('model_blocked', '模型拒绝或过滤了本次回复，任务受阻');
        break;
      case 'pause':
        failure('model_paused', '服务商暂停了生成，需要继续处理，任务尚未完成');
        break;
      case 'error':
        failure('invalid_response', '服务商返回了异常结束状态');
        break;
      case 'tool_calls':
        if (!reply.toolCalls.length)
          failure('invalid_response', '模型声明工具调用但没有返回调用参数');
        break;
    }
    if (!reply.toolCalls.length && !reply.content?.trim())
      failure('empty_response', '模型未返回正文或工具调用，任务尚未完成');
  }

  /** Stop at first answer text; tool-only/nonstreaming replies stop at completion. Tools are excluded. */
  private async requestModel(
    model: Model,
    messages: Message[],
    tools: Tool[],
  ): Promise<{ reply: ModelReply; thinkingMs: number }> {
    const started = performance.now();
    let thinkingMs: number | undefined;
    let partial = '';
    const finishThinking = (): number => {
      if (thinkingMs === undefined) {
        thinkingMs = performance.now() - started;
        this.options.onProgress?.({ type: 'thinking_end', ms: thinkingMs });
      }
      return thinkingMs;
    };
    this.options.onProgress?.({ type: 'model_start', startedAt: Date.now() });
    try {
      const reply = await model.complete(messages, tools, {
        signal: this.options.signal,
        onEvent: (event) => {
          if (event.type === 'text' && event.text) {
            partial += event.text;
            finishThinking();
          }
          this.options.onProgress?.(event);
        },
      });
      return { reply, thinkingMs: finishThinking() };
    } catch (error) {
      if (partial.trim())
        this.append({
          role: 'assistant',
          content: partial,
          finishReason: 'error',
          thinkingMs: thinkingMs ?? performance.now() - started,
        });
      throw error;
    }
  }

  private async executeTool(call: ToolCall, tools: ToolRegistryPort): Promise<void> {
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
    const execution = await tools.invokeDetailed(
      call.name,
      args,
      this.options.approve ?? (async () => false),
      call.id,
      this.options.signal,
    );
    const result = execution.output;
    const ms = performance.now() - start;
    this.metrics.toolCalls++;
    this.metrics.toolMs += ms;
    const inline = this.options.maxInlineToolChars ?? 12000;
    let toolText = result;
    let artifactId: string | undefined;
    try {
      if (result.length > inline) {
        if (this.options.artifacts) {
          const saved = await this.options.artifacts.save(result);
          artifactId = saved.id;
          toolText = `[ARCHIVED id=${saved.id} totalChars=${saved.length}; use read_tool_output(id, offset, limit)]\n${result.slice(0, inline)}`;
        } else toolText = `${result.slice(0, inline)}\n[TRUNCATED: artifact store not configured]`;
      }
      this.append({ role: 'tool', tool_call_id: call.id, content: toolText });
      this.options.onEvent?.('tool', { name: call.name, args, result: result.slice(0, 300) });
    } finally {
      // Execution already happened: archival or journal failures must not hide its effects.
      this.options.onProgress?.({
        type: 'tool_end',
        callId: call.id,
        name: call.name,
        result: result.slice(0, 300),
        ms,
        artifactId,
        evidence: execution.evidence,
        outcome: execution.status,
      });
    }
    await this.options.journal?.finishTool(call.id, toolText);
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
