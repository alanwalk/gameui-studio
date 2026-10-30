import type { UiElement } from '../types';
import { scoreRect } from './key';
import { imageUrl } from './magpie';
import { isSegmentationDiagnostics } from './segmentationTypes';

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
  const promptRect = { ...element.rect };
  const response = await fetch('/api/segment', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceImage, rect: promptRect, points, kind: element.kind }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `分割失败 ${response.status}`);
  const maskBase64: unknown = result.maskBase64;
  if (typeof maskBase64 !== 'string' || !maskBase64) throw new Error('分割结果缺少二值蒙版');
  const [source, rgba] = await Promise.all([
    decodeImage(imageUrl(sourceImage)), decodeImage(`data:image/png;base64,${result.rgbaBase64}`),
  ]);
  const width = source.naturalWidth;
  const height = source.naturalHeight;
  if (result.width !== width || result.height !== height || rgba.naturalWidth !== width || rgba.naturalHeight !== height) {
    throw new Error('分割响应尺寸与原图不一致');
  }
  if (result.protocolVersion !== 2 || !isSegmentationDiagnostics(result, width, height)) {
    throw new Error('分割结果缺少有效的输出边界或精修诊断');
  }
  const expectedPrompt = [promptRect.x, promptRect.y, promptRect.x + promptRect.w, promptRect.y + promptRect.h];
  if (result.promptBounds.some((value, index) => value !== expectedPrompt[index])) throw new Error('分割结果的提示框与请求不一致');
  const [left, top, right, bottom] = result.outputBounds;
  const rect = { x: left, y: top, w: right - left, h: bottom - top };

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw new Error('无法创建原图画布');
  sourceContext.drawImage(source, 0, 0);
  const sourcePixels = sourceContext.getImageData(0, 0, width, height);
  // This measures the original rectangle edges for legacy exports, not mask quality.
  const border = scoreRect(sourcePixels, rect, 3);

  const rgbaCanvas = document.createElement('canvas');
  rgbaCanvas.width = rect.w;
  rgbaCanvas.height = rect.h;
  const rgbaContext = rgbaCanvas.getContext('2d');
  if (!rgbaContext) throw new Error('无法创建分割画布');
  rgbaContext.drawImage(rgba, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);

  const maskResponse = await fetch('/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: `data:image/png;base64,${maskBase64}`, prefix: 'segmentation-mask' }),
  });
  const mask = await maskResponse.json();
  if (!maskResponse.ok || typeof mask.fileName !== 'string' || !mask.fileName) {
    throw new Error(mask.error || '分割蒙版保存失败');
  }
  return {
    ...element, rect, extractionMethod: 'segmentation', repainted: false, approved: false, maskImage: mask.fileName,
    segmentationDiagnostics: {
      promptBounds: result.promptBounds, inferenceBounds: result.inferenceBounds,
      maskBounds: result.maskBounds, outputBounds: result.outputBounds,
      quality: result.quality, refinement: result.refinement,
    },
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
