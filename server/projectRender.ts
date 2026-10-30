import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { Project, ScreenVersion } from '../src/types';
import type { ProjectRenderInput } from '../src/lib/projectRenderTypes';
import { decodeImage } from './imageCodec';
import { generateImage, waitForGeneration, type GeneratedAsset } from './magpieMcp';
import { listProjects, readImage, saveImage } from './store';
import { projectRenderRoot, projectRenderTransaction, publicProjectRender, readProjectRenders, type StoredProjectRender } from './projectRenderStore';

const LIMITS = { maxPixels: 40_000_000, maxBytes: 20 * 1024 * 1024 };
const ASPECT_RATIO_TOLERANCE = 0.005;
const ID = /^(?:v-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE = /^[A-Za-z0-9_-]+\.png$/;
type Provider = { generateImage: typeof generateImage; waitForGeneration: typeof waitForGeneration };

function aspectRatioMatches(actualWidth: number, actualHeight: number, targetWidth: number, targetHeight: number): boolean {
  const actualRatio = actualWidth / actualHeight;
  const targetRatio = targetWidth / targetHeight;
  return Math.abs(actualRatio - targetRatio) / targetRatio <= ASPECT_RATIO_TOLERANCE;
}

function validateInput(value: unknown): ProjectRenderInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('生成请求必须为对象');
  const input = value as ProjectRenderInput;
  const fields = ['id', 'projectId', 'screenId', 'operation', 'sourceVersionId', 'sourceImage', 'prompt', 'styleSnapshot', 'size', 'wireframe'];
  if (Object.keys(value).some((key) => !fields.includes(key))) throw new Error('不支持的生成字段');
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw new Error('生成任务 ID 无效');
  for (const field of ['projectId', 'screenId', 'prompt'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 12000) throw new Error(`生成字段 ${field} 无效`);
  }
  if (input.operation !== 'generate' && input.operation !== 'refine') throw new Error('生成操作无效');
  if (typeof input.size !== 'string' || !/^\d{1,5}x\d{1,5}$/.test(input.size)) throw new Error('生成尺寸无效');
  const [width, height] = input.size.split('x').map(Number);
  if (!width || !height || width * height > LIMITS.maxPixels) throw new Error('生成尺寸超限');
  if (input.styleSnapshot !== undefined) {
    const style = input.styleSnapshot;
    if (!style || typeof style !== 'object' || Array.isArray(style) || typeof style.prompt !== 'string' || style.prompt.length > 12000 ||
        Object.keys(style).some((key) => !['id', 'name', 'prompt', 'image'].includes(key)) ||
        [style.id, style.name].some((field) => field !== undefined && (typeof field !== 'string' || field.length > 200)) ||
        (style.image !== undefined && (typeof style.image !== 'string' || !IMAGE.test(style.image)))) throw new Error('风格快照无效');
  }
  if (input.operation === 'refine') {
    if (typeof input.sourceVersionId !== 'string' || !input.sourceVersionId ||
        typeof input.sourceImage !== 'string' || !IMAGE.test(input.sourceImage) || input.wireframe !== undefined) throw new Error('微调来源无效');
  } else {
    if (input.sourceVersionId !== undefined || input.sourceImage !== undefined || typeof input.wireframe !== 'string' ||
        input.wireframe.length > Math.ceil(LIMITS.maxBytes * 4 / 3) + 64 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.wireframe)) throw new Error('生成线稿无效');
  }
  return structuredClone(input);
}

async function targetVersion(task: { projectId: string; screenId: string; id: string }): Promise<ScreenVersion | undefined> {
  const project = (await listProjects() as Project[]).find((entry) => entry.id === task.projectId);
  return project?.screens.find((entry) => entry.id === task.screenId)?.versions.find((entry) => entry.id === task.id);
}

function unchangedReservation(version: ScreenVersion, task: ProjectRenderInput | StoredProjectRender): boolean {
  return !version.image && version.operation === task.operation && version.parentVersionId === task.sourceVersionId &&
    version.prompt === task.prompt && JSON.stringify(version.styleSnapshot) === JSON.stringify(task.styleSnapshot);
}

/** One instance per server. Paid work outlives the browser; restart only polls submitted work. */
export function createProjectRenderService(provider: Provider = { generateImage, waitForGeneration }) {
  let pumping: Promise<void> | undefined;
  let stopped = false;

  async function updateActive(id: string, change: (task: StoredProjectRender) => void): Promise<boolean> {
    let updated = false;
    await projectRenderTransaction(async (tasks) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) throw new Error('生成任务不存在');
      if (task.status === 'discarded' || task.status === 'acknowledged') return;
      change(task);
      updated = true;
    });
    return updated;
  }

  async function isActive(id: string): Promise<boolean> {
    const task = (await readProjectRenders()).find((entry) => entry.id === id);
    return !!task && task.status !== 'discarded' && task.status !== 'acknowledged';
  }

  async function execute(task: StoredProjectRender): Promise<void> {
    try {
      const version = await targetVersion(task);
      if (!version || !unchangedReservation(version, task)) {
        await updateActive(task.id, (current) => { current.status = 'discarded'; });
        return;
      }
      if (!(await updateActive(task.id, (current) => { current.status = 'running'; current.error = undefined; }))) return;
      let asset: GeneratedAsset;
      if (task.submitted) {
        if (!task.pendingId && !task.watchPath) throw new Error('提交状态未知；重新生成需要明确确认可能再次计费');
        asset = await provider.waitForGeneration({ pendingId: task.pendingId, watchPath: task.watchPath });
      } else {
        const watchPath = path.join(projectRenderRoot, task.id, 'result.png');
        // Persist the paid boundary before calling the provider, including the recoverable output path.
        if (!(await updateActive(task.id, (current) => { current.submitted = true; current.watchPath = watchPath; }))) return;
        task.submitted = true;
        task.watchPath = watchPath;
        let instructions = task.prompt;
        if (task.operation === 'refine') {
          const styleInstruction = task.styleSnapshot?.image ? 'Use the second reference as the selected visual style.' : 'Preserve the existing visual style.';
          instructions = ['Edit the first reference image, a complete game UI screen. Keep the full canvas and unchanged content.',
            styleInstruction, `Requested changes: ${task.prompt}`].join('\n');
        }
        const args: Parameters<typeof generateImage>[0] = { prompt: instructions, referenceImages: task.references, path: watchPath, size: task.size,
          quality: 'high', background: 'opaque', n: 1 };
        asset = await provider.generateImage(args);
        if (asset.pendingId) {
          task.pendingId = asset.pendingId;
          if (!(await updateActive(task.id, (current) => { current.pendingId = asset.pendingId; }))) return;
        }
        if (!asset.base64 && !asset.path && !asset.isError) {
          asset = await provider.waitForGeneration({ pendingId: task.pendingId, watchPath });
        }
      }
      if (asset.isError) throw new Error(asset.text || '项目生图失败');
      // The provider cannot be aborted once submitted. Stop before its late result is persisted.
      if (!(await isActive(task.id))) return;
      let bytes: Buffer;
      if (asset.base64) {
        if (asset.base64.length > Math.ceil(LIMITS.maxBytes * 4 / 3)) throw new Error('生成图片超过 20 MB');
        bytes = Buffer.from(asset.base64, 'base64');
      } else if (asset.path) {
        if ((await fs.stat(asset.path)).size > LIMITS.maxBytes) throw new Error('生成图片超过 20 MB');
        bytes = await fs.readFile(asset.path);
      } else throw new Error(asset.text || '生成尚未返回图片；可以继续等待已有请求');
      const decoded = await decodeImage(bytes, LIMITS);
      const [width, height] = task.size.split('x').map(Number);
      let png = decoded.png;
      if (!aspectRatioMatches(decoded.width, decoded.height, width, height)) {
        throw new Error(`生成返回图宽高比与请求画布不符（返回 ${decoded.width}×${decoded.height}，请求 ${width}×${height}）`);
      }
      if (decoded.width !== width || decoded.height !== height) png = await sharp(png).resize(width, height, { fit: 'fill' }).png().toBuffer();
      if (png.length > LIMITS.maxBytes) throw new Error('生成标准 PNG 超过 20 MB');
      // Retain a durable provider result even if saving the image/task index is interrupted.
      if (task.watchPath) await fs.writeFile(task.watchPath, png);
      const result = await saveImage(`data:image/png;base64,${png.toString('base64')}`, 'project-render');
      await updateActive(task.id, (current) => { current.result = result; current.status = 'done'; current.error = undefined; });
    } catch (error) {
      await updateActive(task.id, (current) => {
        current.status = current.submitted ? 'interrupted' : 'failed';
        current.error = `${error instanceof Error ? error.message : String(error)}`.slice(0, 1500);
        if (current.submitted) current.error += '。请求可能已计费；恢复只等待已有请求，重新生成需明确确认。';
      });
    }
  }

  function pump(): void {
    if (pumping || stopped) return;
    pumping = (async () => {
      while (!stopped) {
        const task = (await readProjectRenders()).find((entry) => entry.status === 'queued' || entry.status === 'running');
        if (!task || stopped) return;
        await execute(task);
      }
    })().catch((error) => { console.error('Project render queue:', error); }).finally(() => { pumping = undefined; });
  }

  async function submit(value: unknown) {
    const input = validateInput(value);
    const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const task = await projectRenderTransaction(async (tasks) => {
      const existing = tasks.find((entry) => entry.id === input.id);
      if (existing) {
        if (existing.digest !== digest) throw new Error('生成任务 ID 已被不同快照占用');
        return publicProjectRender(existing);
      }
      const version = await targetVersion(input);
      if (!version || !unchangedReservation(version, input)) throw new Error('请先成功保存待生成版本，再提交任务');
      const directory = path.join(projectRenderRoot, input.id);
      await fs.mkdir(directory, { recursive: true });
      const references: string[] = [];
      let primaryImage = input.wireframe;
      if (input.operation === 'refine') {
        const project = (await listProjects() as Project[]).find((entry) => entry.id === input.projectId);
        const source = project?.screens.find((entry) => entry.id === input.screenId)?.versions.find((entry) => entry.id === input.sourceVersionId);
        if (!source || source.image !== input.sourceImage) throw new Error('微调来源版本已删除或图片已变更');
        primaryImage = await readImage(input.sourceImage!);
      }
      const images = [primaryImage!];
      if (input.styleSnapshot?.image) images.push(await readImage(input.styleSnapshot.image));
      for (const [index, image] of images.entries()) {
        const decoded = await decodeImage(Buffer.from(image.slice(image.indexOf(',') + 1), 'base64'), LIMITS);
        if (index === 0 && input.size !== `${decoded.width}x${decoded.height}`) throw new Error('快照尺寸与来源图片不一致');
        const file = path.join(directory, `reference-${index}.png`);
        await fs.writeFile(file, decoded.png);
        references.push(file);
      }
      const { wireframe: _wireframe, ...snapshot } = input;
      const record: StoredProjectRender = { ...snapshot, digest, references, createdAt: version.createdAt, status: 'queued' };
      tasks.push(record);
      return publicProjectRender(record);
    });
    pump();
    return task;
  }

  async function action(id: string, action: 'resume' | 'ack' | 'discard' | 'cancel') {
    const task = await projectRenderTransaction(async (tasks) => {
      const task = tasks.find((entry) => entry.id === id);
      if (!task) throw new Error('生成任务不存在');
      if (action === 'resume') {
        if (task.status !== 'interrupted') throw new Error('只有中断任务可以恢复');
        if (!task.submitted || (!task.pendingId && !task.watchPath)) throw new Error('提交状态未知；禁止自动再次提交，重新生成必须明确确认可能再次计费');
        task.status = 'queued';
        task.error = undefined;
      } else if (action === 'cancel') {
        if (task.status === 'acknowledged' || task.status === 'discarded') return publicProjectRender(task);
        task.status = 'discarded';
        task.error = '已停止生成';
      } else {
        if (task.status === 'acknowledged' || task.status === 'discarded') return publicProjectRender(task);
        if (task.status !== 'done') throw new Error('任务尚未完成');
        const version = await targetVersion(task);
        if (action === 'ack') {
          if (!task.result || version?.image !== task.result) throw new Error('项目尚未成功保存生成图片，不能确认任务');
          task.status = 'acknowledged';
        } else {
          if (version && unchangedReservation(version, task)) throw new Error('目标仍在等待此结果，不能丢弃');
          if (version?.image === task.result) throw new Error('结果已保存，请确认任务');
          task.status = 'discarded';
        }
      }
      return publicProjectRender(task);
    });
    pump();
    return task;
  }

  async function retry(id: string, newId: unknown, confirmNewCharge: unknown) {
    if (confirmNewCharge !== true) throw new Error('重新生成可能再次计费，需要明确确认');
    if (typeof newId !== 'string' || !ID.test(newId) || newId === id) throw new Error('重新生成需要新的版本 ID');
    const result = await projectRenderTransaction(async (tasks) => {
      const source = tasks.find((entry) => entry.id === id);
      if (!source || !['failed', 'interrupted'].includes(source.status)) throw new Error('只有失败或中断任务可以重新生成');
      const digest = createHash('sha256').update(`${source.digest}:${newId}`).digest('hex');
      const existing = tasks.find((entry) => entry.id === newId);
      if (existing) {
        if (existing.digest !== digest) throw new Error('新版本 ID 已占用');
        return publicProjectRender(existing);
      }
      const snapshot = { ...source, id: newId };
      const version = await targetVersion(snapshot);
      if (!version || !unchangedReservation(version, snapshot)) throw new Error('请先保存新的待生成版本');
      await fs.mkdir(path.join(projectRenderRoot, newId), { recursive: true });
      const record: StoredProjectRender = { ...snapshot, digest, createdAt: version.createdAt, status: 'queued',
        submitted: undefined, pendingId: undefined, watchPath: undefined, result: undefined, error: undefined };
      tasks.push(record);
      return publicProjectRender(record);
    });
    pump();
    return result;
  }

  return {
    submit, action, retry,
    list: async () => { pump(); return (await readProjectRenders()).map(publicProjectRender); },
    stop: () => { stopped = true; },
    idle: () => pumping ?? Promise.resolve(),
  };
}
