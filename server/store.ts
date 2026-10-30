import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Project, Screen, SliceTask } from '../src/types';

/**
 * Projects live on disk, not in localStorage: one generated screen is a multi-megabyte
 * PNG, so a handful of versions would blow the browser's ~5MB quota.
 */

const ROOT = process.env.GAMEUI_DATA ?? path.join(process.cwd(), '.data');
const IMAGES = path.join(ROOT, 'images');
const INDEX = path.join(ROOT, 'projects.json');
const STYLE_INDEX = path.join(ROOT, 'styles.json');

export type ProjectRecord = {
  id: string;
  name: string;
  stylePrompt: string;
  styleImage?: string;
  orientation: 'portrait' | 'landscape';
  size: { w: number; h: number };
  screens: unknown[];
  createdAt: number;
  updatedAt: number;
};

async function ensureDirs(): Promise<void> {
  await fs.mkdir(IMAGES, { recursive: true });
}

function imagePath(fileName: string): string {
  return path.join(IMAGES, fileName);
}

function safeFileName(fileName: string): string {
  return path.basename(fileName);
}

/** Writes a data URL as a PNG and returns the name it can be read back by. */
export async function saveImage(dataUrl: string, prefix: string): Promise<string> {
  await ensureDirs();
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.slice(comma + 1);
  const fileName = `${prefix.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await fs.writeFile(imagePath(fileName), Buffer.from(base64, 'base64'));
  return fileName;
}

export async function readImage(fileName: string): Promise<string> {
  const bytes = await fs.readFile(imagePath(safeFileName(fileName)));
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

// One queue covers the entire read/modify/write transaction, not just the final write.
let writes: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation);
  writes = result.catch(() => undefined);
  return result;
}
async function readIndex<T>(file: string): Promise<T[]> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry.id !== 'string')) {
      throw new Error(`Invalid index: ${file}`);
    }
    return value as T[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function atomicWrite(file: string, value: unknown): Promise<void> {
  await ensureDirs();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2));
    // Windows scanners/readers can briefly hold the destination open. Never delete it first.
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, file);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
function upsert<T extends { id: string; updatedAt: number }>(file: string, record: T): Promise<T[]> {
  return enqueue(async () => {
    const records = await readIndex<T>(file);
    const index = records.findIndex((entry) => entry.id === record.id);
    const stamped = { ...record, updatedAt: Date.now() };
    if (index >= 0) records[index] = stamped;
    else records.push(stamped);
    await atomicWrite(file, records);
    return records;
  });
}
function remove<T extends { id: string }>(file: string, id: string): Promise<T[]> {
  return enqueue(async () => {
    const records = await readIndex<T>(file);
    const remaining = records.filter((entry) => entry.id !== id);
    await atomicWrite(file, remaining);
    return remaining;
  });
}
export function listProjects(): Promise<ProjectRecord[]> { return readIndex(INDEX); }

export function upsertProject(project: ProjectRecord): Promise<ProjectRecord[]> { return upsert(INDEX, project); }
export function deleteProject(id: string): Promise<ProjectRecord[]> { return remove(INDEX, id); }

export type StyleRecord = {
  id: string;
  name: string;
  /** The prompt that locks the look; projects borrow it instead of retyping it. */
  prompt: string;
  /** Persisted reference image file name, when one was uploaded. */
  image?: string;
  referenceImages?: string[];
  createdAt: number;
  updatedAt: number;
};

/**
 * Styles are stored apart from projects because one style is meant to be reused by
 * many projects - that reuse is the whole reason a style library exists.
 */
export function listStyles(): Promise<StyleRecord[]> { return readIndex(STYLE_INDEX); }
export function upsertStyle(style: StyleRecord): Promise<StyleRecord[]> { return upsert(STYLE_INDEX, style); }
export function deleteStyle(id: string): Promise<StyleRecord[]> { return remove(STYLE_INDEX, id); }

export class ProjectCopyError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

/** Copies persisted metadata only. Image files are immutable shared references. */
export function copyProjectTransaction(request: {
  projectId: string;
  screenId?: string;
  newId?: string;
}): Promise<{ project: Project; tasks: SliceTask[]; screenId?: string }> {
  return enqueue(async () => {
    const projects = await readIndex<Project>(INDEX);
    const tasks = await listSliceTasks();
    const sourceProject = projects.find((project) => project.id === request.projectId);
    if (!sourceProject) throw new ProjectCopyError('源项目不存在', 404);

    const copyingScreen = request.screenId !== undefined;
    let sourceScreens = sourceProject.screens;
    if (copyingScreen) {
      const sourceScreen = sourceScreens.find((screen) => screen.id === request.screenId);
      if (!sourceScreen) throw new ProjectCopyError('源界面不存在', 404);
      sourceScreens = [sourceScreen];
    }

    const occupiedIds = new Set<string>();
    for (const project of projects) {
      occupiedIds.add(project.id);
      for (const screen of project.screens) {
        occupiedIds.add(screen.id);
        for (const node of screen.layout) occupiedIds.add(node.id);
        for (const version of screen.versions) {
          occupiedIds.add(version.id);
          if (version.parentVersionId) occupiedIds.add(version.parentVersionId);
        }
      }
    }
    for (const task of tasks) {
      occupiedIds.add(task.id);
      for (const element of task.elements) occupiedIds.add(element.id);
      if (task.source.kind === 'project') occupiedIds.add(task.source.versionId);
    }
    if (request.newId && occupiedIds.has(request.newId)) {
      throw new ProjectCopyError('目标 ID 已存在', 409);
    }
    const targetId = request.newId ?? randomUUID();
    const targetProjectId = copyingScreen ? sourceProject.id : targetId;
    const copiedScreens: Screen[] = [];
    const screenIds = new Map<string, string>();
    const versionIdsByScreen = new Map<string, Map<string, string>>();
    for (const sourceScreen of sourceScreens) {
      const copiedScreen = structuredClone(sourceScreen);
      copiedScreen.id = copyingScreen ? targetId : randomUUID();
      screenIds.set(sourceScreen.id, copiedScreen.id);
      const versionIds = new Map<string, string>();
      // Deleted parents retain a distinct dangling ID, never an ID in the source graph.
      for (const version of sourceScreen.versions) {
        if (!versionIds.has(version.id)) versionIds.set(version.id, randomUUID());
        if (version.parentVersionId && !versionIds.has(version.parentVersionId)) {
          versionIds.set(version.parentVersionId, randomUUID());
        }
      }
      if (sourceScreen.activeVersionId && !versionIds.has(sourceScreen.activeVersionId)) {
        versionIds.set(sourceScreen.activeVersionId, randomUUID());
      }
      for (const version of copiedScreen.versions) {
        version.id = versionIds.get(version.id)!;
        if (version.parentVersionId) version.parentVersionId = versionIds.get(version.parentVersionId)!;
      }
      if (copiedScreen.activeVersionId) {
        copiedScreen.activeVersionId = versionIds.get(copiedScreen.activeVersionId)!;
      }
      const nodeIds = new Map(copiedScreen.layout.map(node => [node.id, randomUUID()]));
      for (const node of copiedScreen.layout) {
        node.id = nodeIds.get(node.id)!;
        if (node.parentId) node.parentId = nodeIds.get(node.parentId) ?? null;
      }
      versionIdsByScreen.set(sourceScreen.id, versionIds);
      copiedScreens.push(copiedScreen);
    }

    const siblingNames = new Set<string>();
    let sourceName = sourceProject.name;
    if (copyingScreen) {
      for (const screen of sourceProject.screens) siblingNames.add(screen.name);
      sourceName = sourceScreens[0].name;
    } else {
      for (const project of projects) siblingNames.add(project.name);
    }
    let copyName = `${sourceName} 副本`;
    for (let suffix = 2; siblingNames.has(copyName); suffix++) copyName = `${sourceName} 副本 ${suffix}`;

    const now = Date.now();
    const targetProject = structuredClone(sourceProject);
    if (copyingScreen) {
      copiedScreens[0].name = copyName;
      targetProject.screens.push(copiedScreens[0]);
    } else {
      targetProject.id = targetProjectId;
      targetProject.name = copyName;
      targetProject.screens = copiedScreens;
      targetProject.createdAt = now;
    }
    targetProject.updatedAt = now;

    const copiedTasks: SliceTask[] = [];
    for (const sourceTask of tasks) {
      const source = sourceTask.source;
      if (source.kind !== 'project' || source.projectId !== sourceProject.id || !screenIds.has(source.screenId)) continue;
      const versionIds = versionIdsByScreen.get(source.screenId)!;
      if (!versionIds.has(source.versionId)) versionIds.set(source.versionId, randomUUID());
      const copiedTask = structuredClone(sourceTask);
      copiedTask.id = randomUUID();
      copiedTask.source = {
        ...source,
        projectId: targetProjectId,
        screenId: screenIds.get(source.screenId)!,
        versionId: versionIds.get(source.versionId)!,
      };
      copiedTask.createdAt = now;
      copiedTask.updatedAt = now;
      if (copiedTask.status === 'running') copiedTask.status = 'interrupted';
      for (const element of copiedTask.elements) {
        element.id = randomUUID();
        if (element.processingStatus === 'running') element.processingStatus = 'interrupted';
      }
      validateSliceTask(copiedTask);
      copiedTasks.push(copiedTask);
    }

    let nextProjects: Project[];
    if (copyingScreen) {
      nextProjects = projects.map((project) => project.id === sourceProject.id ? targetProject : project);
    } else {
      nextProjects = [...projects, targetProject];
    }
    if (!copiedTasks.length) {
      await atomicWrite(INDEX, nextProjects);
    } else {
      let projectWriteAttempted = false;
      try {
        await atomicWrite(TASK_INDEX, [...tasks, ...copiedTasks]);
        projectWriteAttempted = true;
        await atomicWrite(INDEX, nextProjects);
      } catch (writeError) {
        const rollbackErrors: unknown[] = [];
        if (projectWriteAttempted) {
          try { await atomicWrite(INDEX, projects); } catch (error) { rollbackErrors.push(error); }
        }
        try { await atomicWrite(TASK_INDEX, tasks); } catch (error) { rollbackErrors.push(error); }
        if (rollbackErrors.length) {
          throw new AggregateError([writeError, ...rollbackErrors], '复制写入失败且回滚未完成，请检查磁盘索引');
        }
        throw writeError;
      }
    }
    // shortcut: two JSON renames are rollback protected, not crash atomic; no cross-file journal.
    const result: { project: Project; tasks: SliceTask[]; screenId?: string } = { project: targetProject, tasks: copiedTasks };
    if (copyingScreen) result.screenId = copiedScreens[0].id;
    return result;
  });
}

const TASK_INDEX = path.join(ROOT, 'slice-tasks.json');
export async function listSliceTasks(): Promise<SliceTask[]> {
  const tasks = await readIndex<SliceTask>(TASK_INDEX);
  tasks.forEach(validateSliceTask);
  return tasks;
}
function taskSourceKey(source: SliceTask['source']): string {
  if (source.kind === 'standalone') return JSON.stringify(['standalone', source.sourceImage]);
  return JSON.stringify(['project', source.projectId, source.screenId, source.versionId, source.sourceImage]);
}
export function upsertSliceTask(task: SliceTask): Promise<SliceTask[]> {
  validateSliceTask(task);
  return enqueue(async () => {
    const tasks = await listSliceTasks();
    const index = tasks.findIndex((entry) => entry.id === task.id);
    const sameSource = tasks.find((entry) => taskSourceKey(entry.source) === taskSourceKey(task.source));
    if (sameSource && sameSource.id !== task.id) throw new Error('此来源已有素材任务，请更新已有任务');
    if (index >= 0 && taskSourceKey(tasks[index].source) !== taskSourceKey(task.source)) throw new Error('不可修改素材任务来源');
    const stamped = { ...task, updatedAt: Date.now() };
    if (index >= 0) tasks[index] = stamped;
    else tasks.push(stamped);
    await atomicWrite(TASK_INDEX, tasks);
    return tasks;
  });
}
export function removeStandaloneSliceTask(id: unknown): Promise<SliceTask[]> {
  if (typeof id !== 'string' || !id.trim()) throw new Error('缺少任务 ID');
  return enqueue(async () => {
    const tasks = await listSliceTasks();
    const target = tasks.find(task => task.id === id);
    if (target && target.source.kind !== 'standalone') throw new Error('此入口只能删除独立切图任务');
    const remaining = tasks.filter(task => task.id !== id);
    await atomicWrite(TASK_INDEX, remaining);
    return remaining;
  });
}
export function validateSliceTask(value: unknown): asserts value is SliceTask {
  const record = (entry: unknown): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry);
  const nonempty = (entry: unknown): entry is string => typeof entry === 'string' && entry.trim().length > 0;
  const positiveInteger = (entry: unknown) => Number.isSafeInteger(entry) && (entry as number) > 0;
  const nonnegativeInteger = (entry: unknown) => Number.isSafeInteger(entry) && (entry as number) >= 0;
  const finite = (entry: unknown) => typeof entry === 'number' && Number.isFinite(entry);
  const fileName = (entry: unknown) => typeof entry === 'string' && /^[A-Za-z0-9_.-]+$/.test(entry) && entry !== '.' && entry !== '..';
  const oneOf = (entry: unknown, values: string[]) => typeof entry === 'string' && values.includes(entry);
  if (!record(value) || value.schemaVersion !== 1 || !nonempty(value.id) || !nonempty(value.name) ||
      !oneOf(value.status, ['idle', 'running', 'done', 'interrupted']) ||
      !nonnegativeInteger(value.createdAt) || !nonnegativeInteger(value.updatedAt) ||
      !positiveInteger(value.width) || !positiveInteger(value.height) || !Array.isArray(value.elements)) {
    throw new Error('无效的素材任务：任务字段或尺寸不完整');
  }
  const source = value.source;
  if (!record(source) || !fileName(source.sourceImage)) throw new Error('无效的素材来源');
  if (source.kind === 'project') {
    if (![source.projectId, source.screenId, source.versionId].every(nonempty)) throw new Error('素材任务缺少项目来源');
  } else if (source.kind !== 'standalone') throw new Error('未知素材来源');

  const ids = new Set<string>();
  const sides = ['top', 'right', 'bottom', 'left'];
  for (const element of value.elements) {
    if (!record(element) || !nonempty(element.id) || ids.has(element.id) ||
        !oneOf(element.kind, ['panel', 'button', 'icon', 'text', 'progress', 'frame', 'decor']) ||
        typeof element.label !== 'string' || typeof element.description !== 'string' ||
        !nonempty(element.objectName) || typeof element.state !== 'string' || !Number.isSafeInteger(element.layer) ||
        typeof element.occluded !== 'boolean' || typeof element.needsAi !== 'boolean' || typeof element.approved !== 'boolean') {
      throw new Error('无效的素材元素：必需字段缺失、类型错误或 ID 重复');
    }
    ids.add(element.id);
    const rect = element.rect;
    if (!record(rect) || !nonnegativeInteger(rect.x) || !nonnegativeInteger(rect.y) || !positiveInteger(rect.w) || !positiveInteger(rect.h)) {
      throw new Error('无效的素材元素坐标或尺寸');
    }
    if (element.text !== undefined && typeof element.text !== 'string') throw new Error('无效的素材文本');
    if (element.extractionMethod !== undefined && !oneOf(element.extractionMethod, ['color-key', 'segmentation', 'repaint', 'manual', 'ai-sheet'])) throw new Error('无效的提取方式');
    if (element.repainted !== undefined && typeof element.repainted !== 'boolean') throw new Error('无效的重绘状态');
    if (element.processingStatus !== undefined && !oneOf(element.processingStatus, ['pending', 'running', 'done', 'failed', 'interrupted'])) throw new Error('无效的处理状态');
    if (element.processingError !== undefined && typeof element.processingError !== 'string') throw new Error('无效的处理错误');
    if (element.maskImage !== undefined && !fileName(element.maskImage)) throw new Error('无效的蒙版引用');
    if (element.slice === undefined) continue;
    const slice = element.slice;
    if (!record(slice) || !fileName(slice.image) || 'canvas' in slice || !positiveInteger(slice.width) || !positiveInteger(slice.height)) {
      throw new Error('无效的素材产物：必须使用图片文件引用及正整数尺寸');
    }
    const border = slice.border;
    if (!record(border) || !Array.isArray(border.bgColor) || border.bgColor.length !== 3 ||
        !border.bgColor.every((channel) => finite(channel) && (channel as number) >= 0 && (channel as number) <= 255) ||
        !record(border.sideScore) || !sides.every((side) => finite((border.sideScore as Record<string, unknown>)[side])) ||
        !Array.isArray(border.dirtySides) || !border.dirtySides.every((side) => oneOf(side, sides))) {
      throw new Error('无效的素材边界报告');
    }
  }
}
