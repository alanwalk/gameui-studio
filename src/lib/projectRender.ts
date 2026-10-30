import type { Project, ScreenVersion } from '../types';
import type { ProjectRenderInput, ProjectRenderTask } from './projectRenderTypes';

/** Persist this reservation BEFORE POSTing the task. Its absence is a deletion tombstone. */
export function reserveProjectRender(project: Project, input: ProjectRenderInput): Project {
  if (project.id !== input.projectId) throw new Error('生成目标项目不匹配');
  const screen = project.screens.find((entry) => entry.id === input.screenId);
  if (!screen) throw new Error('生成目标界面不存在');
  if (screen.versions.some((version) => version.id === input.id)) throw new Error('生成版本 ID 已占用');
  const version: ScreenVersion = {
    id: input.id, operation: input.operation, parentVersionId: input.sourceVersionId,
    prompt: input.prompt, styleSnapshot: structuredClone(input.styleSnapshot), createdAt: Date.now(),
  };
  const versions = [...screen.versions, version];
  const nextScreen = { ...screen, versions, activeVersionId: version.id };
  return { ...project, screens: project.screens.map((entry) => entry.id === screen.id ? nextScreen : entry) };
}

/** Call inside App's save queue against its latest project. Only the image field changes. */
export function applyProjectRender(project: Project | undefined, task: ProjectRenderTask): Project | undefined {
  if (!project || project.id !== task.projectId || task.status !== 'done' || !task.result) return;
  const screen = project.screens.find((entry) => entry.id === task.screenId);
  const version = screen?.versions.find((entry) => entry.id === task.id);
  if (!screen || !version || version.image) return;
  if (version.operation !== task.operation || version.parentVersionId !== task.sourceVersionId ||
      version.prompt !== task.prompt || JSON.stringify(version.styleSnapshot) !== JSON.stringify(task.styleSnapshot)) return;
  const versions = screen.versions.map((entry) => entry.id === task.id ? { ...entry, image: task.result } : entry);
  // Do not steal selection from edits or navigation made while the provider was running.
  const nextScreen = { ...screen, versions };
  return { ...project, screens: project.screens.map((entry) => entry.id === screen.id ? nextScreen : entry) };
}

async function request<T>(route: string, body?: unknown): Promise<T> {
  const options = body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  };
  const response = await fetch(`/api/project-render${route}`, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `生成任务请求失败 (${response.status})`);
  return result as T;
}

export const listProjectRenders = () => request<ProjectRenderTask[]>('/tasks');
export const submitProjectRender = (input: ProjectRenderInput) => request<ProjectRenderTask>('/tasks', input);
export const resumeProjectRender = (id: string) => request<ProjectRenderTask>(`/tasks/${encodeURIComponent(id)}/resume`, {});
/** Stop a queued/running task before its result is written back to the reserved version. */
export const cancelProjectRender = (id: string) => request<ProjectRenderTask>(`/tasks/${encodeURIComponent(id)}/cancel`, {});
/** Server checks persisted project before accepting ack; never ack an optimistic local update. */
export const ackProjectRender = (id: string) => request<ProjectRenderTask>(`/tasks/${encodeURIComponent(id)}/ack`, {});
export const discardProjectRender = (id: string) => request<ProjectRenderTask>(`/tasks/${encodeURIComponent(id)}/discard`, {});
export const retryProjectRender = (id: string, newId: string) => request<ProjectRenderTask>(`/tasks/${encodeURIComponent(id)}/retry`, { newId, confirmNewCharge: true });
