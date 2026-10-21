import xterm from '@xterm/headless';
import type { ProgramStatus, Terminal } from '@earendil-works/pi-tui';

/** A real ANSI parser behind the same Terminal port used by ProcessTerminal. */
export class FakeTerminal implements Terminal {
  readonly emulator = new xterm.Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  output = '';
  stopped = false;
  private onInput?: (data: string) => void;
  private onResize?: () => void;
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput;
    this.onResize = onResize;
  }
  stop(): void {
    this.stopped = true;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
    this.emulator.write(data);
  }
  input(data: string): void {
    this.onInput?.(data);
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emulator.resize(columns, rows);
    this.onResize?.();
  }
  moveBy(lines: number): void {
    this.write(lines >= 0 ? `\x1b[${lines}B` : `\x1b[${-lines}A`);
  }
  hideCursor(): void {
    this.write('\x1b[?25l');
  }
  showCursor(): void {
    this.write('\x1b[?25h');
  }
  clearLine(): void {
    this.write('\x1b[2K');
  }
  clearFromCursor(): void {
    this.write('\x1b[J');
  }
  clearScreen(): void {
    this.write('\x1b[2J\x1b[H');
  }
  setTitle(_title: string): void {}
  setProgress(_active: boolean): void {}
  setProgramStatus(_status: ProgramStatus): void {}
  flush(): Promise<void> {
    return new Promise((resolve) => this.emulator.write('', resolve));
  }
  screen(): string {
    const buffer = this.emulator.buffer.active;
    return Array.from(
      { length: this.rows },
      (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '',
    ).join('\n');
  }
  dispose(): void {
    this.emulator.dispose();
  }
}
