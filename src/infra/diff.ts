/** Dependency-free line-oriented diff preview. For very large files show bounded before/after previews. */
export function diffPreview(oldText: string, newText: string, maxLines = 120): string {
  if (oldText === newText) return '(no changes)';
  const a = oldText.split('\n'),
    b = newText.split('\n');
  if (a.length * b.length > 150_000)
    return `Large file; showing bounded before/after (not a unified diff):\n--- old\n${a
      .slice(0, 40)
      .map((s) => '- ' + s)
      .join('\n')}\n+++ new\n${b
      .slice(0, 40)
      .map((s) => '+ ' + s)
      .join('\n')}`;
  const n = a.length,
    m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? 1 + dp[i + 1]![j + 1]! : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  let i = 0,
    j = 0;
  const lines: string[] = ['--- previous', '+++ proposed'];
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      lines.push('  ' + a[i]);
      i++;
      j++;
    } else if (j < m && (i === n || dp[i]![j + 1]! >= dp[i + 1]![j]!)) lines.push('+ ' + b[j++]);
    else lines.push('- ' + a[i++]);
    if (lines.length >= maxLines) {
      lines.push(`... diff truncated at ${maxLines} lines`);
      break;
    }
  }
  return lines.join('\n');
}
