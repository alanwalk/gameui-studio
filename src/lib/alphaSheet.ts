import type { BorderReport, ElementKind, UiElement } from '../types';
import { loadImageElement } from './image';
import { analyzeAlphaSheetPixels, type AlphaSheetDiagnostics } from './alphaComponents';
import { createUuid } from './uuid';

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

export async function sliceAlphaSheet(dataUrl: string): Promise<{
  width: number;
  height: number;
  elements: UiElement[];
  diagnostics: AlphaSheetDiagnostics;
}> {
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
  const { components, diagnostics } = analyzeAlphaSheetPixels(pixels.data, width, height);

  const elements = components.map((component, index): UiElement => {
    const { rect } = component;
    const canvas = document.createElement('canvas');
    canvas.width = rect.w;
    canvas.height = rect.h;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 AI 拆图组件画布');
    context.putImageData(new ImageData(component.rgba, rect.w, rect.h), 0, 0);
    const number = String(index + 1).padStart(2, '0');
    return {
      id: `ai-sheet-${createUuid()}`,
      rect,
      kind: inferKind(rect.w, rect.h),
      label: `AI组件${number}`,
      description: 'AI 透明素材表自动拆分；坐标属于组件表，原界面位置需重新映射',
      objectName: `AiComponent${number}`,
      state: 'Normal',
      layer: index,
      occluded: false,
      needsAi: false,
      approved: false,
      coordinateSpace: 'sheet',
      extractionMethod: 'ai-sheet',
      repainted: true,
      processingStatus: 'done',
      slice: {
        width: rect.w,
        height: rect.h,
        canvas,
        border: emptyBorder(),
      },
    };
  });

  return { width, height, elements, diagnostics };
}
