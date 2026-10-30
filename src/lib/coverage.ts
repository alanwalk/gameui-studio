import type { Rect, UiElement } from '../types';
import { clampRect } from './key';

export type CoverageReport = {
  /** Fraction of image pixels NOT covered by any approved element, 0..1. */
  uncoveredRatio: number;
  uncoveredRatioNoBg: number;
  holes: Array<Rect & { area: number }>;
  largestHole: number;
};

const GRID = 48;

/**
 * Rasterizes the accepted boxes onto a coarse grid and reports what is left over.
 * A high uncovered ratio means the vision model MISSED elements - the failure mode
 * that hurts most, because nobody notices an asset that was never extracted.
 */
export function auditCoverage(
  elements: UiElement[],
  width: number,
  height: number,
): CoverageReport {
  const cols = GRID;
  const rows = GRID;
  const covered = new Uint8Array(cols * rows);
  const coveredNoBg = new Uint8Array(cols * rows);

  const cellW = width / cols;
  const cellH = height / rows;

  const accepted = elements.filter((e) => e.approved);
  const withoutBackground = accepted.filter((e) => e.kind !== 'decor');

  const mark = (target: Uint8Array, rect: Rect) => {
    const box = clampRect(rect, width, height);
    const x0 = Math.max(0, Math.floor(box.x / cellW));
    const y0 = Math.max(0, Math.floor(box.y / cellH));
    const x1 = Math.min(cols - 1, Math.ceil((box.x + box.w) / cellW) - 1);
    const y1 = Math.min(rows - 1, Math.ceil((box.y + box.h) / cellH) - 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        target[y * cols + x] = 1;
      }
    }
  };

  for (const element of accepted) mark(covered, element.rect);
  for (const element of withoutBackground) mark(coveredNoBg, element.rect);

  // The two ratios are counted independently: a decor-only box legitimately counts as
  // covered in the first but must still count as uncovered in the second.
  let uncovered = 0;
  let uncoveredNoBg = 0;
  for (let i = 0; i < covered.length; i++) {
    if (!covered[i]) uncovered++;
    if (!coveredNoBg[i]) uncoveredNoBg++;
  }

  const holes = findHoles(covered, cols, rows, cellW, cellH);
  const total = cols * rows;

  return {
    uncoveredRatio: uncovered / total,
    uncoveredRatioNoBg: uncoveredNoBg / total,
    holes: holes.slice(0, 12),
    largestHole: holes.length > 0 ? holes[0].area : 0,
  };
}

/** Groups adjacent uncovered cells into rectangular holes so the UI can point at them. */
function findHoles(
  covered: Uint8Array,
  cols: number,
  rows: number,
  cellW: number,
  cellH: number,
): Array<Rect & { area: number }> {
  const holes: Array<Rect & { area: number }> = [];
  const visited = new Uint8Array(cols * rows);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const start = y * cols + x;
      if (covered[start] || visited[start]) continue;

      let x1 = x;
      while (x1 + 1 < cols && !covered[y * cols + x1 + 1] && !visited[y * cols + x1 + 1]) {
        x1++;
      }

      let y1 = y;
      let canExtend = true;
      while (canExtend && y1 + 1 < rows) {
        for (let cx = x; cx <= x1; cx++) {
          const below = (y1 + 1) * cols + cx;
          if (covered[below] || visited[below]) {
            canExtend = false;
            break;
          }
        }
        if (canExtend) y1++;
      }

      for (let cy = y; cy <= y1; cy++) {
        for (let cx = x; cx <= x1; cx++) visited[cy * cols + cx] = 1;
      }

      const rect = {
        x: Math.round(x * cellW),
        y: Math.round(y * cellH),
        w: Math.round((x1 - x + 1) * cellW),
        h: Math.round((y1 - y + 1) * cellH),
      };
      holes.push({ ...rect, area: rect.w * rect.h });
    }
  }

  return holes.sort((a, b) => b.area - a.area);
}
