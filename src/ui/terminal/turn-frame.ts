import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { theme } from './theme.js';

const padding = (width: number): number => (width >= 12 ? 1 : 0);

export function turnContentWidth(width: number): number {
  return Math.max(1, width - 2 - padding(width) * 2);
}

/** Measure terminal cells rather than string length so Chinese and emoji keep the border aligned. */
export function turnFrame(title: string, lines: string[], width: number, active = false): string[] {
  if (width <= 0) return [];
  if (width < 3) return [title, ...lines].map((line) => truncateToWidth(line, width, ''));
  const border = active ? theme.accent : theme.dim;
  const label = truncateToWidth(` ${title} `, width - 2, '');
  const gap = ' '.repeat(padding(width));
  const bodyWidth = turnContentWidth(width);
  return [
    border(`╭${label}${'─'.repeat(width - 2 - visibleWidth(label))}╮`),
    ...lines.map(
      (line) =>
        `${border('│')}${gap}${truncateToWidth(line, bodyWidth, '', true)}${gap}${border('│')}`,
    ),
    border(`╰${'─'.repeat(width - 2)}╯`),
  ];
}
