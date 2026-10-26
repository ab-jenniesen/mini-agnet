import type { Message } from '../model/types.js';

/** Conservative heuristic, not a provider tokenizer. Multilingual text gets a tighter estimate. */
export function estimateTokens(value: string): number {
  const cjk = (value.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  return Math.ceil((value.length - cjk) / 3.5 + cjk * 1.5);
}
export function messageTokens(message: Message): number {
  return estimateTokens(JSON.stringify(message)) + 8;
}
export function truncateByTokens(value: string, limit: number): string {
  if (estimateTokens(value) <= limit) return value;
  const marker =
    '\n[CONTEXT_PREVIEW_TRUNCATED: fetch archived output with read_tool_output when an ARCHIVED id is present]';
  const target = Math.max(0, limit - estimateTokens(marker));
  let low = 0,
    high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(value.slice(0, middle)) <= target) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low) + marker;
}
