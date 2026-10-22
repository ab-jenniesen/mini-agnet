import { Markdown, wrapTextWithAnsi, type Component, type Terminal } from '@earendil-works/pi-tui';
import type { PresentationState } from '../view-model.js';
import type { TranscriptEntry } from '../transcript.js';
import {
  conversationTurns,
  visibleTurnEntries,
  type ToolDisplayMode,
  type TurnEntry,
} from '../turns.js';
import { launchArt } from './launch-art.js';
import { markdownTheme, safeText, theme } from './theme.js';
import { turnContentWidth, turnFrame } from './turn-frame.js';

export const DEFAULT_MAX_TOOL_ENTRIES = 5;
export type TranscriptOptions = { maxToolEntries?: number };

const durationText = (ms: number): string => `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;

export function usageText(entry: Extract<TranscriptEntry, { kind: 'assistant' }>): string {
  const usage = entry.usage;
  if (!usage) return 'Token · 服务商未返回用量';
  return `Token（${entry.usageScope === 'turn' ? '本轮' : '本次调用'}${usage.partial ? '，部分统计' : ''}${usage.estimated ? '，估算' : ''}）· 输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} · 合计 ${usage.totalTokens}`;
}

export class TranscriptView implements Component {
  private entries: TranscriptEntry[] = [];
  private readonly live: LiveView;
  private readonly maxToolEntries: number;
  private cachedEntries?: TranscriptEntry[];
  private cachedActiveCallId?: string;
  private toolDisplayMode: ToolDisplayMode = 'recent';
  private cachedWidth = 0;
  private cachedRows = 0;
  private cachedLines: string[] = [];
  private cachedThinkingLine?: number;
  latestThinkingLine?: number;
  private lastTurn?: { number: number; body: string[]; start: number };

  constructor(
    private readonly terminal: Terminal,
    options: TranscriptOptions = {},
  ) {
    this.live = new LiveView();
    this.maxToolEntries = options.maxToolEntries ?? DEFAULT_MAX_TOOL_ENTRIES;
    if (!Number.isSafeInteger(this.maxToolEntries) || this.maxToolEntries < 1)
      throw new Error('AGENT_TUI_MAX_TOOL_ENTRIES must be a positive integer');
  }

  update(state: PresentationState): void {
    this.entries = state.conversation;
    this.live.state = state;
  }
  setThinkingMode(mode: ThinkingMode): void {
    this.live.thinkingMode = mode;
    this.invalidate();
  }
  get hasThinking(): boolean {
    return !!this.live.state?.thinking || this.entries.some((entry) => entry.kind === 'thinking');
  }
  setToolDisplayMode(mode: ToolDisplayMode): void {
    this.toolDisplayMode = mode;
    this.live.toolDisplayMode = mode;
    this.invalidate();
  }
  get toolDisplayLabel(): string {
    return this.toolDisplayMode === 'collapsed'
      ? '全部收起'
      : this.toolDisplayMode === 'all'
        ? '全部展示'
        : `最近 ${this.maxToolEntries} 条`;
  }
  invalidate(): void {
    this.cachedWidth = 0;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const activeCallId =
      this.toolDisplayMode === 'collapsed' ? this.live.state?.activeTool?.callId : undefined;
    if (
      this.entries !== this.cachedEntries ||
      activeCallId !== this.cachedActiveCallId ||
      width !== this.cachedWidth ||
      this.terminal.rows !== this.cachedRows
    )
      this.rebuild(width, activeCallId);
    this.latestThinkingLine = this.cachedThinkingLine;
    if (!this.live.state?.snapshot?.running) return this.cachedLines;
    const liveLines = this.live.render(turnContentWidth(width));

    // Replace only the active frame while streaming; completed turns keep their cached rendering.
    const last = this.lastTurn;
    const body = last ? [...last.body, ...(liveLines.length ? ['', ...liveLines] : [])] : liveLines;
    const prefix = last ? this.cachedLines.slice(0, last.start) : this.cachedLines;
    const title = last?.number ? `第 ${last.number} 轮 · 进行中` : '正在开始';
    if (this.live.state.thinking && this.live.thinkingMode === 'expanded')
      this.latestThinkingLine = prefix.length + 1 + (last ? last.body.length + 1 : 0);
    return [...prefix, ...turnFrame(title, body, width, true), ''];
  }

  private rebuild(width: number, activeCallId?: string): void {
    const lines = [
      ...launchArt(width, this.terminal.rows).split('\n'),
      ...wrapTextWithAnsi(theme.bold('Mini Agent'), width),
      ...wrapTextWithAnsi(theme.dim('输入 / 查看命令 · 鼠标滚轮回看对话'), width),
      '',
    ];
    const bodyWidth = turnContentWidth(width);
    this.lastTurn = undefined;
    this.cachedThinkingLine = undefined;
    const turns = conversationTurns(this.entries);
    for (const turn of turns) {
      const body: string[] = [];
      const visible = visibleTurnEntries(
        turn.entries,
        this.maxToolEntries,
        this.toolDisplayMode,
        turn === turns.at(-1) ? activeCallId : undefined,
      );
      for (const entry of visible) {
        const rendered = this.renderEntry(entry, bodyWidth);
        if (!rendered.length) continue;
        if (body.length) body.push('');
        if (entry.kind === 'thinking') this.cachedThinkingLine = lines.length + 1 + body.length;
        body.push(...rendered);
      }
      this.lastTurn = { number: turn.number, body, start: lines.length };
      const title = turn.number ? `第 ${turn.number} 轮` : '会话信息';
      lines.push(...turnFrame(title, body, width), '');
    }
    this.cachedEntries = this.entries;
    this.cachedActiveCallId = activeCallId;
    this.cachedWidth = width;
    this.cachedRows = this.terminal.rows;
    this.cachedLines = lines;
  }

  private renderEntry(entry: TurnEntry, width: number): string[] {
    switch (entry.kind) {
      case 'user':
        return wrapTextWithAnsi(`${theme.user('❯ 你')}\n${safeText(entry.text)}`, width);
      case 'thinking': {
        if (this.live.thinkingMode === 'hidden') return [];
        const duration =
          entry.durationMs === undefined ? '' : ` · ${durationText(entry.durationMs)}`;
        if (this.live.thinkingMode === 'collapsed')
          return wrapTextWithAnsi(theme.dim(`思考过程${duration} · Ctrl+I 展开`), width);
        return [
          ...wrapTextWithAnsi(theme.dim(`思考过程${duration} · Ctrl+I 收起`), width),
          ...wrapTextWithAnsi(theme.dim(safeText(entry.text)), width),
        ];
      }
      case 'assistant':
        return [
          ...wrapTextWithAnsi(theme.accent('● 助手'), width),
          ...new Markdown(safeText(entry.text), 0, 0, markdownTheme).render(width),
          ...(entry.thinkingMs === undefined
            ? []
            : wrapTextWithAnsi(
                theme.dim(
                  `思考耗时（${entry.usageScope === 'turn' ? '本轮累计' : '本次调用'}）· ${durationText(entry.thinkingMs)}`,
                ),
                width,
              )),
          ...wrapTextWithAnsi(theme.dim(usageText(entry)), width),
        ];
      case 'tool': {
        const time =
          entry.durationMs === undefined ? '' : ` · ${(entry.durationMs / 1000).toFixed(2)}s`;
        const lines = [
          ...wrapTextWithAnsi(theme.accent(`↳ ${safeText(entry.name)}${time}`), width),
          ...wrapTextWithAnsi(theme.dim(safeText(entry.args)), width),
          ...wrapTextWithAnsi(theme.dim(safeText(entry.result)), width),
        ];
        if (entry.artifactId)
          lines.push(...wrapTextWithAnsi(theme.dim(`/output ${entry.artifactId}`), width));
        return lines;
      }
      case 'folded-tools':
        return wrapTextWithAnsi(
          theme.dim(
            entry.collapsed
              ? `工具共调用 ${entry.count} 次 · 已全部收起 · Ctrl+O 切换`
              : `已折叠 ${entry.count} 条较早工具记录 · 每轮仅显示最近 ${this.maxToolEntries} 条 · Ctrl+O 切换`,
          ),
          width,
        );
      case 'error':
        return wrapTextWithAnsi(theme.error(`错误：${safeText(entry.text)}`), width);
    }
  }
}

export type ThinkingMode = 'expanded' | 'collapsed' | 'hidden';
class LiveView implements Component {
  state?: PresentationState;
  thinkingMode: ThinkingMode = 'collapsed';
  toolDisplayMode: ToolDisplayMode = 'recent';
  invalidate(): void {}
  render(width: number): string[] {
    const state = this.state;
    if (!state?.snapshot?.running) return [];
    const lines: string[] = [];
    const activity = state.modelActivity;
    if (activity || (state.thinking && this.thinkingMode !== 'hidden')) {
      const elapsed =
        activity?.thinkingMs ?? Math.max(0, Date.now() - (activity?.startedAt ?? Date.now()));
      const timing = activity
        ? `${activity.thinkingMs === undefined ? '思考中' : '思考耗时'} · ${durationText(elapsed)}`
        : '思考';
      lines.push(
        ...wrapTextWithAnsi(
          theme.dim(
            `${timing} · 第 ${state.step} 步${state.thinking ? (this.thinkingMode === 'expanded' ? ' · Ctrl+I 收起' : ' · Ctrl+I 展开') : ''}`,
          ),
          width,
        ),
      );
      if (state.thinking && this.thinkingMode === 'expanded')
        lines.push(...wrapTextWithAnsi(theme.dim(safeText(state.thinking)), width));
    }
    if (state.answer)
      lines.push(
        ...wrapTextWithAnsi(theme.accent('● 助手'), width),
        ...new Markdown(safeText(state.answer), 0, 0, markdownTheme).render(width),
      );
    if (state.activeTool && this.toolDisplayMode !== 'collapsed')
      lines.push(
        ...wrapTextWithAnsi(
          theme.warning(
            `执行中：${safeText(state.activeTool.name)} ${safeText(state.activeTool.args)}`,
          ),
          width,
        ),
      );
    if (!lines.length && !state.activeTool)
      lines.push(...wrapTextWithAnsi(theme.dim(`正在请求模型 · 第 ${state.step || 1} 步`), width));
    return lines;
  }
}
