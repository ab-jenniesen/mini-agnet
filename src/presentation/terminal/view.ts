import {
  Editor,
  Input,
  ScrollView,
  VStack,
  TuiAltScreen,
  TuiMainScreen,
  matchesKey,
  truncateToWidth,
  CURSOR_MARKER,
  type Component,
  type Terminal,
  type TUI,
  type OverlayHandle,
  type SelectItem,
} from '@earendil-works/pi-tui';
import type { PresentationState } from '../view-model.js';
import type { ToolDisplayMode } from '../turns.js';
import { editorTheme, safeText, theme } from './theme.js';
import { Dialog, SecretInput, choiceDialog } from './dialogs.js';
import { PagedText } from './paged-text.js';
import { TranscriptView, type ThinkingMode, type TranscriptOptions } from './transcript-view.js';

class DynamicView implements Component {
  constructor(private readonly draw: (width: number) => string[]) {}
  invalidate(): void {}
  render(width: number): string[] {
    return this.draw(width);
  }
}

/** Keep the cursor visible even in a very short terminal or with a large completion menu. */
export class PromptEditor extends Editor {
  override render(width: number): string[] {
    const lines = super.render(width);
    const budget = Math.max(1, this.tui.terminal.rows - 5);
    if (lines.length <= budget) return lines;
    const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    const start = Math.max(0, Math.min(lines.length - budget, cursor - Math.floor(budget / 2)));
    return lines.slice(start, start + budget);
  }
}

export class TerminalView {
  readonly tui: TUI;
  readonly editor: PromptEditor;
  readonly transcript: TranscriptView;
  private readonly scroll?: ScrollView;
  private state?: PresentationState;
  private overlay?: OverlayHandle;
  private cancelDialog?: () => void;
  private panelOpen = false;
  private stopped = false;
  private started = false;
  private thinkingTimer?: ReturnType<typeof setInterval>;
  private footerNotice?: { tone: 'info' | 'warning' | 'error'; text: string };
  onSubmit?: (text: string) => void;
  onCancel?: () => void;
  onExit?: () => void;
  thinkingMode: ThinkingMode = 'collapsed';
  toolDisplayMode: ToolDisplayMode = 'recent';

  constructor(
    readonly terminal: Terminal,
    fullscreen = true,
    transcriptOptions: TranscriptOptions = {},
  ) {
    this.tui = fullscreen
      ? new TuiAltScreen(terminal, true, undefined, {
          wheelScrollLines: 'auto',
          scrollToEndIndicator: () => theme.accent('↓ 回到最新消息'),
        })
      : new TuiMainScreen(terminal, true);
    this.tui.setClearOnShrink(true);
    this.editor = new PromptEditor(this.tui, editorTheme, {
      paddingX: 1,
      autocompleteMaxVisible: 4,
    });
    this.editor.disableSubmit = true;
    this.editor.onSubmit = (text) => this.onSubmit?.(text);
    this.transcript = new TranscriptView(terminal, transcriptOptions);
    const header = new DynamicView((width) => [truncateToWidth(theme.dim(this.header()), width)]);
    const notice = new DynamicView((width) => {
      const value = this.footerNotice ?? this.state?.notice;
      const text = value?.text ?? '输入 / 查看命令';
      const color =
        value?.tone === 'error'
          ? theme.error
          : value?.tone === 'warning'
            ? theme.warning
            : theme.dim;
      return [truncateToWidth(color(safeText(text)), width)];
    });
    const hints = new DynamicView((width) => [
      truncateToWidth(
        theme.dim(
          this.state?.snapshot?.running
            ? `Ctrl+C 取消 · Ctrl+I 思考${this.thinkingMode === 'expanded' ? '已展开' : '已收起'} · Ctrl+O ${this.transcript.toolDisplayLabel}`
            : `Enter 发送 · Tab 补全 · Ctrl+I 思考${this.thinkingMode === 'expanded' ? '已展开' : '已收起'} · Ctrl+O ${this.transcript.toolDisplayLabel}`,
        ),
        width,
      ),
    ]);
    const footer = new VStack([notice, this.editor, hints]);
    if (this.tui instanceof TuiAltScreen) {
      this.scroll = new ScrollView(this.transcript, {
        follow: 'end',
        primary: true,
        scrollbar: 'auto',
      });
      this.tui.setLayoutRoot(
        new VStack([
          { component: header, basis: 1, shrink: 0 },
          { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
          { component: footer, basis: 'auto', shrink: 1, minSize: 1 },
        ]),
      );
    } else {
      this.tui.addChild(header);
      this.tui.addChild(this.transcript);
      this.tui.addChild(footer);
    }
    this.tui.setFocus(this.editor);
    this.tui.addInputListener((data) => {
      if (matchesKey(data, 'ctrl+c') && this.state?.snapshot?.running) {
        this.onCancel?.();
        return { consume: true };
      }
      if (this.tui.hasOverlay()) return;
      if (matchesKey(data, 'ctrl+c')) {
        if (this.state?.snapshot?.running) this.onCancel?.();
        else if (this.editor.getText()) {
          this.editor.setText('');
          this.tui.requestRender();
        } else this.onExit?.();
        return { consume: true };
      }
      // Legacy terminals encode Ctrl+I and Tab as the same byte. Preserve draft completion.
      const thinkingShortcut =
        data === '\t'
          ? this.state?.snapshot?.running || this.editor.getText().length === 0
          : matchesKey(data, 'ctrl+i');
      if (thinkingShortcut || matchesKey(data, 'ctrl+t')) {
        this.cycleThinking();
        return { consume: true };
      }
      if (matchesKey(data, 'ctrl+o')) {
        this.cycleTools();
        return { consume: true };
      }
      if (this.state?.snapshot?.running) return { consume: true };
    });
  }

  private header(): string {
    const s = this.state?.snapshot;
    return s
      ? ` ${s.selection.provider}/${s.selection.model} · 会话 ${s.id} · ${s.permissionMode} · ${s.workspaceRoot}${s.extraWritable ? ` (+${s.extraWritable})` : ''}`
      : ' Mini Agent · 初始化中…';
  }

  update(state: PresentationState): void {
    const switched = this.state?.snapshot?.id !== state.snapshot?.id;
    this.state = state;
    this.editor.disableSubmit = !state.snapshot || state.snapshot.running;
    this.transcript.update(state);
    this.syncThinkingTimer();
    if (switched) {
      this.scroll?.scrollToEnd();
      if (this.tui instanceof TuiAltScreen) this.tui.resetTextSelection();
    }
    this.tui.requestRender();
  }

  status(tone: 'info' | 'warning' | 'error', text: string): void {
    this.footerNotice = { tone, text };
    this.tui.requestRender();
  }
  clearStatus(): void {
    this.footerNotice = undefined;
  }
  cycleThinking(mode?: 'on' | 'collapse' | 'off'): void {
    this.thinkingMode =
      mode === 'on'
        ? 'expanded'
        : mode === 'collapse'
          ? 'collapsed'
          : mode === 'off'
            ? 'hidden'
            : this.thinkingMode === 'expanded'
              ? 'collapsed'
              : 'expanded';
    this.transcript.setThinkingMode(this.thinkingMode);
    if (this.thinkingMode === 'expanded' && !this.transcript.hasThinking)
      this.status(
        'info',
        this.state?.snapshot?.running
          ? '尚未收到可展示的思考内容，收到后会自动显示'
          : '暂无思考记录：模型未返回思考内容，或这段会话是在此前启动中生成的',
      );
    else this.clearStatus();
    if (this.started && this.scroll) {
      // Lay out the expanded text before scrolling, so a long answer cannot hide the thinking above it.
      this.tui.renderNow();
      const line = this.transcript.latestThinkingLine;
      if (this.thinkingMode === 'expanded' && line !== undefined)
        this.scroll.scrollTo(line, { disableFollow: true });
      else if (this.thinkingMode !== 'expanded') this.scroll.scrollToEnd();
    }
    this.tui.requestRender();
  }

  cycleTools(): void {
    this.toolDisplayMode =
      this.toolDisplayMode === 'collapsed'
        ? 'recent'
        : this.toolDisplayMode === 'recent'
          ? 'all'
          : 'collapsed';
    this.transcript.setToolDisplayMode(this.toolDisplayMode);
    this.tui.requestRender();
  }

  /** Refresh elapsed time during a silent provider wait; stop the timer as soon as thinking ends. */
  private syncThinkingTimer(): void {
    const activity = this.state?.modelActivity;
    const thinking =
      this.started &&
      this.state?.snapshot?.running &&
      activity &&
      activity.thinkingMs === undefined;
    if (thinking && !this.thinkingTimer) {
      this.thinkingTimer = setInterval(() => this.tui.requestRender(), 250);
      this.thinkingTimer.unref();
    } else if (!thinking && this.thinkingTimer) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
  }

  private show(dialog: Dialog, cancel: () => void): void {
    this.closeDialog();
    this.cancelDialog = cancel;
    dialog.onCancel = () => this.closeDialog();
    this.overlay = this.tui.showOverlay(dialog, {
      anchor: 'bottom-left',
      width: '100%',
      maxHeight: '90%',
      offsetY: -Math.min(5, this.terminal.rows - 1),
    });
    this.tui.requestRender();
  }

  closeDialog(): void {
    const cancel = this.cancelDialog;
    this.cancelDialog = undefined;
    this.overlay?.hide();
    this.overlay = undefined;
    this.panelOpen = false;
    cancel?.();
    this.tui.requestRender();
  }

  panel(title: string, text: string, paging?: { next?: () => void; previous?: () => void }): void {
    const dialog = new Dialog(title, this.terminal);
    dialog.page = new PagedText(text, () => Math.max(1, Math.floor(this.terminal.rows * 0.45) - 2));
    dialog.page.onNext = paging?.next;
    dialog.page.onPrevious = paging?.previous;
    dialog.onKey = (data) => {
      // Starting a new input replaces the temporary panel immediately.
      if (!data || data.charCodeAt(0) < 32 || data.charCodeAt(0) === 127) return false;
      this.closeDialog();
      this.editor.handleInput(data);
      return true;
    };
    this.show(dialog, () => {});
    this.panelOpen = true;
  }
  toggleHelp(text: string): void {
    if (this.panelOpen) this.closeDialog();
    else this.panel('命令帮助', text);
  }

  confirm(title: string, text: string): Promise<boolean> {
    return new Promise((resolve) => {
      const dialog = new Dialog(title, this.terminal, 'Y 同意 · N / Esc 拒绝');
      dialog.page = new PagedText(text, () =>
        Math.max(1, Math.floor(this.terminal.rows * 0.5) - 4),
      );
      dialog.onKey = (data) => {
        if (data.toLowerCase() === 'y') {
          resolve(true);
          this.closeDialog();
          return true;
        }
        if (data.toLowerCase() === 'n') {
          this.closeDialog();
          return true;
        }
        return false;
      };
      this.show(dialog, () => resolve(false));
    });
  }

  select(
    title: string,
    items: SelectItem[],
    hint = '↑↓ 选择 · Enter 确认 · Esc 返回',
    shortcuts: Record<string, string> = {},
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      const dialog = choiceDialog(title, this.terminal, items, hint);
      dialog.list!.onSelect = (item) => {
        resolve(item.value);
        this.closeDialog();
      };
      dialog.onKey = (data) => {
        const value = shortcuts[data.toLowerCase()];
        if (!value) return false;
        resolve(value);
        this.closeDialog();
        return true;
      };
      this.show(dialog, () => resolve(undefined));
    });
  }

  prompt(title: string, secret = false): Promise<string | undefined> {
    return new Promise((resolve) => {
      const dialog = new Dialog(title, this.terminal, 'Enter 确认 · Esc 返回');
      dialog.input = secret ? new SecretInput() : new Input();
      dialog.input.onSubmit = (value) => {
        resolve(value);
        dialog.input!.setValue('');
        this.closeDialog();
      };
      this.show(dialog, () => {
        dialog.input!.setValue('');
        resolve(undefined);
      });
    });
  }

  start(): void {
    this.stopped = false;
    this.tui.start();
    this.started = true;
    this.syncThinkingTimer();
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.syncThinkingTimer();
    this.closeDialog();
    this.tui.stop({ preserveScreen: this.tui.mode === 'fullscreen' });
  }
}
