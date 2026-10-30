import { detectElements } from './magpie.ts';
import type { DetectedElement, LayoutKind, LayoutNode } from '../types';
import { createUuid } from './uuid';

export const DEFAULT_LAYOUT_VISION_MODEL = 'codex/gpt-6.1-terra';
export type LayoutReferencePreview = { nodes: LayoutNode[]; sourceImage: string; width: number; height: number };

export function referenceElementsToLayout(elements: DetectedElement[], width: number, height: number): LayoutNode[] {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('参考图尺寸无效');
  }
  const nodes = [...elements].sort((a, b) => a.layer - b.layer).map((element): LayoutNode => {
    const { x, y, w, h } = element.rect;
    if (![x, y, w, h, x + w, y + h].every(Number.isFinite) || w <= 0 || h <= 0) {
      throw new Error(`元素「${element.label}」的边界无效`);
    }
    const left = Math.max(0, Math.min(width, x));
    const top = Math.max(0, Math.min(height, y));
    const right = Math.max(0, Math.min(width, x + w));
    const bottom = Math.max(0, Math.min(height, y + h));
    if (right <= left || bottom <= top) throw new Error(`元素「${element.label}」不在参考图内`);
    let kind: LayoutKind;
    if (element.kind === 'frame') kind = 'panel';
    else if (element.kind === 'decor') kind = 'image';
    else kind = element.kind;
    return {
      id: `reference-${createUuid()}`, name: element.label, kind,
      rect: { x: left / width, y: top / height, w: (right - left) / width, h: (bottom - top) / height },
      text: element.text,
    };
  });
  if (nodes.length === 0) throw new Error('未识别到布局节点');
  return nodes;
}

/** A stale analysis may finish on the server, but must never reach another screen. */
export async function analyzeLayoutReference(
  dataUrl: string, width: number, height: number, model: string, isCurrent: () => boolean,
): Promise<LayoutReferencePreview | null> {
  if (!isCurrent()) return null;
  const elements = await detectElements({ dataUrl, width, height, model, chineseLabels: true });
  if (!isCurrent()) return null;
  const nodes = referenceElementsToLayout(elements, width, height);
  const response = await fetch('/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, prefix: 'layout-reference' }),
  });
  const payload = await response.json() as { fileName?: string; error?: string };
  if (!isCurrent()) return null;
  if (!response.ok || payload.error || !payload.fileName || /^(data:|blob:)/i.test(payload.fileName)) {
    throw new Error(payload.error ?? '参考图保存失败');
  }
  return { nodes, sourceImage: payload.fileName, width, height };
}

export async function decodeLayoutReference(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取参考图失败'));
    reader.onabort = () => reject(new Error('读取参考图已取消'));
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight) throw new Error('参考图尺寸无效');
  return { dataUrl, width: image.naturalWidth, height: image.naturalHeight };
}
