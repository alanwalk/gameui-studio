import type { ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { gatewayChat, VISION_MODEL } from './visionGateway';
import { decodeImage } from './imageCodec';
import { saveImage, listStyles } from './store';
import { readDrawingImage } from './drawingStore';

const imageRoot = path.resolve(process.env.GAMEUI_DATA ?? '.data', 'images');
const MAX_BYTES = 20 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BYTES * 4 / 3 + 4096) throw new Error('请求体过大');
    chunks.push(Buffer.from(chunk));
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是对象');
  return body as Record<string, unknown>;
}

export async function readStyleReference(fileName: unknown): Promise<Buffer> {
  if (typeof fileName !== 'string' || !/^[A-Za-z0-9_-]+\.png$/.test(fileName)) throw new Error('参考图文件名无效');
  const root = await fs.realpath(imageRoot);
  const file = await fs.realpath(path.join(root, fileName));
  if (path.dirname(file) !== root) throw new Error('参考图路径越界');
  if ((await fs.stat(file)).size > MAX_BYTES) throw new Error('参考图过大');
  return (await decodeImage(await fs.readFile(file))).png;
}

export function parseStyleOutput(raw: string): { name: string; prompt: string } {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('AI 未返回合法 JSON，请重试'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['name', 'prompt'].includes(key)) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 ||
      typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 8000) {
    throw new Error('AI 返回的风格名称或提示词无效，请重试');
  }
  return { name: value.name.trim(), prompt: value.prompt.trim() };
}

export async function styleContactSheet(images: Buffer[]): Promise<Buffer> {
  if (!images.length || images.length > 12) throw new Error('参考图数量必须为 1–12');
  const columns = Math.min(4, images.length);
  const cells = [];
  for (let index = 0; index < images.length; index++) {
    const input = await sharp(images[index]).resize(384, 384, { fit: 'contain', background: '#eeeeee' }).png().toBuffer();
    cells.push({ input, left: index % columns * 384, top: Math.floor(index / columns) * 384 });
  }
  return sharp({ create: { width: columns * 384, height: Math.ceil(images.length / columns) * 384, channels: 3, background: '#eeeeee' } }).composite(cells).png().toBuffer();
}

export function createStyleHandler(chat: typeof gatewayChat = gatewayChat) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!pathname.startsWith('/api/style-generation/')) { next(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST') throw new Error('仅支持 POST');
      const body = await readBody(req);
      let result: unknown;
      if (pathname === '/api/style-generation/source-images') {
        if (typeof body.drawingImage !== 'string' || !/^[a-f0-9-]{36}$/.test(body.drawingImage)) throw new Error('参考图引用无效');
        const stored = await readDrawingImage(body.drawingImage);
        let sources = stored.image.sourceImages;
        if (!sources && stored.image.name === '风格参考合集（非生成预览）') {
          // Historical collections are linked only when saved originals reproduce the exact image.
          for (const style of await listStyles()) {
            if (!style.referenceImages?.length || style.referenceImages.length > 12) continue;
            try {
              const images = await Promise.all(style.referenceImages.map(readStyleReference));
              if ((await styleContactSheet(images)).equals(stored.bytes)) {
                sources = style.referenceImages;
                break;
              }
            } catch { /* Keep collections usable when a historical reference is missing. */ }
          }
        }
        result = { images: sources ?? [] };
      } else if (pathname === '/api/style-generation/reference') {
        if (typeof body.dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(body.dataUrl)) throw new Error('仅支持 PNG/JPEG/WebP');
        const decoded = await decodeImage(Buffer.from(body.dataUrl.split(',')[1], 'base64'));
        result = { fileName: await saveImage(`data:image/png;base64,${decoded.png.toString('base64')}`, 'style-ref') };
      } else if (pathname === '/api/style-generation/preview') {
        if (typeof body.result !== 'string' || !/^[a-f0-9-]{36}$/.test(body.result)) throw new Error('预览引用无效');
        const image = await readDrawingImage(body.result);
        const decoded = await decodeImage(image.bytes, { maxPixels: 40_000_000 });
        result = { fileName: await saveImage(`data:image/png;base64,${decoded.png.toString('base64')}`, 'style-preview') };
      } else if (pathname === '/api/style-generation/analyze') {
        if (typeof body.description !== 'string' || body.description.length > 8000) throw new Error('描述最长 8000 字');
        if (!Array.isArray(body.referenceImages) || body.referenceImages.length > 12) throw new Error('最多使用 12 张参考图');
        if (!body.description.trim() && !body.referenceImages.length) throw new Error('请输入描述或上传参考图');
        if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 200)) throw new Error('视觉模型无效');
        const images = [];
        for (const reference of body.referenceImages) images.push(await readStyleReference(reference));
        const content: unknown[] = [{ type: 'text', text: `用户描述：${body.description}\n参考图共 ${images.length} 张。提取它们通用的可复用美术风格，描述配色、线条、材质、光照、造型与 UI 视觉语言，不照抄人物、文字或具体布局。` }];
        let sheet: Buffer | undefined;
        if (images.length) {
          sheet = await styleContactSheet(images);
          content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${sheet.toString('base64')}` } });
        }
        const raw = await chat([
          { role: 'system', content: '你是游戏美术风格设计师。只返回严格 JSON 对象 {"name":"简短中文画风名称","prompt":"可独立复用的详细画风提示词"}。不要 Markdown、前后说明或额外字段。' },
          { role: 'user', content },
        ], typeof body.model === 'string' ? body.model : VISION_MODEL);
        const style = parseStyleOutput(raw);
        result = { ...style, drawingReferences: [] };
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: '风格接口不存在' })); return;
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).slice(0, 1500) }));
    }
  };
}

export function registerStyleApi(server: ViteDevServer): void {
  const handle = createStyleHandler();
  server.middlewares.use((req, res, next) => { void handle(req, res, next); });
}
