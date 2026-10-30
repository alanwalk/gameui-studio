import type { UiElement } from '../types';
import { scoreRect } from './key';
import { imageUrl } from './magpie';

export type SegmentationPoint = { x: number; y: number; label: 0 | 1 };
export type SegmentationProgress = { stage: 'slice'; done: number; total: number; message: string };

async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

export async function segmentElement(sourceImage: string, element: UiElement, points?: SegmentationPoint[]): Promise<UiElement> {
  // Snapshot the rect before awaiting; callers retain ownership of the original element/canvas.
  const rect = { ...element.rect };
  const response = await fetch('/api/segment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceImage, rect, points, kind: element.kind }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `分割失败 ${response.status}`);
  const [source, rgba] = await Promise.all([
    decodeImage(imageUrl(sourceImage)), decodeImage(`data:image/png;base64,${result.rgbaBase64}`),
  ]);
  const width = source.naturalWidth;
  const height = source.naturalHeight;
  if (result.width !== width || result.height !== height || rgba.naturalWidth !== width || rgba.naturalHeight !== height) {
    throw new Error('分割响应尺寸与原图不一致');
  }
  if (![rect.x, rect.y, rect.w, rect.h].every(Number.isInteger) || rect.x < 0 || rect.y < 0 || rect.w <= 0 || rect.h <= 0 ||
      rect.x + rect.w > width || rect.y + rect.h > height) throw new Error('元素 rect 必须是原图内的整数像素矩形');

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('无法创建原图画布');
  sourceContext.drawImage(source, 0, 0);
  const sourcePixels = sourceContext.getImageData(0, 0, width, height);
  // This measures the original rectangle edges for legacy exports, not mask quality.
  const border = scoreRect(sourcePixels, rect, 3);
  const cropPixels = sourceContext.getImageData(rect.x, rect.y, rect.w, rect.h);

  const rgbaCanvas = document.createElement('canvas');
  rgbaCanvas.width = rect.w;
  rgbaCanvas.height = rect.h;
  const rgbaContext = rgbaCanvas.getContext('2d');
  if (!rgbaContext) throw new Error('无法创建分割画布');
  rgbaContext.drawImage(rgba, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  const segmentedPixels = rgbaContext.getImageData(0, 0, rect.w, rect.h);
  for (let i = 3; i < cropPixels.data.length; i += 4) cropPixels.data[i] = segmentedPixels.data[i];
  rgbaContext.putImageData(cropPixels, 0, 0);

  const maskResponse = await fetch('/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: `data:image/png;base64,${result.maskBase64}`, prefix: 'segmentation-mask' }),
  });
  const mask = await maskResponse.json();
  if (!maskResponse.ok || typeof mask.fileName !== 'string' || !mask.fileName) {
    throw new Error(mask.error || '分割蒙版保存失败');
  }
  return {
    ...element, rect, extractionMethod: 'segmentation', repainted: false, maskImage: mask.fileName,
    slice: { width: rect.w, height: rect.h, canvas: rgbaCanvas, border },
  };
}

/** Sequential CPU work: errors are explicit, and the caller's source elements stay untouched. */
export async function segmentElements(
  elements: UiElement[], sourceImage: string, onProgress: (progress: SegmentationProgress) => void,
): Promise<UiElement[]> {
  const segmented: UiElement[] = [];
  for (const element of elements) {
    onProgress({ stage: 'slice', done: segmented.length, total: elements.length, message: `正在分割 ${element.label}` });
    try {
      segmented.push(await segmentElement(sourceImage, element));
    } catch (error) {
      throw new Error(`分割 ${element.label}（${element.id}）失败：${error instanceof Error ? error.message : String(error)}`);
    }
    onProgress({ stage: 'slice', done: segmented.length, total: elements.length, message: `已分割 ${element.label}` });
  }
  return segmented;
}
