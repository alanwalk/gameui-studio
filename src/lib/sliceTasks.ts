import { useCallback, useEffect, useRef, useState } from 'react';
import type { SliceTask, SliceTaskSource, StoredSliceElement, UiElement } from '../types';
import { imageUrl } from './magpie';
import { plateOccluded } from './pipeline';
import { createUuid } from './uuid';

export type SliceSourceImage = { dataUrl: string; width: number; height: number };

export function sourceKey(source: SliceTaskSource | null): string {
  if (!source) return '';
  if (source.kind === 'standalone') return JSON.stringify(['standalone', source.sourceImage]);
  return JSON.stringify(['project', source.projectId, source.screenId, source.versionId, source.sourceImage]);
}
export function newSliceTask(source: SliceTaskSource, name: string, width: number, height: number): SliceTask {
  const now = Date.now();
  return { schemaVersion: 1, id: createUuid(), name, source, width, height, elements: [], status: 'idle', createdAt: now, updatedAt: now };
}
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `请求失败 ${response.status}`);
  return payload as T;
}
export async function uploadSliceImage(dataUrl: string): Promise<string> {
  const result = await request<{ fileName: string }>('/api/upload', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, prefix: 'slice' }),
  });
  return result.fileName;
}
export async function loadSliceSource(task: SliceTask): Promise<SliceSourceImage> {
  const image = new Image();
  image.src = imageUrl(task.source.sourceImage);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = task.width;
  canvas.height = task.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建素材画布');
  context.drawImage(image, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), width: task.width, height: task.height };
}
// Immutable Canvas contract: clone before editing pixels; metadata edits reuse the PNG reference.
const imageFiles = new WeakMap<HTMLCanvasElement, string>();
export async function encodeElements(elements: UiElement[]): Promise<StoredSliceElement[]> {
  return Promise.all(elements.map(async (element) => {
    const { slice, ...metadata } = element;
    if (!slice) return metadata;
    let image = imageFiles.get(slice.canvas);
    if (!image) {
      image = await uploadSliceImage(slice.canvas.toDataURL('image/png'));
      imageFiles.set(slice.canvas, image);
    }
    return { ...metadata, slice: { width: slice.width, height: slice.height, border: slice.border, image } };
  }));
}
export async function decodeElements(elements: StoredSliceElement[]): Promise<UiElement[]> {
  return Promise.all(elements.map(async (element) => {
    const { slice, ...metadata } = element;
    const restored: UiElement = { ...metadata };
    if (restored.processingStatus === 'running') restored.processingStatus = 'interrupted';
    if (!slice) return restored;
    const image = new Image();
    image.src = imageUrl(slice.image);
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = slice.width;
    canvas.height = slice.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法恢复素材画布');
    context.drawImage(image, 0, 0);
    imageFiles.set(canvas, slice.image);
    return { ...restored, slice: { width: slice.width, height: slice.height, border: slice.border, canvas } };
  }));
}

// Serialize before uploading too: a slow older upload must not overwrite a later edit.
let saveQueue: Promise<unknown> = Promise.resolve();
export function persistSliceTask(task: SliceTask, elements: UiElement[]): Promise<SliceTask> {
  const operation = saveQueue.then(async () => {
    const stored = { ...task, elements: await encodeElements(elements), updatedAt: Date.now() };
    const result = await request<{ tasks: SliceTask[] }>('/api/slice-tasks', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: stored }),
    });
    return result.tasks.find((entry) => entry.id === task.id)!;
  });
  saveQueue = operation.catch(() => undefined);
  return operation;
}
const repaintingTasks = new Set<string>();

function completedTaskStatus(elements: UiElement[]): SliceTask['status'] {
  const unfinished = elements.some((element) => element.processingStatus === 'failed' ||
    element.processingStatus === 'interrupted' || element.processingStatus === 'running' || element.processingStatus === 'pending');
  return unfinished ? 'interrupted' : 'done';
}

/** Persist each completed repaint before starting the next paid request. */
export async function repaintTask(
  session: Pick<SliceTaskSession, 'save' | 'isCurrent' | 'assertCanProcess'>,
  task: SliceTask,
  elements: UiElement[],
  source: SliceSourceImage,
  onProgress: (message: string) => void,
): Promise<void> {
  session.assertCanProcess();
  if (repaintingTasks.has(task.id)) throw new Error('此任务正在补图，请勿重复启动');
  repaintingTasks.add(task.id);
  try {
    let current = elements;
    const targets = elements.filter((element) => element.needsAi && element.kind !== 'text' && !element.repainted);
    for (const element of targets) {
      current = current.map((entry) => entry.id === element.id ? { ...entry, processingStatus: 'running', processingError: undefined } : entry);
      await session.save({ ...task, status: 'running' }, current, true);
      const { outcomes, updated } = await plateOccluded([element], source, (progress) => {
        if (session.isCurrent(task.source)) onProgress(progress.message);
      });
      const outcome = outcomes[0];
      current = current.map((entry) => {
        if (entry.id !== element.id) return entry;
        if (outcome?.ok) return { ...updated[0], extractionMethod: 'repaint', repainted: true, processingStatus: 'done', processingError: undefined };
        return { ...entry, processingStatus: 'failed', processingError: outcome?.error ?? '补图失败' };
      });
      await session.save({ ...task, status: completedTaskStatus(current) }, current, true);
    }
  } finally {
    repaintingTasks.delete(task.id);
  }
}

export function useSliceTasks(source: SliceTaskSource | null) {
  const [tasks, setTasks] = useState<SliceTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const [error, setError] = useState<string | null>(null);
  type Runtime = { key: string; elements: UiElement[]; source: SliceSourceImage };
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const runtimeRef = useRef<Runtime | null>(null);
  const revisions = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, { task: SliceTask; elements: UiElement[] }>());
  const [hasUnsaved, setHasUnsaved] = useState(false);
  const requestId = useRef(0);
  const key = sourceKey(source);
  const activeKey = useRef(key);
  activeKey.current = key;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const publish = (next: Runtime | null) => { runtimeRef.current = next; setRuntime(next); };
  const reload = useCallback(async () => {
    const id = ++requestId.current;
    const before = new Map(revisions.current);
    try {
      const result = await request<{ tasks: SliceTask[] }>('/api/slice-tasks');
      if (!mounted.current || id !== requestId.current) return;
      setTasks((current) => {
        const merged = new Map(current.map((task) => [task.id, task]));
        for (const task of result.tasks) {
          // A GET started before an edit/save has no authority over that task.
          if (revisions.current.has(task.id) || (revisions.current.get(task.id) ?? 0) !== (before.get(task.id) ?? 0)) continue;
          merged.set(task.id, { ...task, status: task.status === 'running' ? 'interrupted' : task.status });
        }
        return [...merged.values()];
      });
      setLoaded(true);
      setRestoreEpoch((current) => current + 1);
    } catch (reason) {
      if (mounted.current && id === requestId.current) setError(`加载素材任务失败：${String(reason)}`);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const task = tasks.find((entry) => sourceKey(entry.source) === key) ?? null;
  const taskId = task?.id;
  useEffect(() => {
    let cancelled = false;
    if (!task) { publish(null); return; }
    const unsaved = pending.current.get(task.id);
    const visible = runtimeRef.current;
    if (visible?.key === key && revisions.current.has(task.id) && (!unsaved || visible.elements === unsaved.elements)) return;
    if (visible?.key !== key) publish(null);
    const revision = revisions.current.get(task.id) ?? 0;
    const restoredElements = unsaved ? Promise.resolve(unsaved.elements) : decodeElements(task.elements);
    void Promise.all([restoredElements, loadSliceSource(task)]).then(([elements, image]) => {
      if (!cancelled && activeKey.current === key && revision === (revisions.current.get(task.id) ?? 0)) {
        publish({ key, elements, source: image });
      }
    }).catch((reason) => {
      if (!cancelled) setError(`恢复素材任务失败：${String(reason)}`);
    });
    return () => { cancelled = true; };
    // Saved metadata must never reconstruct an editor's current canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, key, restoreEpoch]);
  const save = useCallback(async (target: SliceTask, elements: UiElement[], publishBeforeSave = false) => {
    const revision = (revisions.current.get(target.id) ?? 0) + 1;
    revisions.current.set(target.id, revision);
    pending.current.set(target.id, { task: target, elements });
    // First-save failure must still leave a task that can restore its pending Canvas.
    setTasks((current) => [...current.filter((entry) => entry.id !== target.id), target]);
    setRestoreEpoch((current) => current + 1);
    setHasUnsaved(true);
    const targetKey = sourceKey(target.source);
    const visible = runtimeRef.current;
    if (publishBeforeSave && visible?.key === targetKey && activeKey.current === targetKey) {
      publish({ ...visible, elements });
    }
    try {
      const saved = await persistSliceTask(target, elements);
      if (!mounted.current || revisions.current.get(target.id) !== revision) return saved;
      setTasks((current) => [...current.filter((entry) => entry.id !== saved.id), saved]);
      const savedKey = sourceKey(saved.source);
      if (activeKey.current === savedKey) {
        let image = runtimeRef.current?.key === savedKey ? runtimeRef.current.source : null;
        if (!image) image = await loadSliceSource(saved);
        if (mounted.current && activeKey.current === savedKey && revisions.current.get(target.id) === revision) {
          publish({ key: savedKey, elements, source: image });
        }
      }
      if (revisions.current.get(target.id) === revision) pending.current.delete(target.id);
      setHasUnsaved(pending.current.size > 0);
      if (pending.current.size === 0) setError(null);
      return saved;
    } catch (reason) {
      if (mounted.current && revisions.current.get(target.id) === revision) setError(`保存失败，原有落盘结果仍保留：${String(reason)}`);
      throw reason;
    }
  }, []);
  const retrySave = async () => {
    for (const id of [...pending.current.keys()]) {
      const snapshot = pending.current.get(id);
      if (snapshot) await save(snapshot.task, snapshot.elements, true);
    }
  };
  const removeTask = async (id: string) => {
    if (pending.current.size || extractingTasks.has(id) || repaintingTasks.has(id)) throw new Error('请等待任务处理和保存完成后再删除');
    const selected = tasks.find(entry => entry.id === id);
    if (!selected || selected.source.kind !== 'standalone') throw new Error('独立切图任务不存在');
    await saveQueue;
    const result = await request<{tasks: SliceTask[]}>('/api/slice-tasks', {
      method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({id}),
    });
    ++requestId.current;
    revisions.current.delete(id);
    setTasks(result.tasks);
    if (activeKey.current === sourceKey(selected.source)) publish(null);
  };
  const assertCanProcess = () => {
    if (pending.current.size > 0) throw new Error('素材尚未保存，请先重试保存，再开始新的处理');
  };
  const changeElements = (elements: UiElement[]) => {
    if (!task || !loaded) return;
    const current = runtimeRef.current;
    if (current?.key === key) publish({ ...current, elements });
    void save(task, elements).catch(() => undefined);
  };
  return {
    tasks, task, loaded, error, reload, save, changeElements, hasUnsaved, retrySave, removeTask, assertCanProcess,
    elements: runtime?.key === key ? runtime.elements : null,
    source: runtime?.key === key ? runtime.source : null,
    isCurrent: (target: SliceTaskSource) => mounted.current && activeKey.current === sourceKey(target),
  };
}
export type SliceTaskSession = ReturnType<typeof useSliceTasks>;

const extractingTasks = new Set<string>();

/** Keep the captured task owner; a failed save stops the run before another model request. */
export async function extractSliceTask(
  session: Pick<SliceTaskSession, 'save' | 'isCurrent' | 'assertCanProcess'>,
  task: SliceTask,
  elements: UiElement[],
  source: SliceSourceImage,
  settings: import('../types').Settings,
  onProgress: (message: string) => void,
  method: 'segmentation' | 'color-key' = 'segmentation',
  redetect = false,
): Promise<void> {
  session.assertCanProcess();
  if (extractingTasks.has(task.id)) throw new Error('此任务正在提取，请勿重复启动');
  extractingTasks.add(task.id);
  try {
    // Probe once per batch, never once per element (the probe imports the CPU runtime).
    if (method === 'segmentation') {
      const response = await fetch('/api/segment-health');
      const health = await response.json();
      if (!response.ok || health.available !== true) {
        throw new Error(`精准分割不可用：${health.error || health.status || '本地 runtime 未就绪'}`);
      }
    }
    const { analyze, toUiElements, sliceAll } = await import('./pipeline');
    const { segmentElement } = await import('./segmentation');
    let current = [...elements];
    if (!current.length || redetect) {
      if (session.isCurrent(task.source)) onProgress('正在识别原图 UI 元素框…');
      const detected = await analyze(settings, source);
      const identified = toUiElements(detected, { ...settings, includeTextAsImage: false });
      // Detector IDs depend on labels/order. Match the original regions and keep user-owned data.
      const matched = new Set<string>();
      for (const element of identified) {
        let match: UiElement | undefined;
        let bestOverlap = 0.8;
        for (const existing of current) {
          if (matched.has(existing.id) || existing.kind !== element.kind || existing.state !== element.state) continue;
          const a = existing.rect;
          const b = element.rect;
          const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
          const intersection = width * height;
          const overlap = intersection / (a.w * a.h + b.w * b.h - intersection);
          if (overlap >= bestOverlap) {
            match = existing;
            bestOverlap = overlap;
          }
        }
        if (match) {
          matched.add(match.id);
          continue;
        }
        const id = current.some((existing) => existing.id === element.id) ? createUuid() : element.id;
        current.push({ ...element, id });
        matched.add(id);
      }
    }
    let sourceData: ImageData | undefined;
    if (method === 'color-key') {
      const image = new Image();
      image.src = source.dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('无法创建色键画布');
      context.drawImage(image, 0, 0);
      sourceData = context.getImageData(0, 0, source.width, source.height);
    }
    const targets = current.filter((element) => {
      if (element.kind === 'text' && !element.approved) return false;
      if (element.slice && (element.extractionMethod === 'manual' || element.extractionMethod === 'repaint' ||
          element.extractionMethod === 'ai-sheet' || element.repainted)) return false;
      if (element.processingStatus === 'failed' || element.processingStatus === 'interrupted') return true;
      if (!element.slice) return true;
      return element.extractionMethod !== method && element.extractionMethod !== 'manual' &&
        element.extractionMethod !== 'repaint' && element.extractionMethod !== 'ai-sheet';
    });
    for (const [index, element] of targets.entries()) {
      if (session.isCurrent(task.source)) onProgress(`正在提取 ${index + 1}/${targets.length}：${element.label}`);
      let result: UiElement;
      try {
        let extracted: UiElement;
        if (method === 'segmentation') {
          extracted = await segmentElement(task.source.sourceImage, element);
        } else {
          [extracted] = sliceAll([element], sourceData!, settings, () => {});
        }
        result = { ...extracted, processingStatus: 'done', processingError: undefined };
      } catch (reason) {
        result = { ...element, processingStatus: 'failed', processingError: reason instanceof Error ? reason.message : String(reason) };
      }
      current = current.map((entry) => entry.id === element.id ? result : entry);
      // Outside the model catch: never turn a failed save into a model failure or lose its PNG.
      const status = index === targets.length - 1 ? completedTaskStatus(current) : 'running';
      await session.save({ ...task, status }, current, true);
    }
    if (!targets.length) await session.save({ ...task, status: completedTaskStatus(current) }, current, true);
    if (session.isCurrent(task.source)) {
      const failures = current.filter((element) => element.processingStatus === 'failed').length;
      onProgress(`批量提取完成：${current.filter((element) => element.slice).length} 项有产物，${failures} 项失败；再次分析可重试未完成项`);
    }
  } finally {
    extractingTasks.delete(task.id);
  }
}
