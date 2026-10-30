import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readImage } from './store';
import { isSegmentationDiagnostics, type SegmentationDiagnostics } from '../src/lib/segmentationTypes';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PYTHON = path.join(ROOT, process.platform === 'win32' ? '.venv-seg/Scripts/python.exe' : '.venv-seg/bin/python');
const SCRIPT = path.join(ROOT, 'scripts/segment.py');
const SAM2_ROOT = path.join(ROOT, '.data/segmentation/sam2');
const WEIGHTS = path.join(SAM2_ROOT, 'sam2.1_hiera_small.pt');
const SITE = path.join(SAM2_ROOT, 'site');
const SOURCE = path.join(SAM2_ROOT, 'source');
const CONFIG = 'configs/sam2.1/sam2.1_hiera_s.yaml';
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_REQUEST = 64 * 1024;
const MAX_COORD = 100_000;

export class SegmentationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Point = { x: number; y: number; label: 0 | 1 };
type ElementKind = 'panel' | 'button' | 'icon' | 'text' | 'progress' | 'frame' | 'decor';
type SegmentRequest = {
  sourceImage: string;
  rect: { x: number; y: number; w: number; h: number };
  points?: Point[];
  kind?: ElementKind;
};
type SegmentResult = SegmentationDiagnostics & {
  protocolVersion: 2;
  width: number;
  height: number;
  maskBase64: string;
  rgbaBase64: string;
  score: number;
  elapsedMs: number;
  model: string;
  chosenIndex?: number;
  candidates?: unknown[];
};

function coordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COORD;
}

function isElementKind(value: unknown): value is ElementKind {
  return value === 'panel' || value === 'button' || value === 'icon' || value === 'text' ||
    value === 'progress' || value === 'frame' || value === 'decor';
}

function validateRequest(value: unknown): SegmentRequest {
  const body = value as SegmentRequest | null;
  if (!body || typeof body !== 'object' || typeof body.sourceImage !== 'string' ||
      body.sourceImage.length > 255 || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.png$/i.test(body.sourceImage) || body.sourceImage.includes('..')) {
    throw new SegmentationError(400, 'sourceImage 必须是已存图片的 PNG 文件名，不能包含路径');
  }
  const rect = body.rect;
  if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(coordinate) || rect.w <= 0 || rect.h <= 0 ||
      rect.x + rect.w > MAX_COORD || rect.y + rect.h > MAX_COORD) {
    throw new SegmentationError(400, 'rect 必须包含非负整数坐标和正整数 w/h，坐标上限 100000');
  }
  if (body.points !== undefined && (!Array.isArray(body.points) || body.points.length > 256 || body.points.some(
    (point) => !point || !coordinate(point.x) || !coordinate(point.y) || (point.label !== 0 && point.label !== 1),
  ))) throw new SegmentationError(400, 'points 最多 256 个，x/y 必须为有效原图坐标，label 必须为 0 或 1');
  if (body.kind !== undefined && !isElementKind(body.kind)) {
    throw new SegmentationError(400, 'kind 必须是受支持的 UI 元素类型');
  }
  return body;
}

async function fileExists(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function directoryExists(directory: string): Promise<boolean> {
  try { return (await fs.stat(directory)).isDirectory(); } catch { return false; }
}

async function runtimeFiles() {
  const [python, script, weights, site, source] = await Promise.all([
    fileExists(PYTHON),
    fileExists(SCRIPT),
    fileExists(WEIGHTS),
    directoryExists(SITE),
    directoryExists(SOURCE),
  ]);
  return { python, script, weights, site, source };
}

// Only fixed project paths and this fixed import probe are executable; HTTP never supplies commands.
function runPython(args: string[], input: string, timeoutMs: number, outputLimit = MAX_OUTPUT): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, args, {
      cwd: ROOT, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CUDA_VISIBLE_DEVICES: '', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        // kill() targets only the ChildProcess we own, never a global python process name.
        child.kill('SIGKILL');
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => finish(new SegmentationError(504, `本地分割进程超时（${timeoutMs}ms），已终止`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > outputLimit) {
        finish(new SegmentationError(502, '分割响应超过大小上限，已终止进程'));
        return;
      }
      if (!settled) stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', (error) => finish(new SegmentationError(503, `无法启动本地分割 runtime：${error.message}`)));
    child.stdin.on('error', (error) => finish(new SegmentationError(502, `分割 stdin 写入失败：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      let result: any;
      try { result = JSON.parse(stdout); } catch {
        finish(new SegmentationError(502, `分割 stdout 不是合法 JSON：${stderr || '无错误详情'}`));
        return;
      }
      if (code !== 0 || result?.ok === false) {
        const detail = String(result?.error?.message ?? result?.error ?? stderr ?? '未知错误').slice(0, 4096);
        const errorType = result?.error?.type;
        let status = 502;
        if (errorType === 'ValueError') status = 400;
        if (errorType === 'ModuleNotFoundError' || errorType === 'ImportError' || errorType === 'FileNotFoundError' || /ModuleNotFoundError|ImportError/.test(stderr)) status = 503;
        finish(new SegmentationError(status, `本地分割失败：${detail}`));
        return;
      }
      finish(undefined, result);
    });
    child.stdin.end(input);
  });
}

export async function segmentationHealth() {
  const files = await runtimeFiles();
  let importsAvailable = false;
  let detail = '缺少本地文件；请显式准备 .venv-seg、scripts/segment.py、SAM2.1 源码/依赖和权重，服务不会自动安装或下载';
  if (files.python) {
    try {
      const probe = await runPython([
        SCRIPT, '--health', '--site', SITE, '--source', SOURCE,
      ], '', 30_000, 64 * 1024) as { importsAvailable?: boolean };
      importsAvailable = probe?.importsAvailable === true;
      detail = importsAvailable ? '依赖 import 检查通过；未加载权重或执行推理' : '依赖 import 检查未通过';
    } catch (error) { detail = error instanceof Error ? error.message : String(error); }
  }
  const missing = Object.entries(files).filter(([, exists]) => !exists).map(([name]) => name);
  if (missing.length) detail = `缺少本地文件：${missing.join(', ')}；${detail}`;
  const available = files.python && files.script && files.weights && files.site && files.source && importsAvailable;
  return { available, files, importsAvailable, inferenceVerified: false, device: 'cpu', model: 'SAM2.1-small', status: detail };
}

function pngDimensions(encoded: unknown, width: number, height: number): boolean {
  if (typeof encoded !== 'string' || !encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) === width && bytes.readUInt32BE(20) === height;
}

async function segment(value: unknown): Promise<SegmentResult> {
  const { sourceImage, rect, points, kind = 'icon' } = validateRequest(value);
  let image: string;
  try { image = await readImage(sourceImage); } catch { throw new SegmentationError(404, '原图不存在或不可读'); }
  if (image.length > MAX_OUTPUT) throw new SegmentationError(413, '原图超过分割输入大小上限');
  const files = await runtimeFiles();
  if (!files.python || !files.script || !files.weights || !files.site || !files.source) {
    throw new SegmentationError(503, `本地分割缺少依赖文件：${Object.entries(files).filter(([, exists]) => !exists).map(([name]) => name).join(', ')}；不会自动安装或下载`);
  }
  const request = {
    imageBase64: image.slice(image.indexOf(',') + 1),
    bbox: [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h],
    points,
    kind,
  };
  const result = await runPython([
    SCRIPT, '--checkpoint', WEIGHTS, '--site', SITE, '--source', SOURCE, '--config', CONFIG,
  ], JSON.stringify(request), 120_000) as SegmentResult;
  if (!result || result.protocolVersion !== 2 || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || result.width <= 0 || result.height <= 0 ||
      result.width * result.height > 64_000_000 || !Number.isFinite(result.score) || !Number.isFinite(result.elapsedMs) || result.elapsedMs < 0 ||
      typeof result.model !== 'string' || !result.model || result.model.length > 128 ||
      !pngDimensions(request.imageBase64, result.width, result.height) ||
      !pngDimensions(result.maskBase64, result.width, result.height) || !pngDimensions(result.rgbaBase64, result.width, result.height)) {
    throw new SegmentationError(502, '分割响应协议无效：需要全原图尺寸的 mask/RGBA PNG 和有效元数据');
  }
  if (!isSegmentationDiagnostics(result, result.width, result.height) ||
      result.promptBounds.some((value, index) => value !== request.bbox[index])) {
    throw new SegmentationError(502, '分割响应几何或精修诊断无效：提示框、推理区域与输出框必须是原图内的有效整数边界');
  }
  return {
    protocolVersion: 2,
    width: result.width,
    height: result.height,
    maskBase64: result.maskBase64,
    rgbaBase64: result.rgbaBase64,
    score: result.score,
    elapsedMs: result.elapsedMs,
    model: result.model,
    chosenIndex: result.chosenIndex,
    candidates: result.candidates,
    promptBounds: result.promptBounds,
    inferenceBounds: result.inferenceBounds,
    maskBounds: result.maskBounds,
    outputBounds: result.outputBounds,
    quality: result.quality,
    refinement: result.refinement,
  };
}

async function readSegmentBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST) throw new SegmentationError(413, '分割请求体超过 64KiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new SegmentationError(400, '请求体不是合法 JSON'); }
}

export async function handleSegmentation(req: IncomingMessage, res: ServerResponse, health = false): Promise<void> {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== (health ? 'GET' : 'POST')) throw new SegmentationError(405, '不支持的方法');
    const result = health ? await segmentationHealth() : await segment(await readSegmentBody(req));
    res.statusCode = health && !(result as Awaited<ReturnType<typeof segmentationHealth>>).available ? 503 : 200;
    res.end(JSON.stringify(result));
  } catch (error) {
    res.statusCode = error instanceof SegmentationError ? error.status : 500;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : '分割服务异常' }));
  }
}
