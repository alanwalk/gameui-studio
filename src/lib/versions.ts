import type { Project, Screen, ScreenVersion } from '../types';

export function versionName(version: ScreenVersion, index: number): string {
  return version.name?.trim() || `V${index + 1}`;
}

export function versionSource(version: ScreenVersion, versions: ScreenVersion[]): string {
  let operation = '历史版本';
  if (version.operation === 'generate') operation = '线稿生成';
  if (version.operation === 'import') operation = '导入结果';
  if (version.operation === 'refine') operation = '结果微调';
  if (!version.parentVersionId) return operation;
  const index = versions.findIndex((entry) => entry.id === version.parentVersionId);
  const parent = versions[index];
  const parentName = parent ? versionName(parent, index) : `${version.parentVersionId}（已删除）`;
  return `${operation} · 来源 ${parentName}`;
}

/** Resolve the captured target against the latest state, never the currently open screen. */
export function updateVersionScreen(
  projects: Project[], projectId: string, screenId: string, update: (screen: Screen) => Screen,
): Project | undefined {
  const project = projects.find((entry) => entry.id === projectId);
  if (!project || !project.screens.some((screen) => screen.id === screenId)) return;
  return { ...project, screens: project.screens.map((screen) => screen.id === screenId ? update(screen) : screen) };
}

export function appendVersion(screen: Screen, version: ScreenVersion): Screen {
  if (!version.image) throw new Error('结果没有图片，不能保存版本');
  if (screen.versions.some((entry) => entry.id === version.id)) throw new Error('版本已存在');
  const versions = screen.versions.map((entry, index) => ({ ...entry, name: entry.name || `V${index + 1}` }));
  const highest = versions.reduce((value, entry) => {
    const number = /^V(\d+)$/.exec(entry.name);
    return Math.max(value, number ? Number(number[1]) : 0);
  }, versions.length);
  const namedVersion = { ...version, name: version.name || `V${highest + 1}` };
  return { ...screen, versions: [...versions, namedVersion], activeVersionId: version.id };
}

export function deleteVersion(screen: Screen, id: string): Screen {
  const versions = screen.versions.filter((version) => version.id !== id);
  let activeVersionId = screen.activeVersionId;
  if (!versions.some((version) => version.id === activeVersionId)) activeVersionId = versions.at(-1)?.id;
  return { ...screen, versions, activeVersionId };
}
