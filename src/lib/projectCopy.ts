import type { Project, SliceTask } from '../types';

export type ProjectCopyResult = {
  project: Project;
  tasks: SliceTask[];
  screenId?: string;
};

async function requestCopy(endpoint: string, body: object): Promise<ProjectCopyResult> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `复制失败 (${response.status})`);
  return result;
}

/** Duplicate only the persisted source; callers must save pending edits first. */
export function copyProject(projectId: string, newId?: string): Promise<ProjectCopyResult> {
  return requestCopy('/api/projects/copy', { projectId, newId });
}

export function copyScreen(projectId: string, screenId: string, newId?: string): Promise<ProjectCopyResult> {
  return requestCopy('/api/screens/copy', { projectId, screenId, newId });
}
