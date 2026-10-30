import { CliError, protocol } from './options.mjs';

export const KINDS = ['panel', 'button', 'icon', 'text', 'progress', 'frame', 'decor'];
// This is the /api/detect wire contract, not a second segmentation algorithm.
export const DETECT_PROMPT = `You are a game UI asset analyst. List visible reusable UI assets and text as strict JSON.
Schema: {"elements":[{"label":"EnglishAssetName","kind":"icon","x":0,"y":0,"w":100,"h":100,"layer":1,"description":"art description","text":null,"textPolicy":"separate"}]}
Kinds: ${KINDS.join(', ')}. Coordinates must be integer pixels in the ORIGINAL image, from its top left.
Include the entire visible silhouette, outline, shadow and detached decoration. Do not invent unseen objects.
Separate blank bases, icons, progress tracks/fills, notification dots and text into different elements.
Include reusable character illustrations and decorative panel art, but not the entire screenshot as one asset.
Exclude OS cursors and gameplay world terrain. Text bands should contain only the glyphs.
Use separate for dynamic labels/numbers, preserve only for intentional lettering belonging to the art.
Return only JSON, no Markdown. List all visible reusable assets, typically 15-40 per screen.`;

export const SHEET_PROMPT = `Reconstruct reusable game UI assets from this screen as a true RGBA transparent sprite sheet.
This is a redraw, not a screenshot crop. Keep the original visual style, silhouettes, colors and proportions.
Separate reusable blank panels, frames, buttons, currency symbols and functional icons. Remove existing UI labels,
numbers, counters, text outlines and text shadows, and reconstruct the continuous material underneath.
Preserve meaningful graphic symbols such as a plus sign. Remove notification dots and neighboring fragments.
Do not include the full scene or a large character illustration. Do not add names, watermarks or a checkerboard.
Keep every asset complete, with transparent spacing and margins; no overlap or shared shadows between assets.
Preserve smooth semi-transparent edges. Output the sheet only.`;

export function unwrap(value) {
  if (value?.ok === true && value.data) return value.data;
  if (typeof value?.content === 'string') {
    try { return JSON.parse(value.content); }
    catch { throw new CliError('模型返回 content 不是合法 JSON', 'INVALID_RESPONSE', 3); }
  }
  return value;
}

export function parseElements(raw, width, height) {
  const value = unwrap(raw);
  protocol(Array.isArray(value?.elements) && value.elements.length > 0 && value.elements.length <= 1000,
    '识别结果需包含 1–1000 个 elements');
  return value.elements.map((element, index) => {
    protocol(element && typeof element === 'object' && !Array.isArray(element), '元素必须是对象');
    const source = element.rect ?? element;
    let left = source.x;
    let top = source.y;
    let right = source.x + source.w;
    let bottom = source.y + source.h;
    if (Array.isArray(element.bbox) && element.bbox.length === 4) {
      [left, top, right, bottom] = element.bbox;
    }
    protocol([left, top, right, bottom].every(Number.isFinite) && right > left && bottom > top, `元素 ${index + 1} 的坐标无效`);
    left = Math.max(0, Math.round(left));
    top = Math.max(0, Math.round(top));
    right = Math.min(width, Math.round(right));
    bottom = Math.min(height, Math.round(bottom));
    protocol(right > left && bottom > top, `元素 ${index + 1} 不在图片内`);
    protocol(KINDS.includes(element.kind), `元素 ${index + 1} 的 kind 无效`);
    protocol(typeof element.label === 'string' && element.label.trim() && element.label.length <= 500, '元素 label 无效');
    protocol(element.layer === undefined || Number.isSafeInteger(element.layer), '元素 layer 无效');
    protocol(element.text === undefined || element.text === null || typeof element.text === 'string', '元素 text 无效');
    protocol(element.description === undefined || typeof element.description === 'string', '元素 description 无效');
    return {
      id: `cli-element-${index + 1}`, label: element.label.trim(), kind: element.kind,
      rect: { x: left, y: top, w: right - left, h: bottom - top },
      layer: element.layer ?? index, description: element.description ?? '',
      text: element.text ?? undefined, textPolicy: element.textPolicy === 'preserve' ? 'preserve' : 'separate',
    };
  }).sort((left, right) => left.layer - right.layer);
}

export function parseStyle(raw) {
  const value = unwrap(raw);
  protocol(typeof value?.name === 'string' && value.name.trim() && value.name.length <= 100,
    '画风结果缺少有效 name');
  protocol(typeof value?.prompt === 'string' && value.prompt.trim() && value.prompt.length <= 8000,
    '画风结果缺少有效 prompt');
  return { name: value.name.trim(), prompt: value.prompt.trim() };
}

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[character]);

/** Deterministic geometric wireframe; no image generation and no browser required. */
export function wireframe(elements, width, height) {
  const nodes = elements.map((element) => ({
    id: element.id, name: element.label,
    kind: element.kind === 'decor' ? 'image' : element.kind === 'frame' ? 'panel' : element.kind,
    rect: { x: element.rect.x / width, y: element.rect.y / height, w: element.rect.w / width, h: element.rect.h / height },
    text: element.text,
  }));
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="white"/>'];
  for (const [index, element] of elements.entries()) {
    const { x, y, w, h } = element.rect;
    svg.push(`<clipPath id="node-${index}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath>`);
    svg.push(`<g clip-path="url(#node-${index})">`);
    if (element.kind !== 'text') {
      svg.push(`<rect x="${x + 0.5}" y="${y + 0.5}" width="${Math.max(0, w - 1)}" height="${Math.max(0, h - 1)}" fill="white" stroke="#222"/>`);
    }
    if (['icon', 'decor'].includes(element.kind)) {
      svg.push(`<path d="M${x} ${y}L${x + w} ${y + h}M${x + w} ${y}L${x} ${y + h}" stroke="#aaa"/>`);
    }
    if (element.kind === 'progress') svg.push(`<rect x="${x + 1}" y="${y + 1}" width="${Math.max(0, w / 2 - 1)}" height="${Math.max(0, h - 2)}" fill="#aaa"/>`);
    const fontSize = Math.max(8, Math.min(24, h * 0.35, width * 0.025));
    const label = element.kind === 'text' ? element.text ?? element.label : element.label;
    svg.push(`<text x="${x + w / 2}" y="${y + h / 2}" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif" font-size="${fontSize}" fill="#222">${escapeXml(label)}</text></g>`);
  }
  svg.push('</svg>');
  return { nodes, svg: svg.join('\n') };
}
