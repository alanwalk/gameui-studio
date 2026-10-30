import type { UiElement } from '../types';

/** Atlas export keeps source pixels; the editor's visual layout may scale thumbnails. */
export function createSliceAtlas(elements: UiElement[]): HTMLCanvasElement {
  const assets = elements.filter(element => element.approved && element.slice);
  if (!assets.length) throw new Error('没有可导出的素材');
  const gap = 16;
  const area = assets.reduce((sum, element) => sum + (element.slice!.width + gap) * (element.slice!.height + gap), 0);
  const widest = Math.max(...assets.map(element => element.slice!.width));
  const width = Math.max(widest + gap * 2, Math.ceil(Math.sqrt(area)) + gap * 2);
  let x = gap;
  let y = gap;
  let rowHeight = 0;
  const placements = assets.map(element => {
    const slice = element.slice!;
    if (x + slice.width + gap > width) {
      x = gap;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    const placement = {slice, x, y};
    x += slice.width + gap;
    rowHeight = Math.max(rowHeight, slice.height);
    return placement;
  });
  const height = y + rowHeight + gap;
  if (width * height > 40_000_000 || width > 32767 || height > 32767) throw new Error('图集超过导出尺寸限制，请下载素材 ZIP');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建图集画布');
  for (const placement of placements) context.drawImage(placement.slice.canvas, placement.x, placement.y);
  return canvas;
}
