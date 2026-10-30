import type { BorderReport, BorderSide, Rect, SliceResult } from '../types';

export type KeyOptions = {
  tolerance: number;
  softness: number;
  hardEdge: boolean;
  fringeFix: boolean;
};

const SIDES: BorderSide[] = ['top', 'right', 'bottom', 'left'];

/** Normalized RGB distance in 0..1, so tolerance/softness read as plain percentages. */
function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db) / 441.673;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function clampRect(rect: Rect, w: number, h: number): Rect {
  let x = Math.max(0, Math.min(w, Math.round(rect.x)));
  let y = Math.max(0, Math.min(h, Math.round(rect.y)));
  let rw = Math.max(1, Math.round(rect.w));
  let rh = Math.max(1, Math.round(rect.h));
  if (x + rw > w) rw = w - x;
  if (y + rh > h) rh = h - y;
  if (rw <= 0) rw = 1;
  if (rh <= 0) rh = 1;
  return { x, y, w: rw, h: rh };
}

function readPixel(src: ImageData, x: number, y: number): [number, number, number] {
  const i = (y * src.width + x) * 4;
  return [src.data[i], src.data[i + 1], src.data[i + 2]];
}

/**
 * Median colour of the outer ring around `rect`. Sampling the surroundings (not the
 * element interior) is what keeps a bright element from poisoning its own key colour.
 */
export function sampleBackgroundColor(src: ImageData, rect: Rect): [number, number, number] {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  const pad = Math.max(2, Math.round(Math.min(rect.w, rect.h) * 0.04));

  const push = (x: number, y: number) => {
    const [pr, pg, pb] = readPixel(src, x, y);
    r.push(pr);
    g.push(pg);
    b.push(pb);
  };

  for (let d = 1; d <= pad; d++) {
    const top = rect.y - d;
    const bottom = rect.y + rect.h - 1 + d;
    const left = rect.x - d;
    const right = rect.x + rect.w - 1 + d;
    if (top >= 0) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x >= 0 && x < src.width) push(x, top);
      }
    }
    if (bottom < src.height) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        if (x >= 0 && x < src.width) push(x, bottom);
      }
    }
    if (left >= 0) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        if (y >= 0 && y < src.height) push(left, y);
      }
    }
    if (right < src.width) {
      for (let y = rect.y; y < rect.y + rect.h; y++) {
        if (y >= 0 && y < src.height) push(right, y);
      }
    }
  }

  if (r.length === 0) {
    // Element fills the whole image; fall back to the crop's own outer ring.
    return sampleRingOfCrop(src, rect);
  }
  return [median(r), median(g), median(b)];
}

function sampleRingOfCrop(src: ImageData, rect: Rect): [number, number, number] {
  const r: number[] = [];
  const g: number[] = [];
  const b: number[] = [];
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    let [pr, pg, pb] = readPixel(src, x, rect.y);
    r.push(pr);
    g.push(pg);
    b.push(pb);
    [pr, pg, pb] = readPixel(src, x, rect.y + rect.h - 1);
    r.push(pr);
    g.push(pg);
    b.push(pb);
  }
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    let [pr, pg, pb] = readPixel(src, rect.x, y);
    r.push(pr);
    g.push(pg);
    b.push(pb);
    [pr, pg, pb] = readPixel(src, rect.x + rect.w - 1, y);
    r.push(pr);
    g.push(pg);
    b.push(pb);
  }
  return [median(r), median(g), median(b)];
}

/**
 * Flood fill inward from the crop border. Only background CONNECTED to the border is
 * removed, so an interior button that happens to match the panel colour survives.
 */
function floodBackground(
  w: number,
  h: number,
  rgb: Uint8ClampedArray,
  bg: [number, number, number],
  threshold: number,
): Uint8Array {
  const total = w * h;
  const isBg = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const seed = (x: number, y: number) => {
    const idx = y * w + x;
    if (isBg[idx]) return;
    const p = idx * 4;
    const d = colorDistance(rgb[p], rgb[p + 1], rgb[p + 2], bg[0], bg[1], bg[2]);
    if (d > threshold) return;
    isBg[idx] = 1;
    queue[tail++] = idx;
  };

  for (let x = 0; x < w; x++) {
    seed(x, 0);
    seed(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    seed(0, y);
    seed(w - 1, y);
  }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % w;
    const y = (idx - x) / w;

    if (x > 0) seedStep(x - 1, y);
    if (x < w - 1) seedStep(x + 1, y);
    if (y > 0) seedStep(x, y - 1);
    if (y < h - 1) seedStep(x, y + 1);
  }

  function seedStep(nx: number, ny: number) {
    const nidx = ny * w + nx;
    if (isBg[nidx]) return;
    const p = nidx * 4;
    const d = colorDistance(rgb[p], rgb[p + 1], rgb[p + 2], bg[0], bg[1], bg[2]);
    if (d > threshold) return;
    isBg[nidx] = 1;
    queue[tail++] = nidx;
  }

  return isBg;
}

/**
 * Pulls background colour out of the semi-transparent feather band, which otherwise
 * leaves a grey halo once the PNG is placed on a different backdrop.
 */
function fringeFix(
  w: number,
  h: number,
  rgb: Uint8ClampedArray,
  alpha: Float32Array,
): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const a = alpha[idx];
      if (a <= 0.001 || a >= 0.9) continue;

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const nidx = ny * w + nx;
          if (alpha[nidx] < 0.9) continue;
          const p = nidx * 4;
          sr += rgb[p];
          sg += rgb[p + 1];
          sb += rgb[p + 2];
          count++;
        }
      }
      if (count === 0) continue;
      const p = idx * 4;
      rgb[p] = sr / count;
      rgb[p + 1] = sg / count;
      rgb[p + 2] = sb / count;
    }
  }
}

export type KeyedPixels = {
  width: number;
  height: number;
  /** RGBA, with the alpha channel already applied. */
  rgba: Uint8ClampedArray;
  bgColor: [number, number, number];
};

/**
 * Mean RGB of a rectangular band running parallel to one rect edge. `offset` shifts the
 * band inward: 0 samples just inside the edge, `band` samples just outside it.
 */
function bandMean(
  src: ImageData,
  rect: Rect,
  side: BorderSide,
  band: number,
  outward: boolean,
): [number, number, number] {
  const horizontal = side === 'top' || side === 'bottom';
  const span = horizontal ? rect.w : rect.h;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;

  for (let d = 0; d < band; d++) {
    for (let i = 0; i < span; i++) {
      let x: number;
      let y: number;
      // `d` walks away from the edge: inward for the inside band, outward for the
      // outside band. Both bands start on the first pixel on their own side.
      if (side === 'top') {
        x = rect.x + i;
        y = outward ? rect.y - 1 - d : rect.y + d;
      } else if (side === 'bottom') {
        x = rect.x + i;
        y = outward ? rect.y + rect.h + d : rect.y + rect.h - 1 - d;
      } else if (side === 'left') {
        x = outward ? rect.x - 1 - d : rect.x + d;
        y = rect.y + i;
      } else {
        x = outward ? rect.x + rect.w + d : rect.x + rect.w - 1 - d;
        y = rect.y + i;
      }
      if (x < 0 || y < 0 || x >= src.width || y >= src.height) continue;
      const [r, g, b] = readPixel(src, x, y);
      sr += r;
      sg += g;
      sb += b;
      count++;
    }
  }

  if (count === 0) return [0, 0, 0];
  return [sr / count, sg / count, sb / count];
}

/**
 * The whole extraction, isolated from canvas creation so it can be tested headlessly.
 * `sliceElement` is a thin wrapper that paints this result onto a canvas.
 */
export function keyElement(
  src: ImageData,
  rectIn: Rect,
  options: KeyOptions,
): KeyedPixels {
  const rect = clampRect(rectIn, src.width, src.height);
  const w = rect.w;
  const h = rect.h;

  const rgb = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sRow = (rect.y + y) * src.width + rect.x;
    const dRow = y * w;
    for (let x = 0; x < w; x++) {
      const s = (sRow + x) * 4;
      const d = (dRow + x) * 4;
      rgb[d] = src.data[s];
      rgb[d + 1] = src.data[s + 1];
      rgb[d + 2] = src.data[s + 2];
      rgb[d + 3] = 255;
    }
  }

  const bg = sampleBackgroundColor(src, rect);
  const tol01 = options.tolerance / 100;
  const soft01 = Math.max(options.softness / 100, 0.0001);
  const isBg = floodBackground(w, h, rgb, bg, tol01 + soft01);

  const alpha = new Float32Array(w * h);
  for (let idx = 0; idx < w * h; idx++) {
    if (!isBg[idx]) {
      alpha[idx] = 1;
      continue;
    }
    const p = idx * 4;
    const d = colorDistance(rgb[p], rgb[p + 1], rgb[p + 2], bg[0], bg[1], bg[2]);
    if (d <= tol01) {
      alpha[idx] = 0;
    } else if (options.hardEdge) {
      alpha[idx] = 0;
    } else {
      alpha[idx] = Math.min(1, (d - tol01) / soft01);
    }
  }

  if (options.fringeFix) {
    fringeFix(w, h, rgb, alpha);
  }

  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let idx = 0; idx < w * h; idx++) {
    const p = idx * 4;
    rgba[p] = rgb[p];
    rgba[p + 1] = rgb[p + 1];
    rgba[p + 2] = rgb[p + 2];
    rgba[p + 3] = Math.round(alpha[idx] * 255);
  }

  return { width: w, height: h, rgba, bgColor: bg };
}

export function sliceElement(
  src: ImageData,
  rectIn: Rect,
  options: KeyOptions,
): SliceResult {
  const keyed = keyElement(src, rectIn, options);
  const canvas = document.createElement('canvas');
  canvas.width = keyed.width;
  canvas.height = keyed.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');

  const out = new ImageData(keyed.rgba, keyed.width, keyed.height);
  ctx.putImageData(out, 0, 0);

  return {
    width: keyed.width,
    height: keyed.height,
    canvas,
    border: scoreRect(src, clampRect(rectIn, src.width, src.height), 3),
  };
}

/**
 * Compares the band just inside each edge with the same-width band just outside.
 * A correct edge has element art on one side and background on the other, so the two
 * bands differ. An edge floating inside the element or overshooting into background
 * has the same colour on both sides, which flags it as dirty.
 */
export function scoreRect(src: ImageData, rect: Rect, band: number): BorderReport {
  const sideScore: Record<BorderSide, number> = { top: 0, right: 0, bottom: 0, left: 0 };
  const inner: [number, number, number][] = [];

  for (const side of SIDES) {
    const inside = bandMean(src, rect, side, band, false);
    const outside = bandMean(src, rect, side, band, true);
    sideScore[side] = colorDistance(inside[0], inside[1], inside[2], outside[0], outside[1], outside[2]);
    inner.push(inside);
  }

  const avg: [number, number, number] = [
    (inner[0][0] + inner[1][0] + inner[2][0] + inner[3][0]) / 4,
    (inner[0][1] + inner[1][1] + inner[2][1] + inner[3][1]) / 4,
    (inner[0][2] + inner[1][2] + inner[2][2] + inner[3][2]) / 4,
  ];

  // Normalized colour contrast below which the edge is not sitting on a real boundary.
  const DIRTY_THRESHOLD = 0.02;
  const dirtySides = SIDES.filter((side) => sideScore[side] < DIRTY_THRESHOLD);

  return { bgColor: avg, sideScore, dirtySides };
}

/**
 * Moves each edge of a model-supplied box to the strongest nearby art boundary. Vision
 * bboxes are routinely off by +/-10px, and this is the cheap correction that makes them
 * usable. Every candidate keeps the opposite three edges fixed, so a bad top edge cannot
 * drag the other three off.
 */
export function refineRect(src: ImageData, rect: Rect): { rect: Rect; score: BorderReport } {
  // 1px steps: for solid art the boundary is only visible in the few pixels that
  // straddle it, so coarse steps step right over the signal.
  const SHIFTS: number[] = [];
  for (let s = -14; s <= 14; s++) SHIFTS.push(s);

  // Box edges, not x/y/w/h: nudging `x` alone would drag the right edge along with it
  // and ruin an edge that was already correct.
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;

  const toRect = (): Rect => ({ x: left, y: top, w: right - left, h: bottom - top });
  const strengthOf = (candidateLeft: number, candidateTop: number, candidateRight: number, candidateBottom: number): number => {
    if (candidateRight - candidateLeft < 4 || candidateBottom - candidateTop < 4) return Number.NEGATIVE_INFINITY;
    const score = scoreRect(src, clampRect({ x: candidateLeft, y: candidateTop, w: candidateRight - candidateLeft, h: candidateBottom - candidateTop }, src.width, src.height), 4);
    return SIDES.reduce((sum, side) => sum + score.sideScore[side], 0);
  };

  // Two passes: the edges interact, so a second sweep settles them after the first moves.
  for (let pass = 0; pass < 2; pass++) {
    for (const side of SIDES) {
      let bestShift = 0;
      let bestStrength = Number.NEGATIVE_INFINITY;

      for (const shift of SHIFTS) {
        let strength = 0;
        if (side === 'top') strength = strengthOf(left, top + shift, right, bottom);
        else if (side === 'bottom') strength = strengthOf(left, top, right, bottom + shift);
        else if (side === 'left') strength = strengthOf(left + shift, top, right, bottom);
        else strength = strengthOf(left, top, right + shift, bottom);

        // A small pull back toward the model keeps this a correction, not a search.
        const penalized = strength - Math.abs(shift) * 0.0009;
        if (penalized > bestStrength) {
          bestStrength = penalized;
          bestShift = shift;
        }
      }

      if (side === 'top') top += bestShift;
      else if (side === 'bottom') bottom += bestShift;
      else if (side === 'left') left += bestShift;
      else right += bestShift;
    }
  }

  const finalRect = clampRect(toRect(), src.width, src.height);
  return { rect: finalRect, score: scoreRect(src, finalRect, 4) };
}
