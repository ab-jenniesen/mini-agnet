import {
  Input,
  SelectList,
  matchesKey,
  wrapTextWithAnsi,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type Terminal,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui';
import { PagedText } from './paged-text.js';
import { safeText, selectTheme, theme } from './theme.js';

class ResponsiveChoices implements Component {
  private list: SelectList;
  private rows = 0;
  onSelect?: (item: SelectItem) => void;
  constructor(private readonly items: SelectItem[]) {
    this.list = new SelectList(items, 1, selectTheme);
    this.list.onSelect = (item) => this.onSelect?.(item);
  }
  setRows(rows: number): void {
    if (rows === this.rows) return;
    const selected = this.list.getSelectedItem()?.value;
    this.rows = rows;
    this.list = new SelectList(this.items, rows, selectTheme);
    this.list.setSelectedIndex(
      Math.max(
        0,
        this.items.findIndex((item) => item.value === selected),
      ),
    );
    this.list.onSelect = (item) => this.onSelect?.(item);
  }
  invalidate(): void {
    this.list.invalidate();
  }
  render(width: number): string[] {
    return this.list.render(width);
  }
  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}

/** Focus stays with the dialog; an optional input still emits the IME cursor marker. */
export class Dialog implements Component, Focusable {
  focused = false;
  input?: Input;
  list?: ResponsiveChoices;
  page?: PagedText;
  onKey?: (data: string) => boolean;
  onCancel: () => void = () => {};

  constructor(
    readonly title: string,
    private readonly terminal: Terminal,
    readonly hint = '',
  ) {}
  invalidate(): void {}

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 2);
    if (this.input) this.input.focused = this.focused;
    const title = wrapTextWithAnsi(theme.bold(safeText(this.title)), contentWidth).slice(0, 2);
    const shortHint = contentWidth < 40 && this.list ? '↑↓ Enter 确认 · Esc 返回' : this.hint;
    const hint = wrapTextWithAnsi(theme.dim(shortHint), contentWidth).slice(0, 2);
    this.list?.setRows(
      Math.max(1, Math.min(6, this.terminal.rows - title.length - hint.length - 6)),
    );
    const body = this.page?.render(contentWidth) ?? this.list?.render(contentWidth) ?? [];
    const input = this.input?.render(contentWidth) ?? [];
    return [theme.accent('─'.repeat(Math.max(1, width))), ...title, ...body, ...input, ...hint].map(
      (line) => truncateToWidth(line, Math.max(1, width)),
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.onCancel();
      return;
    }
    if (this.onKey?.(data)) return;
    if (this.page) {
      if (matchesKey(data, 'pageUp') || matchesKey(data, 'up'))
        this.page.move(-1, !matchesKey(data, 'up'));
      if (matchesKey(data, 'pageDown') || matchesKey(data, 'down'))
        this.page.move(1, !matchesKey(data, 'down'));
    }
    this.input?.handleInput(data);
    this.list?.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'wheel' && this.page) {
      this.page.move((event.wheelDelta ?? 0) < 0 ? -1 : 1, false);
      return { handled: true };
    }
    return undefined;
  }
}

/** Mask printable cells while preserving ANSI cursor markers; secret bytes never render. */
export class SecretInput extends Input {
  override render(width: number): string[] {
    return super
      .render(width)
      .map((line) =>
        line.replace(
          /(\x1b(?:\[[0-?]*[ -/]*[@-~]|_[^\x07]*\x07))|([^\x1b])/gu,
          (_match, sequence: string | undefined, char: string) =>
            sequence ?? (char === ' ' ? ' ' : '•'),
        ),
      );
  }
}

export function choiceDialog(
  title: string,
  terminal: Terminal,
  items: SelectItem[],
  hint: string,
): Dialog {
  const dialog = new Dialog(title, terminal, hint);
  dialog.list = new ResponsiveChoices(items);
  return dialog;
}
