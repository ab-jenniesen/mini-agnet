import { wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { safeText, theme } from './theme.js';

/** Page by rendered lines, so long paths and Chinese text wrap at every window size. */
export class PagedText implements Component {
  private offset = 0;
  private count = 0;
  private pageSize = 1;
  onNext?: () => void;
  onPrevious?: () => void;

  constructor(
    private readonly text: string,
    private readonly getRows: () => number,
  ) {}
  invalidate(): void {}

  render(width: number): string[] {
    const lines = wrapTextWithAnsi(safeText(this.text), Math.max(1, width));
    this.count = lines.length;
    this.pageSize = Math.max(1, this.getRows());
    this.offset = Math.min(this.offset, Math.max(0, lines.length - 1));
    const page = lines.slice(this.offset, this.offset + this.pageSize);
    const range = `${Math.min(this.offset + 1, lines.length)}–${Math.min(this.offset + page.length, lines.length)}/${lines.length}`;
    return [
      ...page,
      theme.dim(width < 40 ? `${range} ↑↓ Esc` : `${range} · ↑↓ / PgUp PgDn 翻页 · Esc 关闭`),
    ];
  }

  move(direction: -1 | 1, page = true): void {
    const next = this.offset + direction * (page ? this.pageSize : 1);
    if (direction > 0 && next >= this.count) {
      this.onNext?.();
      return;
    }
    if (direction < 0 && this.offset === 0) {
      this.onPrevious?.();
      return;
    }
    this.offset = Math.max(0, Math.min(Math.max(0, this.count - 1), next));
  }
}
