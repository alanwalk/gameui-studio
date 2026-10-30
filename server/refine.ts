import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ViteDevServer } from 'vite';
import { generateImage, waitForGeneration } from './magpieMcp';
import { readImage, saveImage } from './store';
import { decodeImage } from './imageCodec';

const IMAGE_LIMITS = { maxPixels: 40_000_000, maxBytes: 20 * 1024 * 1024 };

function storedImageName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+\.png$/.test(value)) {
    throw new Error('图片必须是已存储的 PNG 文件名');
  }
  return value;
}

async function refine(body: Record<string, unknown>) {
  const sourceImage = storedImageName(body.sourceImage);
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('缺少修改要求 prompt');
  const prompt = body.prompt.trim();
  let styleImage: string | undefined;
  if (body.styleImage !== undefined && body.styleImage !== '') styleImage = storedImageName(body.styleImage);
  const source = await readImage(sourceImage);
  const style = styleImage ? await readImage(styleImage) : undefined;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-refine-'));
  try {
    const sourcePath = path.join(directory, 'source.png');
    const sourceSize = await decodeImage(Buffer.from(source.split(',')[1], 'base64'), IMAGE_LIMITS);
    await fs.writeFile(sourcePath, sourceSize.png);
    const referenceImages = [sourcePath];
    if (style) {
      const stylePath = path.join(directory, 'style.png');
      const decodedStyle = await decodeImage(Buffer.from(style.split(',')[1], 'base64'), IMAGE_LIMITS);
      await fs.writeFile(stylePath, decodedStyle.png);
      referenceImages.push(stylePath);
    }
    const output = path.join(directory, 'refined.png');
    const instructions = [
      'Edit the first reference image, a complete game UI screen. Keep the full canvas and unchanged content.',
      style ? 'Use the second reference as the selected visual style.' : 'Preserve the existing visual style.',
      `Requested changes: ${prompt}`,
    ].join('\n');
    let asset = await generateImage({
      prompt: instructions, referenceImages, path: output, size: `${sourceSize.width}x${sourceSize.height}`,
      quality: 'high', background: 'opaque', n: 1,
    });
    if (!asset.path && !asset.base64) {
      asset = await waitForGeneration({ pendingId: asset.pendingId, watchPath: output });
    }
    if (asset.isError) throw new Error(asset.text || '微调失败');
    let bytes: Buffer;
    if (asset.base64) bytes = Buffer.from(asset.base64, 'base64');
    else if (asset.path) bytes = await fs.readFile(asset.path);
    else throw new Error(asset.text || '微调未返回图片');
    const decodedResult = await decodeImage(bytes, IMAGE_LIMITS);
    if (decodedResult.width * sourceSize.height !== decodedResult.height * sourceSize.width) {
      throw new Error('微调返回图的宽高比与源图不符，未保存版本');
    }
    let normalizedBytes = decodedResult.png;
    if (decodedResult.width !== sourceSize.width || decodedResult.height !== sourceSize.height) {
      const resized = await sharp(decodedResult.png)
        .resize(sourceSize.width, sourceSize.height, { fit: 'fill' })
        .png().toBuffer({ resolveWithObject: true });
      if (resized.info.width !== sourceSize.width || resized.info.height !== sourceSize.height) {
        throw new Error('微调返回图无法恢复源画布尺寸');
      }
      normalizedBytes = resized.data;
    }
    if (normalizedBytes.length > IMAGE_LIMITS.maxBytes) throw new Error('微调标准 PNG 超过 20 MB');
    const dataUrl = `data:image/png;base64,${normalizedBytes.toString('base64')}`;
    return { fileName: await saveImage(dataUrl, 'refine'), dataUrl, width: sourceSize.width, height: sourceSize.height };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function registerRefineApi(server: ViteDevServer): void {
  server.middlewares.use('/api/refine', async (req, res, next) => {
    if (req.url?.split('?')[0] !== '/' && req.url?.split('?')[0] !== '') return next();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end(JSON.stringify({ error: '不支持的方法' }));
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64 * 1024) throw new Error('微调请求过大');
        chunks.push(Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求必须是 JSON 对象');
      const result = await refine(body as Record<string, unknown>);
      res.statusCode = 200;
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 502;
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
}
