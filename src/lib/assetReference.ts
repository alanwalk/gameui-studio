import type { Rect, UiElement } from '../types';
import { canvasToDataUrl } from './image';

export function referenceCrop(rect: Rect, width: number, height: number, padding: number): Rect {
  if (![rect.x, rect.y, rect.w, rect.h, width, height, padding].every(Number.isSafeInteger) ||
      width <= 0 || height <= 0 || rect.w <= 0 || rect.h <= 0 || padding < 0 ||
      rect.x < 0 || rect.y < 0 || rect.x + rect.w > width || rect.y + rect.h > height) {
    throw new Error('素材参考区域必须位于原图范围内');
  }
  const x = Math.max(0, rect.x - padding);
  const y = Math.max(0, rect.y - padding);
  const right = Math.min(width, rect.x + rect.w + padding);
  const bottom = Math.min(height, rect.y + rect.h + padding);
  return { x, y, w: right - x, h: bottom - y };
}

function cropImage(image: HTMLImageElement, rect: Rect): string {
  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建局部素材参考图');
  context.drawImage(image, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return canvasToDataUrl(canvas);
}

/** Give the image provider a specific target rather than asking it to find it again in a full screen. */
export async function prepareAssetReferences(element: UiElement, sourceDataUrl?: string): Promise<{
  referenceDataUrl: string;
  contextDataUrl?: string;
}> {
  const target = element.slice ? canvasToDataUrl(element.slice.canvas) : undefined;
  if (!sourceDataUrl) {
    if (!target) throw new Error('素材缺少可用的参考图片');
    return { referenceDataUrl: target };
  }
  if (element.coordinateSpace === 'sheet' || element.extractionMethod === 'ai-sheet') {
    if (!target) throw new Error('组件表素材缺少独立图片，不能使用原界面坐标补图');
    return { referenceDataUrl: target };
  }
  const source = new Image();
  source.src = sourceDataUrl;
  await source.decode();
  const bounds = referenceCrop(element.rect, source.naturalWidth, source.naturalHeight, 0);
  const padding = Math.max(4, Math.min(32, Math.ceil(Math.max(bounds.w, bounds.h) * 0.1)));
  const contextBounds = referenceCrop(bounds, source.naturalWidth, source.naturalHeight, padding);
  return {
    referenceDataUrl: target ?? cropImage(source, bounds),
    contextDataUrl: cropImage(source, contextBounds),
  };
}
