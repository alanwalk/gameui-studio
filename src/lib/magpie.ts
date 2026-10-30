import type {
  DetectedElement,
  ElementKind,
  LayoutKind,
  LayoutNode,
  Project,
  Rect,
  Style,
  TextPolicy,
} from '../types';
import { kindLabel } from './layout';
import { buildAssetRepairPrompt } from './assetPrompts';
import { analyzeAlphaSheetPixels } from './alphaComponents';

/**
 * Magpie-backed model access. Every call goes to the dev server's /api/* middleware,
 * which is the only thing that talks to Magpie. No key is stored or sent from here.
 */

const KINDS: ElementKind[] = [
  'panel',
  'button',
  'icon',
  'text',
  'progress',
  'frame',
  'decor',
];

const LAYOUT_KINDS: LayoutKind[] = [
  'container',
  'panel',
  'button',
  'icon',
  'text',
  'image',
  'progress',
];

/**
 * Lives on the client because it is part of the product, but is SENT to the server on
 * each detect call so the prompt and its parsing rules can never drift apart.
 */
export const SYSTEM_PROMPT = `You are a game UI asset analyst. Given a game UI screenshot, list every REUSABLE visual asset a developer would need to rebuild this screen in a game engine.

Rules:
- Return ONLY valid JSON. No markdown fences, no commentary.
- Schema: {"elements": [{"label": string, "kind": string, "x": number, "y": number, "w": number, "h": number, "layer": number, "description": string, "text": string|null, "textPolicy": "separate"|"preserve"}]}
- kind must be one of: ${KINDS.join(', ')}.
- Coordinates are in ORIGINAL image pixels, integers, relative to the top-left corner.
- Include the complete visible silhouette, thin outlines, detached decorations and intentional shadows. The box identifies the target; later segmentation determines the final pixel bounds.
- "layer": 0 is the bottom-most background. Larger numbers sit on top. Use this to record what visually covers what.
- "label": short English describing the element, e.g. "ConfirmButton", "WoodPanel", "CoinIcon". Never use words like New, Old, Final, Copy, Temp.
- "description": one English sentence describing the art, used later to regenerate it. Be specific about shape, material, colour and style.
- "text": for kind "text", the exact readable string. Otherwise null.
- "textPolicy": use "separate" for dynamic numbers, levels, counters and UI labels, and "preserve" only for intentional lettering that is part of the artwork.

Coverage rules - these matter most:
- Exclude OS mouse pointers and transient cursor overlays; they are not reusable UI assets.
- Exclude rendered gameplay worlds (terrain, maps, simulation scenes) as background assets. Do not treat the whole screenshot, including its overlaid UI, as one background image.
- Include distinct reusable static decorative backgrounds, character illustrations, and panel art layers when visible, even if they span the screen. Keep their bounds on the art layer, not the combined screen and UI.
- Separate each state of a control into its own element when the screenshot shows them side by side.
- For text: report the text band itself. Developers will render text in-engine, so keep the box on the glyphs.
- Decompose composite controls into their reusable blank base, icon, button, progress track/fill and text layers. Do not treat a notification dot or neighboring illustration fragment as part of the base.
- Do NOT invent elements that are not visible. Do NOT merge unrelated elements into one box.
 - Aim for completeness over brevity: 15-40 elements is normal for a full screen.`;

/** Asks the model for a starting wireframe from a plain description of the screen. */
export const LAYOUT_PROMPT = `You plan game UI layouts. Given a description of one game screen, return the wireframe as a flat list of blocks.

Rules:
- Return ONLY valid JSON: {"nodes": [{"name": string, "kind": string, "x": number, "y": number, "w": number, "h": number, "text": string|null}]}
- kind must be one of: ${LAYOUT_KINDS.join(', ')}.
- x, y, w, h are FRACTIONS of the screen from 0 to 1. A full-width panel is w:1.
- Order nodes back-to-front, so later nodes draw on top of earlier ones.
- "name": a short, descriptive Simplified Chinese node name, e.g. "货币栏", "确认按钮", "聊天面板". Do not use English identifiers or PascalCase names.
- "text": for kind "text", the label or value the player would read. Otherwise null.
- Use container for grouping boxes, image for art placeholders, icon for small glyphs.
- Cover the whole screen: a game screen needs a background container, HUD, main content and buttons.
- Emit 8-30 nodes. Do not overlap boxes that should not overlap.`;

function coerceNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function coerceKind(value: unknown): ElementKind {
  const raw = String(value ?? '').toLowerCase();
  return KINDS.includes(raw as ElementKind) ? (raw as ElementKind) : 'decor';
}

function coerceLayoutKind(value: unknown): LayoutKind {
  const raw = String(value ?? '').toLowerCase();
  return LAYOUT_KINDS.includes(raw as LayoutKind) ? (raw as LayoutKind) : 'container';
}

/** Keeps a normalized rect on screen and at least a few percent big. */
function coerceNormRect(item: Record<string, unknown>): LayoutNode['rect'] {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const x = clamp(coerceNumber(item.x));
  const y = clamp(coerceNumber(item.y));
  const w = Math.max(0.01, Math.min(1 - x, coerceNumber(item.w, 0.2)));
  const h = Math.max(0.01, Math.min(1 - y, coerceNumber(item.h, 0.1)));
  return { x, y, w, h };
}

function parseLayoutNodes(content: string): LayoutNode[] {
  const parsed = JSON.parse(content) as { nodes?: unknown };
  if (!Array.isArray(parsed.nodes)) {
    throw new Error('模型返回中缺少 nodes 数组');
  }

  const out: LayoutNode[] = [];
  for (const entry of parsed.nodes) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    const kind = coerceLayoutKind(item.kind);
    const rawName = String(item.name ?? item.label ?? '').trim();
    const name = rawName || `${kindLabel(kind)}${out.length + 1}`;
    out.push({
      id: `n-${out.length}-${name.replace(/[^A-Za-z0-9]/g, '')}`,
      name,
      kind,
      rect: coerceNormRect(item),
      text: item.text ? String(item.text) : undefined,
    });
  }

  if (out.length === 0) {
    throw new Error('模型没有给出任何布局节点');
  }
  return out;
}

function coerceRect(item: Record<string, unknown>, w: number, h: number): Rect {
  const label = String(item.label ?? item.name ?? 'unknown');
  const errorPrefix = `模型元素 "${label}"`;
  const readCoordinate = (value: unknown, field: string): number => {
    const isNumericInput = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '');
    const number = isNumericInput ? Number(value) : NaN;
    if (!Number.isFinite(number)) {
      throw new Error(`${errorPrefix} 的坐标 ${field} 缺失或无效，必须是有限数字`);
    }
    return number;
  };

  let left: number;
  let top: number;
  let right: number;
  let bottom: number;
  // Some models return [x1, y1, x2, y2] instead of x/y/w/h.
  if (item.bbox !== undefined) {
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) {
      throw new Error(`${errorPrefix} 的 bbox 必须包含 4 个坐标`);
    }
    const [x1, y1, x2, y2] = item.bbox.map((value, index) => readCoordinate(value, `bbox[${index}]`));
    left = Math.min(x1, x2);
    top = Math.min(y1, y2);
    right = Math.max(x1, x2);
    bottom = Math.max(y1, y2);
  } else {
    left = readCoordinate(item.x, 'x');
    top = readCoordinate(item.y, 'y');
    const width = readCoordinate(item.w === undefined ? item.width : item.w, 'w');
    const height = readCoordinate(item.h === undefined ? item.height : item.h, 'h');
    if (width <= 0 || height <= 0) {
      throw new Error(`${errorPrefix} 的宽高必须大于 0`);
    }
    right = left + width;
    bottom = top + height;
  }
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) {
    throw new Error(`${errorPrefix} 的坐标边界必须是有限数字`);
  }
  if (right <= left || bottom <= top) {
    throw new Error(`${errorPrefix} 的宽高必须大于 0`);
  }

  // Clip the supplied edges; missing sizes must never become the remaining screen.
  const x = Math.round(Math.max(0, Math.min(w, left)));
  const y = Math.round(Math.max(0, Math.min(h, top)));
  const clippedRight = Math.round(Math.max(0, Math.min(w, right)));
  const clippedBottom = Math.round(Math.max(0, Math.min(h, bottom)));
  if (clippedRight <= x || clippedBottom <= y) {
    throw new Error(`${errorPrefix} 的矩形在原图内没有有效像素`);
  }
  return { x, y, w: clippedRight - x, h: clippedBottom - y };
}

function parseElements(content: string, w: number, h: number): DetectedElement[] {
  const parsed = JSON.parse(content) as { elements?: unknown };
  if (!Array.isArray(parsed.elements)) {
    throw new Error('模型返回中缺少 elements 数组');
  }

  const seen = new Set<string>();
  const out: DetectedElement[] = [];

  for (const entry of parsed.elements) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;

    const rawLabel = String(item.label ?? item.name ?? '').trim();
    const kind = coerceKind(item.kind);
    const label = rawLabel || kind;

    // The model sometimes emits the same element twice; keep the first occurrence.
    const key = `${label.toLowerCase()}|${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      label,
      kind,
      rect: coerceRect(item, w, h),
      layer: Math.round(coerceNumber(item.layer)),
      description: String(item.description ?? '').trim(),
      text: item.text ? String(item.text) : undefined,
      textPolicy: item.textPolicy === 'preserve' ? 'preserve' : 'separate',
    });
  }

  if (out.length === 0) {
    throw new Error('模型未识别到任何 UI 元素');
  }
  return out.sort((a, b) => a.layer - b.layer);
}

async function postJson<T>(url: string, body: unknown, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    method: init?.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok || payload.error) {
    throw new Error(payload.error ?? `请求失败 (${response.status})`);
  }
  return payload;
}

export async function detectElements(req: {
  dataUrl: string;
  width: number;
  height: number;
  model: string;
  chineseLabels?: boolean;
}): Promise<DetectedElement[]> {
  if (!Number.isInteger(req.width) || req.width <= 0 || !Number.isInteger(req.height) || req.height <= 0) {
    throw new Error('原图宽高必须是正整数');
  }
  const payload = await postJson<{ content: string }>('/api/detect', {
    image: req.dataUrl,
    width: req.width,
    height: req.height,
    model: req.model,
    system: req.chineseLabels ? `${SYSTEM_PROMPT}\nWrite every element label in concise Simplified Chinese, not English identifiers. Keep existing visible text unchanged.` : SYSTEM_PROMPT,
  });
  return parseElements(payload.content, req.width, req.height);
}

export type MagpieHealth = {
  gateway: boolean;
  gatewayUrl: string;
  visionModel: string;
  status: string;
};

export type LayoutPlan = {
  nodes: LayoutNode[];
};

export async function fetchProjects(): Promise<Project[]> {
  const response = await fetch('/api/projects');
  const payload = (await response.json()) as { projects?: Project[]; error?: string };
  if (payload.error) throw new Error(payload.error);
  return payload.projects ?? [];
}

export async function saveProject(project: Project): Promise<Project[]> {
  const payload = await postJson<{ projects: Project[] }>(
    '/api/projects',
    { project },
    { method: 'PUT' },
  );
  return payload.projects;
}

export async function removeProject(id: string): Promise<Project[]> {
  const payload = await postJson<{ projects: Project[] }>(
    '/api/projects',
    { id },
    { method: 'DELETE' },
  );
  return payload.projects;
}

export async function fetchStyles(): Promise<Style[]> {
  const response = await fetch('/api/styles');
  const payload = (await response.json()) as { styles?: Style[]; error?: string };
  if (payload.error) throw new Error(payload.error);
  return payload.styles ?? [];
}

export async function saveStyle(style: Style): Promise<Style[]> {
  const payload = await postJson<{ styles: Style[] }>(
    '/api/styles',
    { style },
    { method: 'PUT' },
  );
  return payload.styles;
}

export async function removeStyle(id: string): Promise<Style[]> {
  const payload = await postJson<{ styles: Style[] }>(
    '/api/styles',
    { id },
    { method: 'DELETE' },
  );
  return payload.styles;
}

/** Persisted images are fetched by name; pixel data never goes into project JSON. */
export function imageUrl(fileName: string): string {
  return `/api/image?name=${encodeURIComponent(fileName)}`;
}

export type GenerateResult = { fileName: string; dataUrl: string };

export async function refineScreen(req: {
  sourceImage: string; prompt: string; styleImage?: string;
}): Promise<GenerateResult> {
  const result = await postJson<GenerateResult>('/api/refine', req);
  if (!result.fileName) throw new Error('微调未返回已保存的图片');
  return result;
}

export async function generateScreen(req: {
  prompt: string;
  wireframe: string;
  styleImage?: string;
  size?: string;
}): Promise<GenerateResult> {
  return postJson<GenerateResult>('/api/generate', {
    prompt: req.prompt,
    wireframe: req.wireframe,
    styleImage: req.styleImage,
    size: req.size,
  });
}

export async function planLayout(req: { usage: string; model: string }): Promise<LayoutNode[]> {
  const payload = await postJson<{ content: string }>('/api/layout', {
    usage: req.usage,
    model: req.model,
    system: LAYOUT_PROMPT,
  });
  return parseLayoutNodes(payload.content);
}

export async function fetchHealth(): Promise<MagpieHealth> {
  const response = await fetch('/api/health');
  return (await response.json()) as MagpieHealth;
}

export async function fetchModels(): Promise<string[]> {
  const response = await fetch('/api/models');
  const payload = (await response.json()) as { models?: string[]; error?: string };
  if (payload.error) throw new Error(payload.error);
  return payload.models ?? [];
}

/** Returns the provider's transparent PNG; fitToBox handles its foreground size. */
export async function generateCleanPlate(req: {
  element: DetectedElement;
  referenceDataUrl: string;
  contextDataUrl?: string;
  textPolicy?: TextPolicy;
}): Promise<string> {
  const prompt = buildAssetRepairPrompt(req.element, req.textPolicy ?? req.element.textPolicy ?? 'separate');

  const payload = await postJson<{ dataUrl: string }>('/api/plate', {
    prompt,
    reference: req.referenceDataUrl,
    contextReference: req.contextDataUrl,
  });

  return payload.dataUrl;
}

/** Redraws the full reference into an isolated, grid-like component sheet. */
export async function generateAiSliceSheet(req: {
  referenceDataUrl: string;
  prompt: string;
  size?: string;
}): Promise<string> {
  const payload = await postJson<{ dataUrl: string }>('/api/ai-slice-sheet', {
    reference: req.referenceDataUrl,
    prompt: req.prompt,
    size: req.size,
  });
  if (!payload.dataUrl) throw new Error('AI 拆图没有返回图片');
  return payload.dataUrl;
}

/**
 * Fits a Magpie-generated plate into the element's original pixel box. The model draws
 * at its own resolution, so the asset has to come back at the size the layout expects
 * or it will not line up with the rest of the page.
 */
export async function fitToBox(dataUrl: string, w: number, h: number): Promise<{
  dataUrl: string;
  warnings: string[];
}> {
  if (![w, h].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('补图目标尺寸无效');
  }
  const image = new Image();
  image.src = dataUrl;
  await image.decode();

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = image.naturalWidth;
  sourceCanvas.height = image.naturalHeight;
  const sourceContext = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!sourceContext) throw new Error('无法读取补图前景');
  sourceContext.drawImage(image, 0, 0);
  const pixels = sourceContext.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data;
  // Use the same support-aware ownership as sheet extraction. A distant alpha-1
  // speck must not expand the crop to a square, while attached soft tails survive.
  const { components, diagnostics } = analyzeAlphaSheetPixels(pixels, image.naturalWidth, image.naturalHeight);
  if (components.length !== 1) {
    throw new Error(`补图结果包含 ${components.length} 个独立主体，请检查后重新生成单个素材`);
  }
  const component = components[0];
  const foregroundWidth = component.rect.w;
  const foregroundHeight = component.rect.h;
  sourceCanvas.width = foregroundWidth;
  sourceCanvas.height = foregroundHeight;
  sourceContext.putImageData(new ImageData(component.rgba, foregroundWidth, foregroundHeight), 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const scale = Math.min(w / foregroundWidth, h / foregroundHeight);
  const fittedWidth = Math.max(1, Math.round(foregroundWidth * scale));
  const fittedHeight = Math.max(1, Math.round(foregroundHeight * scale));
  ctx.drawImage(sourceCanvas, Math.floor((w - fittedWidth) / 2), Math.floor((h - fittedHeight) / 2), fittedWidth, fittedHeight);
  const warnings = diagnostics.ungroupedPixelCount > 0
    ? [`补图中排除了 ${diagnostics.ungroupedComponentCount} 个孤立低透明度残片（${diagnostics.ungroupedPixelCount} 像素），请复查轮廓。`]
    : [];
  return { dataUrl: canvas.toDataURL('image/png'), warnings };
}

/**
 * Reskin one asset into a new style. Same pipeline as `generateCleanPlate` except the
 * prompt asks for a different look instead of asking to preserve the current one.
 */
export async function reskinAsset(req: {
  prompt: string;
  referenceDataUrl: string;
}): Promise<string> {
  const payload = await postJson<{ dataUrl: string }>('/api/plate', {
    prompt: req.prompt,
    reference: req.referenceDataUrl,
  });
  return payload.dataUrl;
}
