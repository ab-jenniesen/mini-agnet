import { readFileSync } from 'node:fs';

// Each Braille character holds a 2 × 4 dot image, retaining detail at small sizes.
const dots = [
  [0, 0, 0],
  [0, 1, 1],
  [0, 2, 2],
  [1, 0, 3],
  [1, 1, 4],
  [1, 2, 5],
  [0, 3, 6],
  [1, 3, 7],
] as const;
const thresholds = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;
const source = readFileSync(new URL('../assets/launch-art.txt', import.meta.url), 'utf8')
  .trimEnd()
  .split(/\r?\n/);
const sourceColumns = Math.max(...source.map((line) => line.length));
const pixelWidth = sourceColumns * 2;
const pixelHeight = source.length * 4;
const pixels = Array.from({ length: pixelHeight }, () => new Uint8Array(pixelWidth));

for (const [row, line] of source.entries()) {
  for (const [column, character] of Array.from(line).entries()) {
    const bits = character.codePointAt(0)! - 0x2800;
    if (bits < 0 || bits > 255) continue;
    for (const [x, y, bit] of dots) pixels[row * 4 + y]![column * 2 + x] = (bits >> bit) & 1;
  }
}

/** Average source dots so downscaling preserves both outlines and the hair's shading. */
function darknessAt(x: number, y: number, width: number, height: number): number {
  const left = Math.floor((x * pixelWidth) / width);
  const right = Math.max(left + 1, Math.floor(((x + 1) * pixelWidth) / width));
  const top = Math.floor((y * pixelHeight) / height);
  const bottom = Math.max(top + 1, Math.floor(((y + 1) * pixelHeight) / height));
  let total = 0;
  for (let row = top; row < bottom; row++) {
    for (let column = left; column < right; column++) total += pixels[row]![column]!;
  }
  return total / ((right - left) * (bottom - top));
}

/** Scale uniformly in terminal cells: a square portrait occupies about twice as many columns as rows. */
export function launchArt(columns: number, rows: number): string {
  const availableColumns = Math.max(1, Math.floor(columns));
  const availableRows = Math.max(1, Math.min(18, Math.floor(rows) - 10));
  const scale = Math.min(
    1,
    Math.max(1, availableColumns - 2) / sourceColumns,
    availableRows / source.length,
  );
  const width = Math.max(1, Math.floor(sourceColumns * scale));
  const height = Math.max(1, Math.floor(source.length * scale));
  if (width < 12 || height < 6)
    return Array.from('◈ Mini Agent').slice(0, availableColumns).join('');

  return Array.from({ length: height }, (_, row) =>
    Array.from({ length: width }, (_, column) => {
      let bits = 0;
      for (const [dx, dy, bit] of dots) {
        const x = column * 2 + dx;
        const y = row * 4 + dy;
        const threshold = (thresholds[y % 4]![x % 4]! + 0.5) / 16;
        if (darknessAt(x, y, width * 2, height * 4) > threshold) bits |= 1 << bit;
      }
      return bits ? String.fromCodePoint(0x2800 + bits) : ' ';
    })
      .join('')
      .trimEnd(),
  ).join('\n');
}
