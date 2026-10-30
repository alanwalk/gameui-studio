import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readImage, saveImage } from './store';
import { listReskinTasks } from './reskinStore';
import { decodeImage } from './imageCodec';
import { parseAtlasFiles } from '../src/lib/atlasImport';
import { ATLAS_LIMITS, validateAtlasManifest, type AtlasJob } from '../src/lib/atlasTypes';
import { validatePackPath } from '../src/lib/packTypes';

export const atlasRoot = path.resolve(process.env.GAMEUI_DATA ?? '.data', 'atlas');
let writes: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation); writes = result.catch(() => undefined); return result;
}
function jobPath(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('图集任务 ID 无效');
  return path.join(atlasRoot, id);
}
async function writeJob(job: AtlasJob): Promise<void> {
  const file = path.join(jobPath(job.id), 'manifest.json'); const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(job), { flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}
export async function getAtlasJob(id: string): Promise<AtlasJob> {
  const job = JSON.parse(await fs.readFile(path.join(jobPath(id), 'manifest.json'), 'utf8')) as AtlasJob;
  if (job.id !== id || !Array.isArray(job.files) || job.files.length !== job.manifest.files.length) throw new Error('图集任务索引损坏');
  validateAtlasManifest(job.manifest);
  for (let i = 0; i < job.files.length; i++) if (job.files[i].path !== job.manifest.files[i]) throw new Error('原文件索引损坏');
  return job;
}
export async function listAtlasJobs(): Promise<AtlasJob[]> {
  let names: string[];
  try { names = await fs.readdir(atlasRoot); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const jobs: AtlasJob[] = [];
  for (const id of names.filter(n => /^[a-f0-9-]{36}$/.test(n))) {
    try { jobs.push(await getAtlasJob(id)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function createAtlasJob(body: { name?: unknown; files?: unknown; descriptions?: unknown }): Promise<AtlasJob> {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 || !Array.isArray(body.files) || !body.files.length || body.files.length > ATLAS_LIMITS.files) throw new Error('图集任务名称或文件数量无效');
  if (body.descriptions !== undefined && (!Array.isArray(body.descriptions) || body.descriptions.length > ATLAS_LIMITS.files || body.descriptions.some(p => typeof p !== 'string'))) throw new Error('描述文件路径无效');
  const files = new Map<string, Uint8Array>(); const seen = new Set<string>(); let total = 0;
  for (const file of body.files) {
    if (!file || typeof file.path !== 'string' || typeof file.base64 !== 'string' || file.base64.length > ATLAS_LIMITS.fileBytes * 1.34 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('原文件编码或大小无效');
    validatePackPath(file.path); const key = file.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('原文件路径重复'); seen.add(key);
    const bytes = Buffer.from(file.base64, 'base64'); total += bytes.length;
    if (bytes.length > ATLAS_LIMITS.fileBytes || total > ATLAS_LIMITS.totalBytes) throw new Error('原文件总大小超限');
    files.set(file.path, bytes);
  }
  // Reparse authoritative source bytes on the server, never trust client-supplied rectangles.
  const imported = await parseAtlasFiles(files, body.descriptions as string[] | undefined);
  for (const page of imported.manifest.pages) {
    const decoded = await decodeImage(Buffer.from(files.get(page.path)!));
    if (decoded.format !== 'png' || decoded.orientation !== 1 || decoded.width !== page.width || decoded.height !== page.height) throw new Error('图集页方向或尺寸无效');
  }
  const id = randomUUID(); const now = Date.now();
  const job: AtlasJob = { id, name: body.name.trim(), manifest: imported.manifest, files: [], createdAt: now, updatedAt: now };
  await fs.mkdir(jobPath(id), { recursive: true });
  for (const [filePath, bytes] of files) {
    if (job.manifest.pages.some(p => p.path === filePath)) {
      const image = await saveImage(`data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, `atlas-${id}`);
      job.files.push({ path: filePath, image });
    } else {
      const asset = `${job.files.length}.bin`;
      await fs.writeFile(path.join(jobPath(id), asset), bytes, { flag: 'wx' });
      job.files.push({ path: filePath, asset });
    }
  }
  await writeJob(job);
  return job;
}
export function linkAtlasTask(id: string, packTaskId: unknown): Promise<AtlasJob> {
  return enqueue(async () => {
    const job = await getAtlasJob(id);
    if (typeof packTaskId !== 'string' || job.packTaskId && job.packTaskId !== packTaskId) throw new Error('图集已关联其他 Pack 任务或任务 ID 无效');
    const task = (await listReskinTasks()).find(t => t.id === packTaskId);
    if (!task || task.sourceTaskId !== job.id || task.items.length !== job.manifest.regions.length) throw new Error('Pack 任务来源不匹配');
    const paths = new Set<string>();
    for (const item of task.items) {
      const region = job.manifest.regions.find(r => r.inputPath === item.originalPath);
      if (!region || paths.has(item.originalPath) || item.format !== 'png' || item.width !== region.sourceWidth || item.height !== region.sourceHeight) throw new Error('Pack region 映射不匹配');
      paths.add(item.originalPath);
    }
    job.packTaskId = packTaskId; job.updatedAt = Date.now(); await writeJob(job); return job;
  });
}
export async function readAtlasFile(id: string, index: number): Promise<{ bytes: Buffer; png: boolean }> {
  const job = await getAtlasJob(id); const file = job.files[index];
  if (!Number.isSafeInteger(index) || index < 0 || !file) throw new Error('原文件索引无效');
  if (file.image) {
    if (!/^[A-Za-z0-9_-]+\.png$/.test(file.image)) throw new Error('图片引用无效');
    const dataUrl = await readImage(file.image);
    return { bytes: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), png: true };
  }
  if (!file.asset || !/^\d+\.bin$/.test(file.asset)) throw new Error('原文件引用无效');
  return { bytes: await fs.readFile(path.join(jobPath(id), file.asset)), png: false };
}
