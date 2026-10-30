import type { ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { decodeImage } from './imageCodec';
import { generateImage, waitForGeneration, type GeneratedAsset } from './magpieMcp';
import { readImage } from './store';
import { PACK_LIMITS, packFormat, packMime, validatePackPath, type PackInput, type PackStyle, type PackTask } from '../src/lib/packTypes';
import { createReskinTask, listReskinTasks, recoverReskinTasks, reskinImagePath, reskinRoot, saveReskinImage, updateReskinTask } from './reskinStore';

const running = new Set<string>();
let initialization: Promise<void> | undefined;
function initialize(): Promise<void> { return initialization ??= recoverReskinTasks(); }

function parseDataUrl(value: unknown, format: string): Buffer {
  if (typeof value !== 'string' || value.length > PACK_LIMITS.fileBytes * 1.34 + 100) throw new Error('图片大小超限');
  const prefix = `data:${packMime(format as PackInput['format'])};base64,`;
  if (!value.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.slice(prefix.length))) throw new Error('图片编码或格式不符');
  const bytes = Buffer.from(value.slice(prefix.length), 'base64');
  if (!bytes.length || bytes.length > PACK_LIMITS.fileBytes) throw new Error('图片大小超限');
  return bytes;
}
export async function importReskinTask(body: Record<string, unknown>): Promise<PackTask> {
  await initialize();
  const inputs = body.items as PackInput[];
  const style = body.style as PackStyle;
  if (!style || typeof style.prompt !== 'string' || !style.prompt.trim() || style.prompt.length > 12000 ||
      typeof style.name !== 'string' || (style.id !== undefined && typeof style.id !== 'string') ||
      (style.image !== undefined && (typeof style.image !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(style.image)))) throw new Error('目标风格无效');
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 ||
      (body.sourceTaskId !== undefined && typeof body.sourceTaskId !== 'string')) throw new Error('任务名称或来源无效');
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > PACK_LIMITS.files) throw new Error('素材数量必须在 1–300 之间');
  const seen = new Set<string>();
  let total = 0;
  const items: PackTask['items'] = [];
  for (const input of inputs) {
    if (!input || typeof input.originalPath !== 'string') throw new Error('无效的素材条目');
    validatePackPath(input.originalPath);
    const format = packFormat(input.originalPath);
    if (input.format !== format) throw new Error('扩展名与图片格式不符');
    const key = input.originalPath.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error(`素材路径重复：${input.originalPath}`);
    seen.add(key);
    const bytes = parseDataUrl(input.dataUrl, format);
    total += bytes.length;
    if (total > PACK_LIMITS.totalBytes) throw new Error('素材包超过 100 MB');
    const decoded = await decodeImage(bytes, { maxPixels: PACK_LIMITS.pixels, maxBytes: PACK_LIMITS.fileBytes });
    if (decoded.format !== format) throw new Error(`扩展名与实际图片格式不符：${input.originalPath}`);
    if (input.width !== decoded.width || input.height !== decoded.height) throw new Error(`图片展示尺寸不符：${input.originalPath}`);
    items.push({ id: randomUUID(), originalPath: input.originalPath, format, width: decoded.width, height: decoded.height,
      encodedWidth: decoded.encodedWidth, encodedHeight: decoded.encodedHeight, orientation: decoded.orientation,
      originalImage: await saveReskinImage(bytes, format), referenceImage: await saveReskinImage(decoded.png, 'png'), status: 'pending' });
  }
  const now = Date.now();
  return createReskinTask({ schemaVersion: 1, id: randomUUID(), name: body.name, sourceTaskId: body.sourceTaskId as string | undefined,
    style: { id: style.id, name: style.name, prompt: style.prompt, image: style.image }, items, status: 'idle', createdAt: now, updatedAt: now });
}

async function generatedBytes(asset: GeneratedAsset): Promise<Buffer> {
  if (asset.isError) throw new Error(asset.text || '生图失败');
  if (asset.base64) {
    if (asset.base64.length > PACK_LIMITS.fileBytes * 1.34) throw new Error('生成图片超过 20 MB');
    return Buffer.from(asset.base64, 'base64');
  }
  if (asset.path) {
    if ((await fs.stat(asset.path)).size > PACK_LIMITS.fileBytes) throw new Error('生成图片超过 20 MB');
    return fs.readFile(asset.path);
  }
  throw new Error(asset.text || '模型未返回图片');
}
async function executeTask(task: PackTask, ids: Set<string>): Promise<void> {
  try {
    for (const original of task.items) {
      if (!ids.has(original.id)) continue;
      try {
        const updated = await updateReskinTask(task.id, (current) => {
          const item = current.items.find((entry) => entry.id === original.id)!;
          item.status = 'running';
          item.error = undefined;
        });
        const item = updated.items.find((entry) => entry.id === original.id)!;
        let asset: GeneratedAsset;
        if (item.pendingId || item.submitted) {
          asset = await waitForGeneration({ pendingId: item.pendingId, watchPath: item.watchPath });
        } else {
          const outputDirectory = path.join(reskinRoot, 'generation', task.id);
          await fs.mkdir(outputDirectory, { recursive: true });
          const watchPath = path.join(outputDirectory, `${randomUUID()}.png`);
          const references = [reskinImagePath(item.referenceImage ?? item.originalImage)];
          if (task.style.image) {
            const reference = await readImage(task.style.image);
            const stylePath = path.join(outputDirectory, 'style.png');
            await fs.writeFile(stylePath, Buffer.from(reference.split(',')[1], 'base64'));
            references.push(stylePath);
          }
          // Persist the uncertain submission window BEFORE crossing the paid boundary.
          await updateReskinTask(task.id, (current) => {
            const entry = current.items.find((entry) => entry.id === item.id)!;
            entry.watchPath = watchPath;
            entry.submitted = true;
          });
          const prompt = `Redraw this single game UI asset (${item.originalPath}) in this style: ${task.style.prompt}. Keep the same silhouette, proportions, content and function. No extra objects or watermark. Preserve transparency. Fit a ${item.width}x${item.height} pixel box.`;
          asset = await generateImage({ prompt, referenceImages: references, path: watchPath, background: 'transparent', quality: 'high', n: 1 });
          if (asset.pendingId) {
            await updateReskinTask(task.id, (current) => { current.items.find((entry) => entry.id === item.id)!.pendingId = asset.pendingId; });
          }
          if (!asset.path && !asset.base64) asset = await waitForGeneration({ pendingId: asset.pendingId, watchPath });
        }
        const bytes = await generatedBytes(asset);
        const decoded = await decodeImage(bytes, { maxPixels: PACK_LIMITS.pixels, maxBytes: PACK_LIMITS.fileBytes });
        const resultImage = await saveReskinImage(decoded.png, 'png');
        await updateReskinTask(task.id, (current) => {
          const entry = current.items.find((entry) => entry.id === item.id)!;
          entry.resultImage = resultImage;
          entry.status = 'done';
          entry.error = undefined;
        });
      } catch (error) {
        await updateReskinTask(task.id, (current) => {
          const entry = current.items.find((entry) => entry.id === original.id)!;
          entry.status = 'failed';
          entry.error = error instanceof Error ? error.message : String(error);
          if (entry.submitted && !entry.pendingId) entry.error += '（提交结果未知；重试优先检查已有输出，重新生成需确认可能再次计费）';
        });
      }
    }
  } finally {
    try { await updateReskinTask(task.id, (current) => { current.status = 'done'; }); }
    finally { running.delete(task.id); }
  }
}

export async function runReskinTask(id: string, itemIds?: unknown, confirmRegenerate = false): Promise<PackTask> {
  await initialize();
  if (running.has(id)) throw new Error('任务正在运行，请等待');
  running.add(id);
  try {
    const tasks = await listReskinTasks();
    const task = tasks.find((entry) => entry.id === id);
    if (!task) throw new Error('换肤任务不存在');
    if (itemIds !== undefined && (!Array.isArray(itemIds) || !itemIds.length || itemIds.some((value) => typeof value !== 'string' || !task.items.some((entry) => entry.id === value)))) throw new Error('重试素材 ID 无效');
    const ids = new Set<string>((itemIds as string[] | undefined) ?? task.items.filter((item) => item.status !== 'done').map((item) => item.id));
    if (!ids.size) throw new Error('没有需要处理的素材');
    const started = await updateReskinTask(id, (current) => {
      for (const item of current.items) {
        if (!ids.has(item.id)) continue;
        if (item.status === 'done') throw new Error('已完成素材不能重复提交');
        if (confirmRegenerate) {
          item.submitted = false;
          item.watchPath = undefined;
          item.pendingId = undefined;
        }
        item.status = 'pending';
      }
      current.status = 'running';
    });
    // Work lives on the server; disconnecting the browser does not cancel it.
    void executeTask(started, ids).catch((error) => console.error('换肤持久化失败', error));
    return started;
  } catch (error) { running.delete(id); throw error; }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > PACK_LIMITS.totalBytes * 1.35 + 1_000_000) throw new Error('请求体超过素材包限制');
    chunks.push(chunk);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须为对象');
  return body as Record<string, unknown>;
}
function send(res: ServerResponse, code: number, value: unknown): void {
  res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value));
}
export function registerReskinApi(server: ViteDevServer): void {
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const imageRoute = url.pathname.startsWith('/api/reskin-images/');
    if (!imageRoute && !/^\/api\/reskin-tasks(?:\/|$)/.test(url.pathname)) { next(); return; }
    try {
      await initialize();
      if (imageRoute && req.method === 'GET') {
        const name = decodeURIComponent(url.pathname.slice('/api/reskin-images/'.length));
        const bytes = await fs.readFile(reskinImagePath(name));
        if (url.searchParams.get('validate') === '1') {
          await decodeImage(bytes, { maxPixels: PACK_LIMITS.pixels, maxBytes: PACK_LIMITS.fileBytes });
        }
        res.setHeader('Content-Type', packMime(packFormat(name)));
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.end(bytes); return;
      }
      const parts = url.pathname.split('/').slice(3);
      if (req.method === 'GET' && !parts[0]) { send(res, 200, await listReskinTasks()); return; }
      if (req.method === 'GET' && parts.length === 1) {
        const task = (await listReskinTasks()).find((entry) => entry.id === parts[0]);
        send(res, task ? 200 : 404, task ?? { error: '任务不存在' }); return;
      }
      if (req.method === 'POST' && !parts[0]) { send(res, 201, await importReskinTask(await readBody(req))); return; }
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'run') {
        const body = await readBody(req);
        send(res, 202, await runReskinTask(parts[0], body.itemIds, body.confirmRegenerate === true)); return;
      }
      send(res, 405, { error: '不支持的换肤操作' });
    } catch (error) { send(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
  });
}
