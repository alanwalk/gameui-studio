import type { DrawingImage, DrawingInput, DrawingState } from './drawingTypes';

async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `画图请求失败 (${response.status})`);
  return result as T;
}

export const drawingImageUrl = (id: string, download = false): string => `/api/drawing/images/${encodeURIComponent(id)}${download ? '?download=1' : ''}`;
export const loadDrawingState = (): Promise<DrawingState> => request('/api/drawing/state');
export const createDrawing = (input: DrawingInput): Promise<DrawingState> => request('/api/drawing/tasks', input);
export const resumeDrawing = (id: string): Promise<DrawingState> => request(`/api/drawing/tasks/${encodeURIComponent(id)}/resume`, {});
export const retryDrawing = (id: string): Promise<DrawingState> => request(`/api/drawing/tasks/${encodeURIComponent(id)}/retry`, { confirmNewCharge: true });

export async function uploadDrawingReference(file: File): Promise<DrawingImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('请上传 20 MB 以内的 PNG、JPEG 或 WebP 图片');
  const bitmap = await createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > 40_000_000) throw new Error('参考图不能超过 4000 万像素');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法解码图片');
    context.drawImage(bitmap, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > Math.ceil(20 * 1024 * 1024 * 4 / 3) + 100) throw new Error('解码后的图片超过 20 MB，请缩小图片后上传');
    return request('/api/drawing/images', { name: file.name.slice(0, 200), dataUrl });
  } finally {
    bitmap.close();
  }
}
