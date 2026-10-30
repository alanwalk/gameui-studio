import type { SliceTask } from '../src/types';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Plugin, ViteDevServer } from 'vite';
import { generateImage, waitForGeneration } from './magpieMcp';
import { handleSegmentation } from './segmentation';
import { registerRefineApi } from './refine';
import { registerReskinApi } from './reskinApi';
import { registerDrawingApi } from './drawingApi';
import { registerStyleApi } from './styleApi';
import { registerAtlasApi } from './atlasApi';
import { registerProjectCopyApi } from './projectCopyApi';
import { registerProjectRenderApi } from './projectRenderApi';
import { decodeImage } from './imageCodec';
import { GATEWAY, GATEWAY_KEY, VISION_MODEL, gatewayChat } from './visionGateway';
import {
  listSliceTasks,
  upsertSliceTask,
  removeStandaloneSliceTask,
  deleteProject,
  listProjects,
  readImage,
  saveImage,
  upsertProject,
  type ProjectRecord,
  deleteStyle,
  listStyles,
  upsertStyle,
  type StyleRecord,
} from './store';

/**
 * Browser <-> Magpie bridge.
 *
 * The browser cannot do either half of this itself: Magpie's gateway refuses cross-origin
 * requests, and `magpie mcp image` is a stdio process with no HTTP surface. So this
 * middleware is the only place the two meet, and it is also the only place a key exists.
 * The app itself never sees a key.
 */

type JsonBody = Record<string, unknown>;

function readBody(req: any, maxBytes = Infinity): Promise<JsonBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) { reject(new Error('请求体超过图片大小限制')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: any, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}


/**
 * The model is asked for JSON but may still wrap it in prose, so the object is sliced
 * out by brace matching rather than trusting a fence.
 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('模型没有返回 JSON');

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return raw.slice(start, i + 1);
  }

  throw new Error('模型返回的 JSON 不完整');
}

async function handleDetect(body: JsonBody): Promise<unknown> {
  const image = typeof body.image === 'string' ? body.image : '';
  const width = Number(body.width);
  const height = Number(body.height);
  if (!image || !width || !height) throw new Error('缺少 image / width / height');

  const content = await gatewayChat(
    [
      { role: 'system', content: String(body.system ?? '') },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Image size: ${width}x${height} px. Return the element list as JSON.`,
          },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ],
    typeof body.model === 'string' && body.model ? body.model : VISION_MODEL,
  );

  return { content: extractJsonObject(content) };
}

/** Turns a text request into a flat wireframe node list, used to seed a layout. */
async function handleLayout(body: JsonBody): Promise<unknown> {
  const usage = typeof body.usage === 'string' ? body.usage : '';
  if (!usage) throw new Error('缺少 usage');

  const orientation = body.orientation === 'landscape' ? 'landscape' : 'portrait';
  const content = await gatewayChat(
    [
      {
        role: 'system',
        content: String(body.system ?? ''),
      },
      { role: 'user', content: usage },
    ],
    typeof body.model === 'string' && body.model ? body.model : VISION_MODEL,
  );

  return { content: extractJsonObject(content), orientation };
}

/**
 * Writes the source crop to a temp file so the MCP tool can take it as a reference.
 * It wants a path, and the browser only has a data URL.
 */
async function writeReference(dataUrl: string, name: string): Promise<string> {
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.slice(comma + 1);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-ref-'));
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from(base64, 'base64'));
  return file;
}

async function fileToDataUrl(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

async function handlePlate(body: JsonBody): Promise<unknown> {
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) throw new Error('缺少 prompt');

  const references: string[] = [];
  if (typeof body.reference === 'string' && body.reference) {
    references.push(await writeReference(body.reference, 'source.png'));
  }

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-out-'));

  const platePath = path.join(outDir, 'plate.png');
  const first = await generateImage({
    prompt,
    referenceImages: references,
    path: platePath,
    background: 'transparent',
    quality: 'high',
    n: 1,
  });

  let asset = first;
  if (!asset.path && !asset.base64) {
    asset = await waitForGeneration({ pendingId: first.pendingId, watchPath: platePath });
  }

  if (asset.base64) return { dataUrl: `data:image/png;base64,${asset.base64}`, text: asset.text };
  if (asset.path) return { dataUrl: await fileToDataUrl(asset.path), text: asset.text };

  // Nothing arrived within the poll window; surface the tool's own words.
  throw new Error(asset.text || '补图未返回结果');
}

async function handleAiSliceSheet(body: JsonBody): Promise<unknown> {
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  const reference = typeof body.reference === 'string' ? body.reference : '';
  const size = typeof body.size === 'string' ? body.size : undefined;
  if (!prompt) throw new Error('缺少拆图要求');
  if (prompt.length > 12_000) throw new Error('拆图要求不能超过 12000 字符');
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(reference)) throw new Error('缺少有效的参考图');
  if (size !== undefined && !/^\d{1,5}x\d{1,5}$/.test(size)) throw new Error('拆图尺寸无效');

  const comma = reference.indexOf(',');
  const decoded = await decodeImage(Buffer.from(reference.slice(comma + 1), 'base64'), {
    maxPixels: 40_000_000,
    maxBytes: 20 * 1024 * 1024,
  });
  const referenceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-studio-slice-ref-'));
  const referencePath = path.join(referenceDir, 'source.png');
  await fs.writeFile(referencePath, decoded.png);

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-studio-slice-'));
  const sheetPath = path.join(outDir, 'slice-sheet.png');
  const args: Parameters<typeof generateImage>[0] = {
    prompt,
    referenceImages: [referencePath],
    path: sheetPath,
    background: 'transparent',
    quality: 'high',
    n: 1,
  };
  if (size) args.size = size;

  let asset = await generateImage(args);
  if (!asset.path && !asset.base64) {
    asset = await waitForGeneration({ pendingId: asset.pendingId, watchPath: sheetPath });
  }
  if (asset.base64) return { dataUrl: `data:image/png;base64,${asset.base64}`, text: asset.text };
  if (asset.path) return { dataUrl: await fileToDataUrl(asset.path), text: asset.text };
  throw new Error(asset.text || 'AI 拆图没有返回结果');
}

/**
 * Renders a screen from a wireframe. The wireframe is the strongest control signal
 * available - it pins position, size and rough shape - so it is always sent as a
 * reference even when the user also supplied a style board.
 */
async function handleGenerate(body: JsonBody): Promise<unknown> {
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt) throw new Error('缺少 prompt');

  const references: string[] = [];
  if (typeof body.wireframe === 'string' && body.wireframe) {
    references.push(await writeReference(body.wireframe, 'wireframe.png'));
  }
  // The style board is a persisted image, so it arrives as a file name rather than
  // pixel data; reading it here keeps project JSON small.
  if (typeof body.styleImage === 'string' && body.styleImage) {
    references.push(await writeReference(await readImage(body.styleImage), 'style.png'));
  }

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-gen-'));

  const screenPath = path.join(outDir, 'screen.png');
  const args: Parameters<typeof generateImage>[0] = {
    prompt,
    referenceImages: references,
    path: screenPath,
    quality: 'high',
    background: 'opaque',
    n: 1,
  };
  if (typeof body.size === 'string' && body.size) args.size = body.size;

  const first = await generateImage(args);
  let asset = first;
  if (!asset.path && !asset.base64) {
    asset = await waitForGeneration({ pendingId: first.pendingId, watchPath: screenPath });
  }

  let dataUrl: string;
  if (asset.base64) dataUrl = `data:image/png;base64,${asset.base64}`;
  else if (asset.path) dataUrl = await fileToDataUrl(asset.path);
  else throw new Error(asset.text || '生图未返回结果');

  // Persisted, not just returned: versions have to survive a page reload.
  const fileName = await saveImage(dataUrl, 'screen');
  return { fileName, dataUrl, text: asset.text };
}

async function handleModels(): Promise<unknown> {
  const response = await fetch(`${GATEWAY}/models`, {
    headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
  });
  if (!response.ok) throw new Error(`Magpie 网关 ${response.status}`);
  const payload = (await response.json()) as { data?: { id?: string }[] };
  return { models: (payload.data ?? []).map((m) => m.id).filter(Boolean) };
}

/** Surfaces a clear message when Magpie is not running, instead of a bare 500. */
async function handleHealth(): Promise<unknown> {
  try {
    const response = await fetch(`${GATEWAY}/models`, {
      headers: { Authorization: `Bearer ${GATEWAY_KEY}` },
    });
    return {
      gateway: response.ok,
      gatewayUrl: GATEWAY,
      visionModel: VISION_MODEL,
      status: response.ok ? 'Magpie 网关已连接' : `网关返回 ${response.status}`,
    };
  } catch (error) {
    return {
      gateway: false,
      gatewayUrl: GATEWAY,
      visionModel: VISION_MODEL,
      status: `无法连接 Magpie 网关：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function probeMagpie(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      process.env.MAGPIE_BIN ?? 'magpie',
      ['providers'],
      { stdio: 'ignore', windowsHide: true },
    );
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 8000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export function magpieApi(): Plugin {
  return {
    name: 'gameui-magpie-api',
    configureServer(server: ViteDevServer) {
      registerRefineApi(server);
      registerReskinApi(server);
      registerDrawingApi(server);
      registerStyleApi(server);
      registerAtlasApi(server);
      registerProjectCopyApi(server);
      registerProjectRenderApi(server);
      server.middlewares.use('/api/segment-health', (req, res) => handleSegmentation(req, res, true));
      server.middlewares.use('/api/segment', (req, res) => handleSegmentation(req, res));

      server.middlewares.use('/api/health', async (_req, res) => {
        try {
          send(res, 200, await handleHealth());
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/models', async (_req, res) => {
        try {
          send(res, 200, await handleModels());
        } catch (error) {
          send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/detect', async (req, res) => {
        try {
          const body = await readBody(req);
          send(res, 200, await handleDetect(body));
        } catch (error) {
          send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/layout', async (req, res) => {
        try {
          const body = await readBody(req);
          send(res, 200, await handleLayout(body));
        } catch (error) {
          send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/plate', async (req, res) => {
        try {
          const body = await readBody(req);
          send(res, 200, await handlePlate(body));
        } catch (error) {
          send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/ai-slice-sheet', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            send(res, 405, { error: 'AI 拆图仅支持 POST' });
            return;
          }
          const body = await readBody(req, Math.ceil(20 * 1024 * 1024 * 4 / 3) + 4096);
          send(res, 200, await handleAiSliceSheet(body));
        } catch (error) {
          send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/generate', async (req, res) => {
        try {
          const body = await readBody(req);
          send(res, 200, await handleGenerate(body));
        } catch (error) {
          send(res, 502, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      // Style boards are uploaded once and reused by every screen in the project.
      server.middlewares.use('/api/upload', async (req, res) => {
        try {
          if (req.method !== 'POST') {
            res.setHeader('Allow', 'POST');
            send(res, 405, { error: '上传仅支持 POST' });
            return;
          }
          const maxBytes = 20 * 1024 * 1024;
          const body = await readBody(req, Math.ceil(maxBytes * 4 / 3) + 4096);
          const dataUrl = typeof body.image === 'string' ? body.image : '';
          const match = dataUrl.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
          if (!match) throw new Error('上传仅支持合法的 PNG、JPEG、WebP base64 图片');
          const bytes = Buffer.from(match[2], 'base64');
          if (bytes.toString('base64') !== match[2]) throw new Error('上传图片 base64 编码无效');
          const decoded = await decodeImage(bytes, { maxPixels: 40_000_000, maxBytes });
          if (decoded.format !== match[1]) throw new Error('图片声明格式与实际格式不符');
          const normalized = `data:image/png;base64,${decoded.png.toString('base64')}`;
          const prefix = typeof body.prefix === 'string' && body.prefix ? body.prefix : 'style';
          send(res, 200, { fileName: await saveImage(normalized, prefix) });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/slice-tasks', async (req, res) => {
        try {
          if (req.method === 'GET') {
            send(res, 200, { tasks: await listSliceTasks() });
            return;
          }
          if (req.method === 'PUT') {
            const body = await readBody(req);
            send(res, 200, { tasks: await upsertSliceTask(body.task as SliceTask) });
            return;
          }
          if (req.method === 'DELETE') {
            const body = await readBody(req);
            send(res, 200, { tasks: await removeStandaloneSliceTask(body.id) });
            return;
          }
          send(res, 405, { error: '不支持的方法' });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/projects', async (req, res) => {
        try {
          if (req.method === 'GET') {
            send(res, 200, { projects: await listProjects() });
            return;
          }
          const body = await readBody(req);
          if (req.method === 'PUT') {
            const project = body.project as ProjectRecord;
            if (!project?.id) throw new Error('缺少 project');
            send(res, 200, { projects: await upsertProject(project) });
            return;
          }
          if (req.method === 'DELETE') {
            send(res, 200, { projects: await deleteProject(String(body.id)) });
            return;
          }
          send(res, 405, { error: '不支持的方法' });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      server.middlewares.use('/api/styles', async (req, res) => {
        try {
          if (req.method === 'GET') {
            send(res, 200, { styles: await listStyles() });
            return;
          }
          const body = await readBody(req);
          if (req.method === 'PUT') {
            const style = body.style as StyleRecord;
            if (!style?.id) throw new Error('缺少 style');
            send(res, 200, { styles: await upsertStyle(style) });
            return;
          }
          if (req.method === 'DELETE') {
            send(res, 200, { styles: await deleteStyle(String(body.id)) });
            return;
          }
          send(res, 405, { error: '不支持的方法' });
        } catch (error) {
          send(res, 500, { error: error instanceof Error ? error.message : String(error) });
        }
      });

      // Serves a persisted image by file name, so a project can be reloaded later.
      server.middlewares.use('/api/image', async (req, res) => {
        const query = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const fileName = query.get('name') ?? '';
        try {
          if (!fileName) throw new Error('缺少 name');
          const raw = await readImage(fileName);
          const base64 = raw.slice(raw.indexOf(',') + 1);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.end(Buffer.from(base64, 'base64'));
        } catch (error) {
          send(res, 404, { error: error instanceof Error ? error.message : String(error) });
        }
      });
    },
  };
}

export { probeMagpie };
