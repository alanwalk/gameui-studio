import JSZip from 'jszip';
import { PACK_LIMITS, packFormat, packMime, validatePackPath, type PackInput } from './packTypes';

export async function decodePackImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = dataUrl;
  try { await image.decode(); } catch { throw new Error('图片损坏或浏览器无法解码'); }
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > PACK_LIMITS.pixels) {
    throw new Error(`图片尺寸无效或超过 ${PACK_LIMITS.pixels} 像素`);
  }
  return image;
}

export async function readPackImage(originalPath: string, blob: Blob): Promise<PackInput> {
  validatePackPath(originalPath);
  const format = packFormat(originalPath);
  if (!blob.size || blob.size > PACK_LIMITS.fileBytes) throw new Error(`${originalPath}：空文件或超过 20 MB`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(`data:${packMime(format)};base64,${String(reader.result).split(',')[1]}`);
    reader.onerror = () => reject(new Error(`无法读取 ${originalPath}`));
    reader.readAsDataURL(blob);
  });
  try {
    const image = await decodePackImage(dataUrl);
    return { originalPath, format, width: image.naturalWidth, height: image.naturalHeight, dataUrl };
  } catch (error) { throw new Error(`${originalPath}：${(error as Error).message}`); }
}

/** ZIP central directory is checked before JSZip normalizes names or inflates data. */
export function inspectPackZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < Math.max(0, bytes.length - 65557)) throw new Error('无效的 ZIP 目录');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('不支持分卷 ZIP');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 65535 || offset === 0xffffffff || count > PACK_LIMITS.files * 4) throw new Error('ZIP 条目超限或不支持 ZIP64');
  const paths = new Set<string>();
  let size = 0;
  let files = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const length = view.getUint16(offset + 28, true);
    const next = offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end) throw new Error('ZIP 目录损坏');
    const raw = bytes.subarray(offset + 46, offset + 46 + length);
    if (!(view.getUint16(offset + 8, true) & 0x800) && raw.some((value) => value > 127)) throw new Error('ZIP 文件名必须使用 UTF-8 编码');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    const directory = name.endsWith('/');
    validatePackPath(directory ? name.slice(0, -1) : name);
    const key = name.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new Error(`ZIP 路径重复：${name}`);
    paths.add(key);
    const unixType = view.getUint32(offset + 38, true) >>> 16 & 0xf000;
    if (unixType === 0xa000 || view.getUint16(offset + 8, true) & 1) throw new Error('不支持符号链接或加密 ZIP');
    if (!directory) {
      packFormat(name);
      const fileSize = view.getUint32(offset + 24, true);
      size += fileSize;
      files++;
      if (!fileSize || fileSize > PACK_LIMITS.fileBytes || size > PACK_LIMITS.totalBytes || files > PACK_LIMITS.files) throw new Error('ZIP 解压大小或素材数量超限');
    }
    offset = next;
  }
  if (!files) throw new Error('ZIP 中没有素材');
}

export async function importPack(files: File[]): Promise<PackInput[]> {
  if (!files.length) throw new Error('请选择素材文件夹或 ZIP');
  const entries: { path: string; blob: () => Promise<Blob>; size: number }[] = [];
  if (files.length === 1 && /\.zip$/i.test(files[0].name)) {
    if (files[0].size > PACK_LIMITS.totalBytes) throw new Error('ZIP 超过 100 MB');
    const bytes = new Uint8Array(await files[0].arrayBuffer());
    inspectPackZip(bytes);
    const zip = await JSZip.loadAsync(bytes);
    for (const entry of Object.values(zip.files)) {
      if (!entry.dir) entries.push({ path: entry.name, size: 0, blob: () => new Promise<Blob>((resolve, reject) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        // JSZip exposes entry streams at runtime but omits them from JSZipObject's declarations.
        const streamedEntry = entry as JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> };
        const stream = streamedEntry.internalStream('uint8array');
        stream.on('data', (chunk: Uint8Array) => {
          size += chunk.length;
          if (size > PACK_LIMITS.fileBytes) { stream.pause(); reject(new Error(`${entry.name} 解压大小超过 20 MB`)); return; }
          chunks.push(chunk);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(new Blob(chunks)));
        stream.resume();
      }) });
    }
  } else {
    for (const file of files) entries.push({ path: file.webkitRelativePath || file.name, size: file.size, blob: async () => file });
  }
  if (entries.length > PACK_LIMITS.files) throw new Error('素材数量超过 300');
  const seen = new Set<string>();
  let total = 0;
  const result: PackInput[] = [];
  for (const entry of entries) {
    validatePackPath(entry.path);
    const key = entry.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error(`素材路径重复：${entry.path}`);
    seen.add(key);
    packFormat(entry.path);
    if (entry.size > PACK_LIMITS.fileBytes) throw new Error(`${entry.path} 超过 20 MB`);
    const blob = await entry.blob();
    total += blob.size;
    if (total > PACK_LIMITS.totalBytes) throw new Error('素材包超过 100 MB');
    result.push(await readPackImage(entry.path, blob));
  }
  return result;
}
