import type { Settings, UiElement } from '../types';
import { nameExportElements } from './export';

/**
 * Pack reskin: redraw every asset in a new style while the pack stays drop-in.
 *
 * The whole point of a reskin (as opposed to making new art) is that nothing else in
 * the project changes: same file names, same pixel sizes, same export paths. So the
 * plan is built once from the existing pack and every step is pinned to the original
 * dimensions - if a redraw came back at a different size it would silently break
 * every layout that imports it.
 */

export type ReskinItem = {
  elementId: string;
  /** File name in the pack; never changes. */
  fileName: string;
  /** Exact pixel size the redraw must come back at. */
  width: number;
  height: number;
  kind: string;
  label: string;
  /** Art description of the ORIGINAL asset, the seed for the redraw prompt. */
  description: string;
};

export type ReskinPlan = {
  items: ReskinItem[];
  /** Style direction applied to every asset, e.g. "冰川题材，手绘厚涂". */
  stylePrompt: string;
};

export function buildReskinPlan(elements: UiElement[], stylePrompt: string, settings?: Settings): ReskinPlan {
  const namingSettings = settings ?? { module: 'Common', includeTextAsImage: true };
  const seenIds = new Set<string>();
  const items: ReskinItem[] = nameExportElements(elements, namingSettings)
    .map(({ element, fileName }) => {
      if (seenIds.has(element.id)) throw new Error(`素材 ID 重复：${element.id}`);
      seenIds.add(element.id);
      const width = element.slice!.width;
      const height = element.slice!.height;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
        throw new Error(`换肤尺寸无效：${element.label}`);
      }
      return {
        elementId: element.id,
        // Two-argument callers historically use names without the module prefix.
        fileName: settings ? fileName : fileName.replace(/^T_UI_Common_/, ''),
        width,
        height,
        kind: element.kind,
        label: element.label,
        description: element.description || element.label,
      };
    });

  return { items, stylePrompt };
}

/**
 * The redraw prompt. It has to say both what the thing IS and how it should LOOK,
 * because the model only receives the single asset and cannot infer the new style
 * from it - the original style is exactly what is being replaced.
 */
export function buildReskinPrompt(item: ReskinItem, stylePrompt: string): string {
  const lines = [
    `Redraw this single game UI asset: ${item.label}.`,
    `What it is: ${item.description}.`,
    `New art style: ${stylePrompt}.`,
    'Keep the SAME silhouette, proportions and function - only the style changes.',
    'Transparent background outside the asset. No text, no watermark, no extra objects.',
    `Output must fit a ${item.width}x${item.height} px box with the asset centred.`,
  ];
  return lines.join(' ');
}

/**
 * A redraw that comes back a different size is a broken pack, so it is resized back
 * to the plan rather than being accepted as-is.
 */
export function assertSizeKept(plan: ReskinPlan, results: Map<string, { w: number; h: number }>): string[] {
  const wrong: string[] = [];
  for (const item of plan.items) {
    // Accept legacy filename-keyed size reports; current redraw results use element IDs.
    const got = results.get(item.elementId) ?? results.get(item.fileName);
    if (!got) continue;
    if (got.w !== item.width || got.h !== item.height) {
      wrong.push(`${item.fileName}: ${got.w}x${got.h} != ${item.width}x${item.height}`);
    }
  }
  return wrong;
}
