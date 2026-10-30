import type { DetectedElement, Rect, UiElement } from '../types';

function overlapArea(a: Rect, b: Rect): number {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const w = right - x;
  const h = bottom - y;
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}

/**
 * Overlap below this many pixels is bbox jitter, not real occlusion: vision models
 * routinely place edges a few pixels off, and those must not trigger a paid repaint.
 */
const MIN_OCCLUSION_AREA = 64;

/**
 * An element is "occluded" when something with a higher layer sits on top of ANY part
 * of it. Absolute pixel area, not a ratio: a button covering 4% of a large panel still
 * leaves a button-shaped hole in that panel, which is exactly what needs repainting.
 * These are the only elements that need a model; the rest are cut with colour keying,
 * which costs nothing and never hallucinates.
 */
export function markOcclusion(
  detected: DetectedElement[],
): Array<{ element: DetectedElement; occluded: boolean; coveredBy: string[] }> {
  const sorted = [...detected].sort((a, b) => a.layer - b.layer);

  return detected.map((element) => {
    const coveredBy: string[] = [];

    for (const other of sorted) {
      if (other === element) continue;
      if (other.layer <= element.layer) continue;
      const ov = overlapArea(element.rect, other.rect);
      if (ov < MIN_OCCLUSION_AREA) continue;
      coveredBy.push(other.label);
    }

    return { element, occluded: coveredBy.length > 0, coveredBy };
  });
}

export type NineSlice = {
  suggested: boolean;
  border: { left: number; right: number; top: number; bottom: number };
  reason: string;
};

/**
 * Suggests (never forces) nine-slice borders. Rule-based on purpose: the vision model
 * is unreliable at exact pixel insets, so this only flags a candidate and lets the
 * developer confirm. A stretchable panel is wide or tall and has quiet outer bands.
 */
export function suggestNineSlice(element: UiElement, quietEdge: boolean): NineSlice {
  const isPanel = element.kind === 'panel' || element.kind === 'frame' || element.kind === 'button';
  if (!isPanel) {
    return {
      suggested: false,
      border: { left: 0, right: 0, top: 0, bottom: 0 },
      reason: '非面板类控件不建议九宫格',
    };
  }

  const shortest = Math.min(element.rect.w, element.rect.h);
  if (shortest < 24) {
    return {
      suggested: false,
      border: { left: 0, right: 0, top: 0, bottom: 0 },
      reason: '尺寸过小，直接拉伸或原样使用',
    };
  }

  if (!quietEdge) {
    return {
      suggested: false,
      border: { left: 0, right: 0, top: 0, bottom: 0 },
      reason: '边缘存在内容，九宫格会切坏',
    };
  }

  const border = Math.max(2, Math.round(shortest * 0.25));
  const ratio = Math.max(element.rect.w, element.rect.h) / shortest;
  if (ratio < 1.6) {
    return {
      suggested: false,
      border: { left: 0, right: 0, top: 0, bottom: 0 },
      reason: '长宽接近，可能无需拉伸',
    };
  }

  return {
    suggested: true,
    border: { left: border, right: border, top: border, bottom: border },
    reason: `短边 ${shortest}px，按 25% 取 ${border}px 边框；需人工确认`,
  };
}

/**
 * Groups elements that are the same asset in different states, e.g. Normal/Pressed.
 * Same object name AND similar box size means the same control rendered twice.
 */
export function groupStates(elements: UiElement[]): Map<string, UiElement[]> {
  const groups = new Map<string, UiElement[]>();
  for (const element of elements) {
    const key = `${element.objectName}|${element.rect.w}x${element.rect.h}`;
    const list = groups.get(key) ?? [];
    list.push(element);
    groups.set(key, list);
  }
  return groups;
}
