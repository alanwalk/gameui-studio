import type { BorderReport, ElementKind, Rect, UiElement } from '../types';
import { loadImageElement } from './image';
import { createUuid } from './uuid';

const ALPHA_THRESHOLD = 8;
const MIN_COMPONENT_PIXELS = 24;
const MERGE_GAP = 4;

type AlphaComponent = {
  rect: Rect;
  pixels: number;
};

function mergeNearbyComponents(components: AlphaComponent[]): AlphaComponent[] {
  const merged = [...components];
  let changed = true;
  while (changed) {
    changed = false;
    for (let leftIndex = 0; leftIndex < merged.length && !changed; leftIndex++) {
      const left = merged[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < merged.length; rightIndex++) {
        const right = merged[rightIndex];
        const near = left.rect.x - MERGE_GAP <= right.rect.x + right.rect.w &&
          right.rect.x - MERGE_GAP <= left.rect.x + left.rect.w &&
          left.rect.y - MERGE_GAP <= right.rect.y + right.rect.h &&
          right.rect.y - MERGE_GAP <= left.rect.y + left.rect.h;
        if (!near) continue;
        const x = Math.min(left.rect.x, right.rect.x);
        const y = Math.min(left.rect.y, right.rect.y);
        const rightEdge = Math.max(left.rect.x + left.rect.w, right.rect.x + right.rect.w);
        const bottomEdge = Math.max(left.rect.y + left.rect.h, right.rect.y + right.rect.h);
        merged[leftIndex] = {
          rect: { x, y, w: rightEdge - x, h: bottomEdge - y },
          pixels: left.pixels + right.pixels,
        };
        merged.splice(rightIndex, 1);
        changed = true;
        break;
      }
    }
  }
  return merged;
}

function findAlphaComponents(data: Uint8ClampedArray, width: number, height: number): AlphaComponent[] {
  const foreground = new Uint8Array(width * height);
  for (let pixel = 0; pixel < foreground.length; pixel++) {
    if (data[pixel * 4 + 3] > ALPHA_THRESHOLD) foreground[pixel] = 1;
  }

  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const components: AlphaComponent[] = [];
  for (let start = 0; start < foreground.length; start++) {
    if (!foreground[start] || visited[start]) continue;
    let stackSize = 0;
    let pixels = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    stack[stackSize++] = start;
    visited[start] = 1;

    while (stackSize > 0) {
      const index = stack[--stackSize];
      const x = index % width;
      const y = (index - x) / width;
      pixels++;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      if (x > 0) {
        const next = index - 1;
        if (foreground[next] && !visited[next]) {
          visited[next] = 1;
          stack[stackSize++] = next;
        }
      }
      if (x + 1 < width) {
        const next = index + 1;
        if (foreground[next] && !visited[next]) {
          visited[next] = 1;
          stack[stackSize++] = next;
        }
      }
      if (y > 0) {
        const next = index - width;
        if (foreground[next] && !visited[next]) {
          visited[next] = 1;
          stack[stackSize++] = next;
        }
      }
      if (y + 1 < height) {
        const next = index + width;
        if (foreground[next] && !visited[next]) {
          visited[next] = 1;
          stack[stackSize++] = next;
        }
      }
    }

    if (pixels >= MIN_COMPONENT_PIXELS) {
      components.push({
        rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
        pixels,
      });
    }
  }
  return components;
}

function inferKind(width: number, height: number): ElementKind {
  const ratio = width / Math.max(1, height);
  if (ratio > 5) return 'progress';
  if (width >= 160 && height >= 80) return 'panel';
  if (width >= 50 && height >= 24) return 'button';
  return 'icon';
}

function emptyBorder(): BorderReport {
  return {
    bgColor: [0, 0, 0],
    sideScore: { top: 0, right: 0, bottom: 0, left: 0 },
    dirtySides: [],
  };
}

export async function sliceAlphaSheet(dataUrl: string): Promise<{ width: number; height: number; elements: UiElement[] }> {
  const image = await loadImageElement(dataUrl);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceContext = source.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('无法读取 AI 拆图素材表');
  sourceContext.drawImage(image, 0, 0);
  const pixels = sourceContext.getImageData(0, 0, width, height);
  const components = mergeNearbyComponents(findAlphaComponents(pixels.data, width, height))
    .sort((left, right) => left.rect.y - right.rect.y || left.rect.x - right.rect.x);
  if (!components.length) throw new Error('AI 拆图素材表中没有找到透明前景组件');

  const elements = components.map((component, index): UiElement => {
    const { rect } = component;
    const canvas = document.createElement('canvas');
    canvas.width = rect.w;
    canvas.height = rect.h;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 AI 拆图组件画布');
    context.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    const number = String(index + 1).padStart(2, '0');
    return {
      id: `ai-sheet-${createUuid()}`,
      rect,
      kind: inferKind(rect.w, rect.h),
      label: `AI组件${number}`,
      description: 'AI 透明素材表自动拆分',
      objectName: `AiComponent${number}`,
      state: 'Normal',
      layer: index,
      occluded: false,
      needsAi: false,
      approved: true,
      extractionMethod: 'ai-sheet',
      repainted: false,
      processingStatus: 'done',
      slice: {
        width: rect.w,
        height: rect.h,
        canvas,
        border: emptyBorder(),
      },
    };
  });

  return { width, height, elements };
}
