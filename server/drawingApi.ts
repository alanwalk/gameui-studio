import type { ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateImage, waitForGeneration, type GeneratedAsset } from './magpieMcp';
import { decodeImage } from './imageCodec';
import { drawingSize, type DrawingInput, type DrawingTask } from '../src/lib/drawingTypes';
import { addDrawingTask, drawingRoot, getDrawingState, getDrawingTasks, readDrawingImage, saveDrawingImage, updateDrawingTask } from './drawingStore';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Provider = { generateImage: typeof generateImage; waitForGeneration: typeof waitForGeneration };

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('请求体超过 20 MB 图片限制');
    chunks.push(Buffer.from(chunk));
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求体不是合法 JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须为对象');
  return body as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function validateInput(body: Record<string, unknown>): Promise<DrawingInput> {
  if (Object.keys(body).some((key) => !['prompt', 'references', 'ratio', 'size'].includes(key))) throw new Error('不支持的画图字段');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000) throw new Error('提示词必须在 1–12000 字之间');
  const ratio = body.ratio as DrawingInput['ratio'];
  const size = drawingSize({ ratio, size: body.size as string | undefined });
  if (!Array.isArray(body.references) || body.references.length > 5 || body.references.some((id) => typeof id !== 'string' || !UUID.test(id))) throw new Error('最多使用 5 张已上传的参考图');
  if (new Set(body.references).size !== body.references.length) throw new Error('参考图不能重复');
  for (const id of body.references) await readDrawingImage(id);
  return { prompt: body.prompt.trim(), ratio, size, references: [...body.references] };
}

async function resultDataUrl(asset: GeneratedAsset): Promise<{ dataUrl: string; width: number; height: number }> {
  if (asset.isError) throw new Error(asset.text || 'Magpie 返回失败');
  let bytes: Buffer;
  if (asset.base64) {
    if (asset.base64.length > MAX_BODY_BYTES) throw new Error('生成图片超过 20 MB');
    bytes = Buffer.from(asset.base64, 'base64');
  } else if (asset.path) {
    // Only trusted provider output reaches here; HTTP bodies never supply paths.
    if ((await fs.stat(asset.path)).size > MAX_IMAGE_BYTES) throw new Error('生成图片超过 20 MB');
    bytes = await fs.readFile(asset.path);
  } else {
    throw new Error(asset.text || 'Magpie 未返回图片');
  }
  const decoded = await decodeImage(bytes, { maxPixels: 40_000_000, maxBytes: MAX_IMAGE_BYTES });
  return { dataUrl: `data:image/png;base64,${decoded.png.toString('base64')}`, width: decoded.width, height: decoded.height };
}

/** A single drawing queue belongs to the server, independent of browser connections. */
export function createDrawingHandler(provider: Provider = { generateImage, waitForGeneration }) {
  let pumping: Promise<void> | undefined;
  let stopped = false;

  async function execute(task: DrawingTask): Promise<void> {
    let receivedResult = false;
    try {
      await updateDrawingTask(task.id, (current) => { current.status = 'running'; current.error = undefined; });
      let asset: GeneratedAsset;
      if (task.submitted) {
        if (!task.pendingId && !task.watchPath) throw new Error('提交结果未知，无法定位已有请求');
        asset = await provider.waitForGeneration({ pendingId: task.pendingId, watchPath: task.watchPath });
      } else {
        const directory = path.join(drawingRoot, 'generation', task.id);
        await fs.mkdir(directory, { recursive: true });
        const referenceImages: string[] = [];
        for (const id of task.references) {
          const reference = await readDrawingImage(id);
          // Older records may predate full decoding; normalize them before the paid boundary too.
          const decoded = await decodeImage(reference.bytes, { maxPixels: 40_000_000, maxBytes: MAX_IMAGE_BYTES });
          const file = path.join(directory, `${id}.png`);
          await fs.writeFile(file, decoded.png);
          referenceImages.push(file);
        }
        const watchPath = path.join(directory, 'result.png');
        // The paid request can succeed even if its response is lost: persist before sending.
        await updateDrawingTask(task.id, (current) => { current.submitted = true; current.watchPath = watchPath; });
        task.submitted = true;
        task.watchPath = watchPath;
        const canvasRatio = task.ratio === 'custom' ? task.size : task.ratio;
        const canvasRequirements = `Canvas requirements: Request a ${canvasRatio} canvas at ${task.size} pixels. Keep the main subject fully inside the canvas; do not crop the main subject.`;
        const modelPrompt = `${task.prompt}\n\n${canvasRequirements}`;
        asset = await provider.generateImage({ prompt: modelPrompt, referenceImages, path: watchPath, size: task.size, n: 1 });
        if (asset.pendingId) {
          task.pendingId = asset.pendingId;
          await updateDrawingTask(task.id, (current) => { current.pendingId = asset.pendingId; });
        }
        if (!asset.base64 && !asset.path) asset = await provider.waitForGeneration({ pendingId: task.pendingId, watchPath });
      }
      receivedResult = true;
      const result = await resultDataUrl(asset);
      const size = { width: result.width, height: result.height };
      const image = await saveDrawingImage(result.dataUrl, `生成图 ${new Date(task.createdAt).toLocaleString('zh-CN')}`, size);
      await updateDrawingTask(task.id, (current) => {
        current.result = image.id;
        current.resultSize = size;
        current.status = 'done';
        current.error = undefined;
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await updateDrawingTask(task.id, (current) => {
        current.status = 'failed';
        if (current.submitted && !receivedResult) current.status = 'interrupted';
        current.result = undefined;
        current.resultSize = undefined;
        current.error = detail.slice(0, 1500);
        if (current.submitted) current.error += '。请求可能已计费；可继续等待已有结果，重新生成会提交新请求。';
      });
    }
  }

  function pump(): void {
    if (pumping || stopped) return;
    pumping = (async () => {
      while (!stopped) {
        const task = (await getDrawingTasks()).find((entry) => entry.status === 'queued' || entry.status === 'running');
        if (!task) return;
        await execute(task);
      }
    })().catch((error) => { console.error('Drawing queue:', error); }).finally(() => { pumping = undefined; });
  }

  async function create(input: DrawingInput, retryOf?: string): Promise<void> {
    const now = Date.now();
    await addDrawingTask({ ...input, id: randomUUID(), size: drawingSize(input), status: 'queued', createdAt: now, updatedAt: now, retryOf });
    pump();
  }

  const handle = async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/drawing/')) { next(); return; }
    try {
      if (req.method === 'GET' && url.pathname === '/api/drawing/state') {
        pump(); send(res, 200, await getDrawingState()); return;
      }
      const imageMatch = url.pathname.match(/^\/api\/drawing\/images\/([0-9a-f-]+)$/);
      if (req.method === 'GET' && imageMatch) {
        if (!UUID.test(imageMatch[1])) throw new Error('图片引用无效');
        const { image, bytes } = await readDrawingImage(imageMatch[1]);
        res.setHeader('Content-Type', image.mime);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
        if (url.searchParams.get('download') === '1') {
          let extension = 'png';
          if (image.mime === 'image/jpeg') extension = 'jpg';
          else if (image.mime === 'image/webp') extension = 'webp';
          res.setHeader('Content-Disposition', `attachment; filename="drawing-${image.id}.${extension}"`);
        }
        res.end(bytes); return;
      }
      if (req.method !== 'POST') { send(res, 404, { error: '画图接口不存在' }); return; }
      const body = await readBody(req);
      if (url.pathname === '/api/drawing/images') {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 || typeof body.dataUrl !== 'string') throw new Error('上传图片字段无效');
        const match = body.dataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
        if (!match) throw new Error('只支持 PNG、JPEG、WebP 图片');
        const bytes = Buffer.from(match[2], 'base64');
        const decoded = await decodeImage(bytes, { maxPixels: 40_000_000, maxBytes: MAX_IMAGE_BYTES });
        if (`image/${decoded.format}` !== match[1]) throw new Error('图片声明格式与实际格式不符');
        const normalizedDataUrl = `data:image/png;base64,${decoded.png.toString('base64')}`;
        const size = { width: decoded.width, height: decoded.height };
        send(res, 201, await saveDrawingImage(normalizedDataUrl, body.name.trim(), size)); return;
      }
      if (url.pathname === '/api/drawing/tasks') {
        await create(await validateInput(body)); send(res, 202, await getDrawingState()); return;
      }
      const taskMatch = url.pathname.match(/^\/api\/drawing\/tasks\/([0-9a-f-]+)\/(resume|retry)$/);
      if (taskMatch) {
        const task = (await getDrawingTasks()).find((entry) => entry.id === taskMatch[1]);
        if (!task) { send(res, 404, { error: '画图记录不存在' }); return; }
        if (!['failed', 'interrupted'].includes(task.status)) { send(res, 409, { error: '只能恢复或重试失败的任务' }); return; }
        if (taskMatch[2] === 'resume') {
          if (!task.submitted || (!task.pendingId && !task.watchPath)) throw new Error('没有可继续等待的请求');
          await updateDrawingTask(task.id, (current) => { current.status = 'queued'; current.error = undefined; });
          pump();
        } else {
          if (body.confirmNewCharge !== true) { send(res, 409, { error: '重新生成可能再次计费，需要明确确认' }); return; }
          await create({ prompt: task.prompt, references: [...task.references], ratio: task.ratio, size: task.size }, task.id);
        }
        send(res, 202, await getDrawingState()); return;
      }
      send(res, 404, { error: '画图接口不存在' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(res, 400, { error: message.slice(0, 2000) });
    }
  };
  pump();
  return { handle, stop: () => { stopped = true; }, idle: () => pumping ?? Promise.resolve() };
}

export function registerDrawingApi(server: ViteDevServer): void {
  const drawing = createDrawingHandler();
  server.middlewares.use((req, res, next) => { void drawing.handle(req, res, next); });
  server.httpServer?.once('close', drawing.stop);
}
