import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { CliError, protocol } from './options.mjs';

export const ROOT = new URL('../', import.meta.url);
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
export const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function readLimited(file, limit = MAX_IMAGE_BYTES) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new CliError(`输入必须是 ${limit} 字节以内的普通文件：${file}`, 'INVALID_INPUT', 2);
    const bytes = await handle.readFile();
    if (bytes.length > limit) throw new CliError('读取时输入文件超限', 'INVALID_INPUT', 2);
    return bytes;
  } finally { await handle.close(); }
}

export async function readJson(file) {
  const bytes = await readLimited(file, 8 * 1024 * 1024);
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new CliError(`无效的 JSON 文件：${file}`, 'INVALID_INPUT', 2); }
}

export async function sharpModule() { return (await import('sharp')).default; }

export async function decodeImage(bytes) {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new CliError('图片为空或超过 20 MB', 'INVALID_IMAGE', 2);
  const sharp = await sharpModule();
  const image = sharp(bytes, { failOn: 'warning', limitInputPixels: MAX_PIXELS });
  const metadata = await image.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) {
    throw new CliError('仅支持单帧 PNG / JPEG / WebP', 'INVALID_IMAGE', 2);
  }
  const normalized = await image.rotate().toColourspace('srgb').ensureAlpha().png().toBuffer({ resolveWithObject: true });
  if (normalized.data.length > MAX_IMAGE_BYTES) throw new CliError('规范化后的 PNG 超过 20 MB', 'INVALID_IMAGE', 2);
  return { png: normalized.data, width: normalized.info.width, height: normalized.info.height,
    dataUrl: `data:image/png;base64,${normalized.data.toString('base64')}` };
}

export async function readImage(file) {
  try { return { ...await decodeImage(await readLimited(file)), path: path.resolve(file) }; }
  catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`无法完整解码输入图片：${file}（${error.message}）`, 'INVALID_IMAGE', 2);
  }
}

export function base64Bytes(value) {
  protocol(typeof value === 'string' && value.length <= Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), '图片 base64 协议无效');
  const bytes = Buffer.from(value, 'base64');
  protocol(bytes.length > 0 && bytes.toString('base64') === value, '图片 base64 编码无效');
  return bytes;
}

export async function resultImage(dataUrl) {
  protocol(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,'), '服务未返回 PNG data URL');
  try { return await decodeImage(base64Bytes(dataUrl.slice('data:image/png;base64,'.length))); }
  catch (error) { throw new CliError(`生成图片无效：${error.message}`, 'INVALID_RESPONSE', 3); }
}

export function imagePlan(image) {
  return { file: image.path, width: image.width, height: image.height,
    sha256: createHash('sha256').update(image.png).digest('hex') };
}

async function existing(file) {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function preflightFile(file, force = false) {
  const target = path.resolve(file);
  const stat = await existing(target);
  if (stat && (!stat.isFile() || !force)) throw new CliError(`输出已存在或不是普通文件：${target}；普通文件可显式 --force`, 'OUTPUT_EXISTS', 2);
  await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
}

/** Publish a completed file; link gives no-overwrite semantics even under races. */
export async function writeFile(file, bytes, force = false) {
  const target = await preflightFile(file, force);
  const temporary = path.join(path.dirname(target), `.gameui-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    if (force) {
      const stat = await existing(target);
      if (stat && !stat.isFile()) throw new CliError('输出目标已变化，未覆盖', 'OUTPUT_EXISTS', 2);
      await fs.rename(temporary, target);
    } else {
      await fs.link(temporary, target);
    }
  } finally { await fs.rm(temporary, { force: true }); }
  return target;
}

export async function preflightDirectory(directory) {
  const target = path.resolve(directory);
  if (await existing(target)) throw new CliError(`输出目录已存在，请使用新目录：${target}`, 'OUTPUT_EXISTS', 2);
  await fs.mkdir(path.dirname(target), { recursive: true });
  return target;
}

export async function writeDirectory(directory, produce) {
  const target = await preflightDirectory(directory);
  const stage = await fs.mkdtemp(path.join(path.dirname(target), '.gameui-'));
  try {
    const result = await produce(stage);
    if (await existing(target)) throw new CliError('输出目录已被创建，未覆盖', 'OUTPUT_EXISTS', 2);
    await fs.rename(stage, target);
    return { ...result, outputDirectory: target };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

const loadedModules = new Map();
/** Reuse the repository's pure TS algorithms without a browser or a second implementation. */
export function sharedModule(name) {
  if (!['alphaComponents', 'segmentationTypes'].includes(name)) throw new Error('Unknown shared module');
  if (!loadedModules.has(name)) loadedModules.set(name, (async () => {
    const ts = (await import('typescript')).default;
    const source = await fs.readFile(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
    const parsed = ts.createSourceFile(`${name}.ts`, source, ts.ScriptTarget.ES2022, true);
    for (const statement of parsed.statements) {
      if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly ||
          ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        throw new Error(`${name} 新增了运行时依赖，需要更新 CLI 的共享模块加载方式`);
      }
    }
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    return import(`data:text/javascript;base64,${Buffer.from(output.outputText).toString('base64')}`);
  })());
  return loadedModules.get(name);
}
