import {
  stripTerminalSequences,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
} from '@earendil-works/pi-tui';

const color = (code: number) => (text: string) =>
  process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;
export const theme = {
  accent: color(36),
  user: color(32),
  dim: color(90),
  warning: color(33),
  error: color(31),
  bold: color(1),
};

/** Model/tool output is text, never an instruction to the terminal emulator. */
export function safeText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
}

export const selectTheme: SelectListTheme = {
  selectedPrefix: theme.accent,
  selectedText: theme.accent,
  description: theme.dim,
  scrollInfo: theme.dim,
  noMatch: theme.dim,
};
export const editorTheme: EditorTheme = { borderColor: theme.accent, selectList: selectTheme };
export const markdownTheme: MarkdownTheme = {
  heading: (text) => theme.bold(theme.accent(text)),
  link: theme.accent,
  linkUrl: theme.dim,
  code: theme.warning,
  codeBlock: (text) => text,
  codeBlockBorder: theme.dim,
  quote: theme.dim,
  quoteBorder: theme.dim,
  hr: theme.dim,
  listBullet: theme.accent,
  bold: theme.bold,
  italic: color(3),
  strikethrough: color(9),
  underline: color(4),
};
