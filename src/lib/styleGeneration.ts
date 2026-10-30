import type { DrawingState, DrawingTask } from './drawingTypes';
import { createUuid } from './uuid';

export type StyleDraft = {
  id: string;
  source?: string;
  description: string;
  referenceImages: string[];
  name?: string;
  prompt?: string;
  drawingReferences?: string[];
  pendingDrawingID?: string;
  submitted?: boolean;
  image?: string;
  error?: string;
};

export const STYLE_DRAFT_KEY = 'gameui-style-generation-v1';

export function newStyleDraft(source?: string): StyleDraft {
  return { id: createUuid(), source, description: '', referenceImages: source ? [source] : [] };
}

export function loadStyleDraft(source?: string): StyleDraft {
  try {
    const raw = localStorage.getItem(STYLE_DRAFT_KEY);
    // Validate field lengths below; JSON escaping can make a valid draft much longer.
    if (raw) {
      const value = JSON.parse(raw) as StyleDraft;
      if (typeof value.id === 'string' && /^[a-f0-9-]{36}$/.test(value.id) &&
          typeof value.description === 'string' && value.description.length <= 8000 &&
          Array.isArray(value.referenceImages) && value.referenceImages.length <= 12 &&
          value.referenceImages.every(file => typeof file === 'string' && /^[A-Za-z0-9_-]+\.png$/.test(file)) &&
          ['name', 'prompt', 'image', 'source', 'error', 'pendingDrawingID'].every(key => {
            const field = value[key as keyof StyleDraft];
            return field === undefined || (typeof field === 'string' && field.length <= 8000);
          }) &&
          (value.submitted === undefined || typeof value.submitted === 'boolean') &&
          (value.drawingReferences === undefined || (Array.isArray(value.drawingReferences) && value.drawingReferences.length <= 1 && value.drawingReferences.every(id => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)))) &&
          (!source || value.source === source)) return value;
    }
  } catch { /* Storage may be unavailable; the UI surfaces write failures. */ }
  return newStyleDraft(source);
}

export async function styleRequest<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error ?? `请求失败 (${response.status})`);
  return payload as T;
}

export async function uploadStyleReference(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error('参考图最大 20 MB');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('参考图读取失败'));
    reader.readAsDataURL(file);
  });
  const result = await styleRequest<{ fileName: string }>('/api/style-generation/reference', { dataUrl });
  return result.fileName;
}

export function stylePreviewPrompt(draft: StyleDraft): string {
  return `生成一张完整、原创的游戏美术画风预览：展示协调的游戏 UI 面板、按钮、图标和环境装饰。严格遵循下述画风，参考合集只用于视觉语言，不得输出网格拼贴或复制参考布局。\n${draft.prompt}\n[style-draft:${draft.id}]`;
}

export function findStyleDrawing(state: DrawingState, draft: StyleDraft): DrawingTask | undefined {
  if (draft.pendingDrawingID) return state.tasks.find(task => task.id === draft.pendingDrawingID);
  return state.tasks.find(task => task.prompt.includes(`[style-draft:${draft.id}]`));
}
