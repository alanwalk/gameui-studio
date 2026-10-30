import type { Rect } from '../types';

const MAX_DETAIL_PIXELS = 24;
const MIN_BODY_PIXELS = 64;
const MAX_DETAIL_DISTANCE = 7;
const MAX_FRAGMENT_ALPHA = 16;
const MIN_SOFT_ASSET_ALPHA_MASS = 2;

type AlphaComponent = {
  id: number;
  rect: Rect;
  pixels: number;
};

export type AlphaSheetPixels = {
  rect: Rect;
  rgba: Uint8ClampedArray;
  pixelCount: number;
  componentCount: number;
};

export type AlphaSheetDiagnostics = {
  /** Nonzero source pixels excluded from asset output; the original sheet retains them. */
  ungroupedPixelCount: number;
  ungroupedComponentCount: number;
  warnings: string[];
};

export type AlphaSheetAnalysis = {
  components: AlphaSheetPixels[];
  diagnostics: AlphaSheetDiagnostics;
};

function visitNeighbours(index: number, width: number, height: number, visit: (next: number) => void): void {
  const x = index % width;
  const y = Math.floor(index / width);
  for (let offsetY = -1; offsetY <= 1; offsetY++) {
    for (let offsetX = -1; offsetX <= 1; offsetX++) {
      if (offsetX === 0 && offsetY === 0) continue;
      const nextX = x + offsetX;
      const nextY = y + offsetY;
      if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
      visit(nextY * width + nextX);
    }
  }
}

/**
 * Find support before choosing cores. A real continuous soft tail belongs to its
 * support domain; a separate translucent asset must not be absorbed across a gap.
 */
function labelComponents(data: Uint8ClampedArray, width: number, height: number): {
  labels: Int32Array;
  components: AlphaComponent[];
  sharedSupportCount: number;
} {
  const total = width * height;
  const labels = new Int32Array(total);
  const supportLabels = new Int32Array(total);
  const queue = new Int32Array(total);
  const supportPeaks = [0];
  const supportAlphaMass = [0];
  let supportCount = 0;

  for (let start = 0; start < total; start++) {
    if (supportLabels[start] || data[start * 4 + 3] === 0) continue;
    const identity = ++supportCount;
    let head = 0;
    let tail = 1;
    let peak = 0;
    let alphaSum = 0;
    queue[0] = start;
    supportLabels[start] = identity;
    while (head < tail) {
      const current = queue[head++];
      const alpha = data[current * 4 + 3];
      peak = Math.max(peak, alpha);
      alphaSum += alpha;
      visitNeighbours(current, width, height, (next) => {
        if (supportLabels[next] || data[next * 4 + 3] === 0) return;
        supportLabels[next] = identity;
        queue[tail++] = next;
      });
    }
    supportPeaks[identity] = peak;
    supportAlphaMass[identity] = alphaSum / 255;
  }

  let componentCount = 0;
  const supportCoreCounts = new Uint32Array(supportCount + 1);
  const labelConnectedPixels = (start: number, alphaThreshold: number) => {
    const identity = ++componentCount;
    let head = 0;
    let tail = 1;
    labels[start] = identity;
    queue[0] = start;
    while (head < tail) {
      const current = queue[head++];
      visitNeighbours(current, width, height, (next) => {
        if (labels[next] || data[next * 4 + 3] <= alphaThreshold) return;
        labels[next] = identity;
        queue[tail++] = next;
      });
    }
  };

  for (let index = 0; index < total; index++) {
    const supportId = supportLabels[index];
    if (!supportId || labels[index]) continue;
    const peak = supportPeaks[supportId];
    const isLowMassFragment = peak <= MAX_FRAGMENT_ALPHA && supportAlphaMass[supportId] < MIN_SOFT_ASSET_ALPHA_MASS;
    if (isLowMassFragment) continue;
    // A fixed threshold merges opaque assets across alpha-9/32/64 shadow bridges.
    // Relative peaks also give an entirely translucent independent asset its own
    // core, even when every pixel is below the threshold used by an opaque asset.
    const threshold = Math.floor(peak * 0.5);
    if (data[index * 4 + 3] <= threshold) continue;
    labelConnectedPixels(index, threshold);
    supportCoreCounts[supportId]++;
  }

  // Multi-source growth is restricted to existing positive-alpha support. A
  // single-core domain keeps its full soft tail, irrespective of tail length;
  // multiple cores partition their shared support without ever merging cores.
  let head = 0;
  let tail = 0;
  for (let index = 0; index < total; index++) {
    if (labels[index]) queue[tail++] = index;
  }
  while (head < tail) {
    const current = queue[head++];
    visitNeighbours(current, width, height, (next) => {
      if (labels[next] || data[next * 4 + 3] === 0) return;
      labels[next] = labels[current];
      queue[tail++] = next;
    });
  }

  // Remaining low-mass support domains stay whole for contextual grouping or
  // explicit residual diagnostics. They never donate individual pixels to a
  // nearby frame simply because that frame's bounding box encloses them.
  for (let index = 0; index < total; index++) {
    if (!labels[index] && data[index * 4 + 3] > 0) labelConnectedPixels(index, 0);
  }

  const components: AlphaComponent[] = Array.from({ length: componentCount }, (_, index) => ({
    id: index + 1,
    rect: { x: width, y: height, w: 0, h: 0 },
    pixels: 0,
  }));
  for (let index = 0; index < total; index++) {
    const componentId = labels[index];
    if (!componentId) continue;
    const component = components[componentId - 1];
    const x = index % width;
    const y = Math.floor(index / width);
    if (component.pixels === 0) {
      component.rect = { x, y, w: 1, h: 1 };
    } else {
      const right = Math.max(component.rect.x + component.rect.w, x + 1);
      const bottom = Math.max(component.rect.y + component.rect.h, y + 1);
      component.rect.x = Math.min(component.rect.x, x);
      component.rect.y = Math.min(component.rect.y, y);
      component.rect.w = right - component.rect.x;
      component.rect.h = bottom - component.rect.y;
    }
    component.pixels++;
  }
  const sharedSupportCount = supportCoreCounts.filter((count) => count > 1).length;
  return { labels, components, sharedSupportCount };
}

function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

/**
 * Attach only small, isolated details to an unambiguous nearby original body.
 * Neither merged boxes nor attached details can attract further components.
 */
function assignComponentBodies(
  labels: Int32Array,
  components: AlphaComponent[],
  width: number,
  height: number,
): Int32Array {
  const bodies = Int32Array.from({ length: components.length + 1 }, (_, index) => index);
  for (const detail of components) {
    if (detail.pixels > MAX_DETAIL_PIXELS) continue;
    const distances = new Map<number, number>();
    for (let y = detail.rect.y; y < detail.rect.y + detail.rect.h; y++) {
      for (let x = detail.rect.x; x < detail.rect.x + detail.rect.w; x++) {
        if (labels[y * width + x] !== detail.id) continue;
        for (let offsetY = -MAX_DETAIL_DISTANCE; offsetY <= MAX_DETAIL_DISTANCE; offsetY++) {
          for (let offsetX = -MAX_DETAIL_DISTANCE; offsetX <= MAX_DETAIL_DISTANCE; offsetX++) {
            const nextX = x + offsetX;
            const nextY = y + offsetY;
            if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
            const bodyId = labels[nextY * width + nextX];
            if (!bodyId || bodyId === detail.id) continue;
            const body = components[bodyId - 1];
            if (body.pixels < MIN_BODY_PIXELS) continue;
            const squaredDistance = offsetX * offsetX + offsetY * offsetY;
            const previousDistance = distances.get(bodyId) ?? Number.POSITIVE_INFINITY;
            if (squaredDistance < previousDistance) distances.set(bodyId, squaredDistance);
          }
        }
      }
    }

    const nearest = [...distances].sort((left, right) => left[1] - right[1]);
    if (!nearest.length) continue;
    const [bodyId, squaredDistance] = nearest[0];
    const body = components[bodyId - 1];
    // A separate mark inside a hollow frame may be another asset; box overlap
    // alone supplies no evidence that it belongs to the frame.
    if (containsRect(body.rect, detail.rect)) continue;
    if (detail.pixels > body.pixels * 0.15) continue;
    const maxDistance = Math.min(MAX_DETAIL_DISTANCE, 2 + Math.floor(Math.min(body.rect.w, body.rect.h) * 0.03));
    if (squaredDistance > maxDistance * maxDistance) continue;
    if (nearest.length > 1 && Math.sqrt(nearest[1][1]) - Math.sqrt(squaredDistance) < 2) continue;
    bodies[detail.id] = bodyId;
  }
  return bodies;
}

/** Pure extraction with explicit accounting for unassigned low-opacity fragments. */
export function analyzeAlphaSheetPixels(data: Uint8ClampedArray, width: number, height: number): AlphaSheetAnalysis {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.length !== width * height * 4) {
    throw new Error('AI 拆图素材表像素尺寸无效');
  }
  let transparentPixels = 0;
  let visiblePixels = 0;
  for (let index = 3; index < data.length; index += 4) {
    if (data[index] === 0) transparentPixels++;
    else visiblePixels++;
  }
  if (!visiblePixels) throw new Error('AI 拆图素材表中没有找到透明前景组件');
  if (!transparentPixels) throw new Error('AI 拆图素材表没有真正透明的背景；棋盘格或纯色背景不能作为透明素材拆分');

  const { labels, components, sharedSupportCount } = labelComponents(data, width, height);
  const bodies = assignComponentBodies(labels, components, width, height);
  const groups = new Map<number, { rect: Rect; pixelCount: number; componentCount: number }>();
  for (const component of components) {
    const bodyId = bodies[component.id];
    const group = groups.get(bodyId);
    if (!group) {
      groups.set(bodyId, { rect: { ...component.rect }, pixelCount: component.pixels, componentCount: 1 });
      continue;
    }
    const right = Math.max(group.rect.x + group.rect.w, component.rect.x + component.rect.w);
    const bottom = Math.max(group.rect.y + group.rect.h, component.rect.y + component.rect.h);
    group.rect.x = Math.min(group.rect.x, component.rect.x);
    group.rect.y = Math.min(group.rect.y, component.rect.y);
    group.rect.w = right - group.rect.x;
    group.rect.h = bottom - group.rect.y;
    group.pixelCount += component.pixels;
    group.componentCount++;
  }

  const diagnostics: AlphaSheetDiagnostics = { ungroupedPixelCount: 0, ungroupedComponentCount: 0, warnings: [] };
  const assets: AlphaSheetPixels[] = [];
  for (const [bodyId, group] of groups) {
    const { rect } = group;
    const rgba = new Uint8ClampedArray(rect.w * rect.h * 4);
    let maxAlpha = 0;
    let alphaSum = 0;
    for (let y = 0; y < rect.h; y++) {
      for (let x = 0; x < rect.w; x++) {
        const sourceIndex = (rect.y + y) * width + rect.x + x;
        if (bodies[labels[sourceIndex]] !== bodyId) continue;
        const sourceOffset = sourceIndex * 4;
        const targetOffset = (y * rect.w + x) * 4;
        rgba.set(data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
        maxAlpha = Math.max(maxAlpha, data[sourceOffset + 3]);
        alphaSum += data[sourceOffset + 3];
      }
    }
    // Area alone would delete small icons. Require both very low peak opacity
    // and less than two opaque pixels' worth of coverage. Attached feather pixels
    // are already part of their body and are never thresholded here.
    if (maxAlpha <= MAX_FRAGMENT_ALPHA && alphaSum / 255 < MIN_SOFT_ASSET_ALPHA_MASS) {
      diagnostics.ungroupedPixelCount += group.pixelCount;
      diagnostics.ungroupedComponentCount += group.componentCount;
      continue;
    }
    assets.push({ ...group, rgba });
  }
  if (diagnostics.ungroupedComponentCount > 0) {
    diagnostics.warnings.push(`发现 ${diagnostics.ungroupedComponentCount} 个孤立低透明度残片（${diagnostics.ungroupedPixelCount} 像素），未生成独立素材；可在原始组件表中检查并恢复。`);
  }
  if (sharedSupportCount > 0) {
    diagnostics.warnings.push(`有 ${sharedSupportCount} 组主体共享半透明支撑像素，已分别归属以避免阴影串连；请复查是否需要合并同一素材的多部件。`);
  }
  if (!assets.length) {
    throw new Error('AI 拆图素材表仅含低透明度残片，没有可用主体；请检查原始组件表');
  }
  assets.sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  return { components: assets, diagnostics };
}

/** A crop contains only its assigned components, not all art inside its rectangle. */
export function splitAlphaSheetPixels(data: Uint8ClampedArray, width: number, height: number): AlphaSheetPixels[] {
  return analyzeAlphaSheetPixels(data, width, height).components;
}
