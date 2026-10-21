import { randomUUID } from 'node:crypto';
import { ExecutionJournal } from '../infra/execution-journal.js';
import type { Message, Model, Usage } from './types.js';
import { ToolRegistry } from './registry.js';
import { ContextManager } from './context/manager.js';
import { ToolArtifacts } from '../infra/tool-artifacts.js';

export type AgentEvent =
  | { type: 'step'; step: number }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; source: 'provider' | 'summary' }
  | { type: 'tool_start'; name: string; args: unknown }
  | { type: 'tool_end'; name: string; result: string; ms: number; artifactId?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'compact'; removedMessages: number }
  | { type: 'context'; estimatedTokens: number; budget: number; recalledMemories: number; truncatedToolResults: number; summaryCreated: boolean };
export type AgentOptions = { maxSteps?: number; maxHistoryChars?: number; approve?: (name: string, args: unknown) => Promise<boolean>; onEvent?: (event: string, detail: unknown) => void; onProgress?: (event: AgentEvent) => void; signal?: AbortSignal; context?: ContextManager; artifacts?: ToolArtifacts; journal?: ExecutionJournal; maxInlineToolChars?: number };
export class Agent {
  readonly history: Message[];
  readonly metrics = { modelCalls: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, modelMs: 0, toolMs: 0, lastRunMs: 0 };
  constructor(private model: Model, private readonly tools: ToolRegistry, systemPrompt: string, private readonly options: AgentOptions = {}, initial?: Message[]) {
    this.history = initial?.length && initial[0]?.role === 'system' ? [...initial] : [{ role: 'system', content: systemPrompt }, ...(initial ?? []).filter(m => m.role !== 'system')];
  }
  setModel(model: Model): void { this.model = model; }
  async run(input: string): Promise<string> {
    const started = performance.now();
    this.history.push({ role: 'user', content: input });
    await this.options.journal?.begin(randomUUID());
    try {
      for (let step = 0; step < (this.options.maxSteps ?? 15); step++) {
        if (this.options.signal?.aborted) throw new Error('Task cancelled');
        this.options.onProgress?.({ type: 'step', step: step + 1 });
        const prepared = this.options.context ? await this.options.context.prepare(this.history,this.model,this.options.signal,this.tools.list()) : undefined;
        if (prepared) {
          if (prepared.report.removedMessages) this.options.onProgress?.({type:'compact', removedMessages:prepared.report.removedMessages});
          this.options.onProgress?.({type:'context', ...prepared.report});
        } else this.compact();
        const modelStart = performance.now();
        const reply = await this.model.complete(prepared?.messages ?? this.history, this.tools.list(), {
          signal: this.options.signal,
          onEvent: this.options.onProgress ? e => this.options.onProgress?.(e.type === 'text' ? { type: 'text', text: e.text } : e.type === 'thinking' ? { type: 'thinking', text: e.text, source: e.source } : { type: 'usage', usage: e.usage }) : undefined
        });
        this.metrics.modelCalls++; this.metrics.modelMs += performance.now() - modelStart;
        if (reply.usage) { this.metrics.promptTokens += reply.usage.promptTokens; this.metrics.completionTokens += reply.usage.completionTokens; this.metrics.totalTokens += reply.usage.totalTokens; }
        const calls = reply.toolCalls;
        this.history.push({ role: 'assistant', content: reply.content, ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: c.arguments } })) } : {}) });
        this.options.onEvent?.('model', { step: step + 1, content: reply.content, calls: calls.map(c => c.name) });
        if (!calls.length) { await this.options.journal?.finish('completed'); return reply.content ?? '(The model ended without text)'; }
        for (const call of calls) {
          if (this.options.signal?.aborted) throw new Error('Task cancelled');
          let args: unknown;
          try { args = JSON.parse(call.arguments); } catch { args = null; }
          this.options.onProgress?.({ type: 'tool_start', name: call.name, args });
          await this.options.journal?.startTool(call.id,call.name);
          const start = performance.now();
          const result = await this.tools.invoke(call.name, args, this.options.approve ?? (async () => false),call.id);
          const ms = performance.now() - start;
          this.metrics.toolCalls++; this.metrics.toolMs += ms;
          const inline = this.options.maxInlineToolChars ?? 12000;
          let toolText = result;
          let artifactId: string | undefined;
          if (this.options.artifacts) {
            if (result.length > inline) { const saved = await this.options.artifacts.save(result); artifactId = saved.id; toolText = `[ARCHIVED id=${saved.id} totalChars=${saved.length}; use read_tool_output(id, offset, limit)]\n${result.slice(0,inline)}`; }
          } else if (result.length > inline) {
            toolText = `${result.slice(0,inline)}\n[TRUNCATED: artifact store not configured]`;
          }
          this.history.push({ role: 'tool', tool_call_id: call.id, content: toolText });
          this.options.onEvent?.('tool', { name: call.name, args, result: result.slice(0, 300) });
          await this.options.journal?.finishTool(call.id,toolText);
          this.options.onProgress?.({ type: 'tool_end', name: call.name, result: result.slice(0, 300), ms, artifactId });
        }
      }
      await this.options.journal?.finish('interrupted');
      return `Stopped: reached maximum ${this.options.maxSteps ?? 15} model turns. The task may be unfinished.`;
    } catch (error) {
      await this.options.journal?.finish('interrupted');
      // An interrupted multi-tool turn must not leave unmatched tool_call_id entries in persisted history.
      const last = this.history.at(-1);
      if (last?.role === 'assistant' && last.tool_calls?.length) {
        for (const call of last.tool_calls) this.history.push({ role: 'tool', tool_call_id: call.id, content: 'ERROR: Task cancelled before tool execution' });
      } else {
        const start = this.history.map(m => m.role === 'assistant' && !!m.tool_calls?.length).lastIndexOf(true);
        if (start >= 0) {
          const assistant = this.history[start];
          if (assistant?.role === 'assistant' && assistant.tool_calls) {
            const seen = new Set(this.history.slice(start+1).filter(m => m.role === 'tool').map(m => m.role === 'tool' ? m.tool_call_id : ''));
            for (const call of assistant.tool_calls) if (!seen.has(call.id)) this.history.push({role:'tool', tool_call_id:call.id, content:'ERROR: Task cancelled before tool execution'});
          }
        }
      }
      throw error;
    } finally { this.metrics.lastRunMs = performance.now() - started; }
  }
  /** Keep complete tool-call/result groups. Compaction is character-budget based, not semantic summarization. */
  private compact(): void {
    const budget = this.options.maxHistoryChars ?? 48_000;
    const size = () => this.history.reduce((n, m) => n + JSON.stringify(m).length, 0);
    let removed = 0;
    while (size() > budget) {
      const latestUser = this.history.map(m => m.role === 'user').lastIndexOf(true);
      const firstUser = this.history.findIndex(m => m.role === 'user');
      if (firstUser < 0 || firstUser === latestUser) break;
      const secondUser = this.history.findIndex((m,i) => i > firstUser && m.role === 'user');
      if (secondUser < 0) break;
      removed += secondUser - firstUser;
      this.history.splice(firstUser, secondUser - firstUser);
    }
    if (removed) this.options.onProgress?.({ type: 'compact', removedMessages: removed });
  }
}
