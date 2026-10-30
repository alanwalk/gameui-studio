import type { DetectedElement, Rect, Settings, SliceResult, UiElement } from '../types';
import type { LayoutNode } from '../types';
import { markOcclusion } from './geometry';
import { canvasToDataUrl } from './image';
import { refineRect, sliceElement } from './key';
import { buildFileName, deriveName } from './naming';
import { detectElements, fitToBox, generateCleanPlate } from './magpie';

export type Stage = 'idle' | 'detect' | 'slice' | 'plate' | 'done' | 'error';

export type Progress = {
  stage: Stage;
  done: number;
  total: number;
  message: string;
};

function makeId(label: string, index: number): string {
  return `el-${index}-${label.replace(/[^A-Za-z0-9]/g, '')}`;
}

/**
 * Stage 1: vision model returns the element list. Occlusion is computed here because
 * it decides which elements will need the (slow, paid) repaint path later.
 */
export async function analyze(
  settings: Settings,
  source: { dataUrl: string; width: number; height: number },
): Promise<DetectedElement[]> {
  return detectElements({
    model: settings.visionModel,
    dataUrl: source.dataUrl,
    width: source.width,
    height: source.height,
  });
}

/**
 * Model-free alternative to `analyze`: the wireframe the user already tuned is itself
 * a list of boxes with names. Quotas run out, and a hand-tuned box is often better than
 * a guessed one, so slicing straight from it must stay possible.
 */
export function analyzeFromLayout(
  layout: LayoutNode[],
  source: { width: number; height: number },
  settings: Settings,
): UiElement[] {
  const detected: DetectedElement[] = layout.map((node, index) => ({
    label: node.name,
    kind: layoutKindToElementKind(node.kind),
    rect: {
      x: Math.round(node.rect.x * source.width),
      y: Math.round(node.rect.y * source.height),
      w: Math.round(node.rect.w * source.width),
      h: Math.round(node.rect.h * source.height),
    },
    // Wireframe order is paint order: later nodes sit on top.
    layer: index,
    description: node.text ?? node.name,
    text: node.kind === 'text' ? (node.text ?? node.name) : undefined,
  }));

  return toUiElements(detected, settings);
}

function layoutKindToElementKind(kind: LayoutNode['kind']): DetectedElement['kind'] {
  if (kind === 'image') return 'frame';
  if (kind === 'container') return 'decor';
  return kind;
}

export function toUiElements(detected: DetectedElement[], settings: Settings): UiElement[] {
  const occlusion = markOcclusion(detected);
  const usedNames = new Set<string>();

  return occlusion.map((entry, index) => {
    const { objectName: baseObjectName, state } = deriveName(entry.element.label, entry.element.kind);
    let objectName = baseObjectName;
    let suffix = 2;
    while (usedNames.has(buildFileName(settings.module, objectName, state).toLowerCase())) {
      objectName = `${baseObjectName}${String(suffix).padStart(2, '0')}`;
      suffix++;
    }
    usedNames.add(buildFileName(settings.module, objectName, state).toLowerCase());

    const isText = entry.element.kind === 'text';

    return {
      id: makeId(entry.element.label, index),
      rect: entry.element.rect,
      kind: entry.element.kind,
      label: entry.element.label,
      description: entry.element.description,
      objectName,
      state,
      text: entry.element.text,
      layer: entry.element.layer,
      occluded: entry.occluded,
      // Text should become an in-engine TMP node, so it never needs a repaint.
      needsAi: entry.occluded && !isText,
      approved: !isText || settings.includeTextAsImage,
      slice: undefined,
    } satisfies UiElement;
  });
}

/**
 * Stage 2: cut every element with colour keying. The bbox from the model is refined
 * against the real pixels first, which is what makes vision coordinates usable.
 */
export function sliceAll(
  elements: UiElement[],
  sourceData: ImageData,
  settings: Settings,
  onProgress: (p: Progress) => void,
): UiElement[] {
  const total = elements.length;

  return elements.map((element, index): UiElement => {
    const refined = refineRect(sourceData, element.rect);
    const slice: SliceResult = sliceElement(sourceData, refined.rect, {
      tolerance: settings.tolerance,
      softness: settings.softness,
      hardEdge: settings.hardEdge,
      fringeFix: settings.fringeFix,
    });

    onProgress({
      stage: 'slice',
      done: index + 1,
      total,
      message: `正在切图 ${element.label}`,
    });

    return {
      ...element,
      rect: refined.rect,
      slice,
      extractionMethod: 'color-key',
      repainted: false,
    };
  });
}

export type PlateOutcome = { id: string; ok: boolean; error?: string };

/**
 * Stage 3: repaint only the elements that are actually covered. Magpie's image model
 * returns a transparent background natively, so the result needs no colour keying at
 * all - it is simply scaled back into the element's original pixel box.
 */
export async function plateOccluded(
  elements: UiElement[],
  source: { dataUrl: string },
  onProgress: (p: Progress) => void,
): Promise<{ outcomes: PlateOutcome[]; updated: UiElement[] }> {
  const targets = elements.filter((e) => e.needsAi && e.approved);
  const outcomes: PlateOutcome[] = [];
  const patched = new Map<string, SliceResult>();

  let done = 0;
  for (const element of targets) {
    try {
      const url = await generateCleanPlate({
        element: {
          label: element.label,
          kind: element.kind,
          rect: element.rect,
          layer: element.layer,
          description: element.description || element.label,
        },
        referenceDataUrl: source.dataUrl,
      });

      const fitted = await fitToBox(url, element.rect.w, element.rect.h);
      patched.set(element.id, await sliceFromDataUrl(fitted, element.rect));
      outcomes.push({ id: element.id, ok: true });
    } catch (error) {
      outcomes.push({
        id: element.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    done++;
    onProgress({
      stage: 'plate',
      done,
      total: targets.length,
      message: `正在补图 ${element.label}`,
    });
  }

  const updated = elements.map((element): UiElement => {
    const plate = patched.get(element.id);
    if (!plate) return element;
    return {
      ...element,
      slice: plate,
      extractionMethod: 'repaint',
      repainted: true,
    };
  });

  return { outcomes, updated };
}

/** Builds a SliceResult from an RGBA data URL, so plate output matches keyed output. */
async function sliceFromDataUrl(dataUrl: string, rect: Rect): Promise<SliceResult> {
  if (!Number.isInteger(rect.w) || !Number.isInteger(rect.h) || rect.w <= 0 || rect.h <= 0) {
    throw new Error('补图尺寸必须是正整数');
  }
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = rect.w;
  canvas.height = rect.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.drawImage(image, 0, 0, rect.w, rect.h);

  return {
    width: rect.w,
    height: rect.h,
    canvas,
    // A generated plate has no meaningful "did the box land on art" signal, and
    // claiming a clean edge here would be a false all-clear in the review list.
    border: {
      bgColor: [0, 0, 0],
      sideScore: { top: 0, right: 0, bottom: 0, left: 0 },
      dirtySides: [],
    },
  };
}

export function sliceToDataUrl(slice: SliceResult): string {
  return canvasToDataUrl(slice.canvas);
}
