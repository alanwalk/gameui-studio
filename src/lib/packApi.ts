import type { PackInput, PackStyle, PackTask } from './packTypes';

async function request<T>(path = '', body?: unknown): Promise<T> {
  const options = body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await fetch(`/api/reskin-tasks${path}`, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `换肤请求失败 ${response.status}`);
  return payload as T;
}
export const listPackTasks = () => request<PackTask[]>();
export const getPackTask = (id: string) => request<PackTask>(`/${encodeURIComponent(id)}`);
export const createPackTask = (name: string, items: PackInput[], style: PackStyle, sourceTaskId?: string) =>
  request<PackTask>('', { name, items, style, sourceTaskId });
export const startPackTask = (id: string, itemIds?: string[], confirmRegenerate = false) =>
  request<PackTask>(`/${encodeURIComponent(id)}/run`, { itemIds, confirmRegenerate });
export const packImageUrl = (name: string) => `/api/reskin-images/${encodeURIComponent(name)}`;
