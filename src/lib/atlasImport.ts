import JSZip from 'jszip';
import { type PackInput, validatePackPath } from './packTypes';
import { ATLAS_LIMITS, atlasOverlap, atlasRect, resolveAtlasPath, validateAtlasManifest, type AtlasImport, type AtlasManifest, type AtlasRegion } from './atlasTypes';

export type AtlasPixels = { width: number; height: number; data: Uint8Array };
const encoder = new TextEncoder();
function join(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of chunks) { result.set(part, offset); offset += part.length; }
  return result;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
async function transform(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) throw new Error('PNG 解码或编码大小超限');
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); }
  return join(chunks);
}

/** Raw PNG pixels avoid canvas alpha premultiplication changing untouched/transparent texels. */
export async function decodeAtlasPng(bytes: Uint8Array): Promise<AtlasPixels> {
  if (bytes.length < 57 || bytes.length > ATLAS_LIMITS.fileBytes || ![137,80,78,71,13,10,26,10].every((v, i) => bytes[i] === v)) throw new Error('图集页必须是有效 PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0; let height = 0; let channels = 0; let color = 0;
  let palette: Uint8Array | undefined; let alpha: Uint8Array | undefined;
  let ended = false;
  const compressed: Uint8Array[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = view.getUint32(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) throw new Error('PNG 数据块截断');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error('PNG CRC 校验失败');
    if (!width && type !== 'IHDR') throw new Error('PNG 缺少 IHDR');
    if (type === 'IHDR') {
      if (width || size !== 13) throw new Error('PNG IHDR 无效');
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); color = data[9];
      const channelCounts: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
      channels = channelCounts[color];
      if (!width || !height || width * height > ATLAS_LIMITS.pixels || !channels || data[8] !== 8 || data[10] || data[11] || data[12]) throw new Error('PNG 仅支持非交错 8-bit 灰度/RGB/索引/RGBA，或尺寸超限');
    } else if (type === 'IDAT') compressed.push(data);
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alpha = data;
    else if (type === 'IEND') { if (size) throw new Error('PNG IEND 无效'); ended = true; offset = end; break; }
    else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('暂不支持 APNG 图集');
    else if (type[0] === type[0].toUpperCase()) throw new Error(`不支持 PNG 数据块：${type}`);
    offset = end;
  }
  if (!ended || offset !== bytes.length || !compressed.length || (color === 3 && (!palette || palette.length % 3))) throw new Error('PNG 数据不完整');
  const stride = width * channels;
  const filtered = await transform(join(compressed), new DecompressionStream('deflate'), (stride + 1) * height);
  if (filtered.length !== (stride + 1) * height) throw new Error('PNG 像素长度不符');
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    if (filter > 4) throw new Error('PNG filter 无效');
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? raw[y * stride + x - channels] : 0;
      const up = y ? raw[(y - 1) * stride + x] : 0;
      const corner = y && x >= channels ? raw[(y - 1) * stride + x - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = left;
      else if (filter === 2) prediction = up;
      else if (filter === 3) prediction = Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - corner;
        const a = Math.abs(p - left); const b = Math.abs(p - up); const c = Math.abs(p - corner);
        if (a <= b && a <= c) prediction = left;
        else if (b <= c) prediction = up;
        else prediction = corner;
      }
      raw[y * stride + x] = filtered[y * (stride + 1) + x + 1] + prediction;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const start = i * channels;
    let r = raw[start]; let g = r; let b = r; let a = 255;
    if (color === 2 || color === 6) { g = raw[start + 1]; b = raw[start + 2]; }
    if (color === 4) a = raw[start + 1];
    if (color === 6) a = raw[start + 3];
    if (color === 3) {
      if (!palette || r * 3 + 2 >= palette.length) throw new Error('PNG 调色板索引越界');
      const index = r; r = palette[index * 3]; g = palette[index * 3 + 1]; b = palette[index * 3 + 2]; a = alpha?.[index] ?? 255;
    } else if (alpha && color === 0 && r === alpha[1]) a = 0;
    else if (alpha && color === 2 && r === alpha[1] && g === alpha[3] && b === alpha[5]) a = 0;
    pixels.set([r, g, b, a], i * 4);
  }
  return { width, height, data: pixels };
}
export async function encodeAtlasPng(image: AtlasPixels): Promise<Uint8Array> {
  if (image.data.length !== image.width * image.height * 4) throw new Error('PNG 像素长度不符');
  const header = new Uint8Array(13); const view = new DataView(header.buffer);
  view.setUint32(0, image.width); view.setUint32(4, image.height); header[8] = 8; header[9] = 6;
  const raw = new Uint8Array((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y++) raw.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), y * (image.width * 4 + 1) + 1);
  const chunk = (name: string, data: Uint8Array) => {
    const result = new Uint8Array(data.length + 12); const v = new DataView(result.buffer);
    v.setUint32(0, data.length); result.set(encoder.encode(name), 4); result.set(data, 8);
    v.setUint32(result.length - 4, crc32(result.subarray(4, result.length - 4))); return result;
  };
  const compressed = await transform(raw, new CompressionStream('deflate'), ATLAS_LIMITS.fileBytes);
  return join([new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array())]);
}
export function atlasDataUrl(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return `data:image/png;base64,${btoa(binary)}`;
}

type ObjectValue = Record<string, any>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('未知图集 schema：需要对象');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error('图集坐标必须是有限整数');
  return value;
}
function boolean(value: unknown): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error('旋转/trim 标记必须是 boolean');
  return value;
}
function unsupported(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(vertices|verticesUV|triangles|triangleIndices|polygon|polygons)$/i.test(key)) throw new Error('暂不支持 polygon 图集');
    if (/^(pma|premultiplyAlpha|premultipliedAlpha|premultiplied)$/i.test(key) && child !== false && child !== 'false' && child !== 0) throw new Error('暂不支持 PMA 图集');
    unsupported(child);
  }
}
function tuple(value: unknown, length: number): number[] {
  if (typeof value !== 'string' || !/^[\s{},+\-.\d]+$/.test(value)) throw new Error('无效的 plist/Spine 坐标');
  const parts = value.replace(/[{}]/g, '').split(',');
  if (parts.some(part => !part.trim())) throw new Error('坐标字段不能为空');
  const values = parts.map(v => Number(v.trim()));
  if (values.length !== length || values.some(v => !Number.isFinite(v))) throw new Error('坐标字段数量无效');
  return values;
}
/** Small strict plist XML reader shared with Node; no external entities or general XML execution. */
function parsePlistXml(text: string): unknown {
  if (/<!ENTITY|<!\[CDATA\[/i.test(text) || /<!DOCTYPE[^>]*\[/i.test(text)) throw new Error('禁止 plist XML 实体或 CDATA');
  const source = text.replace(/<!--[^]*?-->/g, '').replace(/^\s*<\?xml[^?]*\?>/, '').replace(/<!DOCTYPE\s+plist\s+PUBLIC\s+"[^"<>]*"\s+"[^"<>]*"\s*>/, '');
  const tokens = source.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== source) throw new Error('plist XML 损坏');
  let index = 0;
  const skip = () => { while (index < tokens.length && !tokens[index].trim()) index++; };
  const decode = (value: string) => {
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/i.test(value)) throw new Error('未知 XML 实体');
    return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (_, entity: string) => {
      const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      if (entity[0] !== '#') return named[entity];
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw new Error('XML 字符无效');
      return String.fromCodePoint(code);
    });
  };
  const read = (depth: number): { tag: string; value: any } => {
    skip();
    if (depth > 64) throw new Error('plist XML 嵌套超限');
    const opening = tokens[index++] ?? '';
    const match = /^<(dict|array|string|key|integer|real|true|false)\s*(\/?)>$/.exec(opening);
    if (!match) throw new Error('未知或无效的 plist XML 类型');
    const tag = match[1]; const empty = match[2] === '/';
    let value: any;
    if (tag === 'dict' || tag === 'array') {
      value = tag === 'dict' ? Object.create(null) : [];
      if (!empty) {
        skip();
        while (tokens[index] !== `</${tag}>`) {
          const child = read(depth + 1);
          if (tag === 'array') value.push(child.value);
          else {
            if (child.tag !== 'key' || Object.hasOwn(value, child.value)) throw new Error('plist 键无效或重复');
            value[child.value] = read(depth + 1).value;
          }
          skip();
        }
      }
    } else {
      let content = '';
      if (!empty) while (index < tokens.length && !tokens[index].startsWith('<')) content += tokens[index++];
      if (tag === 'true' || tag === 'false') {
        if (content.trim()) throw new Error('plist boolean 无效');
        value = tag === 'true';
      } else if (tag === 'real' || tag === 'integer') {
        if (!content.trim() || !Number.isFinite(Number(content))) throw new Error('plist 数值无效');
        value = Number(content);
      } else value = decode(content);
    }
    if (!empty && tokens[index++] !== `</${tag}>`) throw new Error('plist XML 结束标签不匹配');
    return { tag, value };
  };
  skip();
  if (!/^<plist(?:\s+version="1\.0")?\s*>$/.test(tokens[index++] ?? '')) throw new Error('缺少 plist XML 根节点');
  const result = read(0); skip();
  if (result.tag !== 'dict' || tokens[index++] !== '</plist>') throw new Error('plist XML 根节点无效');
  skip(); if (index !== tokens.length) throw new Error('plist XML 多余内容');
  return result.value;
}

export async function parseAtlasFiles(files: Map<string, Uint8Array>, descriptionPaths?: string[]): Promise<AtlasImport> {
  const manifest: AtlasManifest = { schemaVersion: 1, files: [...files.keys()], descriptions: [], pages: [], regions: [] };
  const descriptions = descriptionPaths ?? [...files.keys()].filter(p => /\.(json|plist|atlas)$/i.test(p));
  if (!descriptions.length || descriptions.length > ATLAS_LIMITS.files || new Set(descriptions).size !== descriptions.length) throw new Error('描述文件数量无效或路径重复');
  const pagePixels = new Map<string, AtlasPixels>();
  const addPage = async (description: string, reference: string, size?: number[]) => {
    const pagePath = resolveAtlasPath(description, reference);
    if (!/\.png$/i.test(pagePath)) throw new Error('图集页仅支持 PNG；无关文件保留原字节');
    const bytes = files.get(pagePath);
    if (!bytes) throw new Error(`缺少图集页：${pagePath}`);
    let image = pagePixels.get(pagePath);
    if (!image) {
      image = await decodeAtlasPng(bytes); pagePixels.set(pagePath, image);
      manifest.pages.push({ path: pagePath, width: image.width, height: image.height });
    }
    if (size && (size[0] !== image.width || size[1] !== image.height)) throw new Error(`描述与页尺寸不符：${pagePath}`);
    return pagePath;
  };
  const addRegion = (region: Omit<AtlasRegion, 'inputPath'>) => {
    validateAtlasManifest({ ...manifest, regions: [{ ...region, inputPath: 'atlas-regions/check.png' }] });
    for (const existing of manifest.regions) {
      if (existing.pagePath !== region.pagePath || !atlasOverlap(atlasRect(existing), atlasRect({ ...region, inputPath: '' }))) continue;
      if (existing.x !== region.x || existing.y !== region.y || existing.width !== region.width || existing.height !== region.height || existing.rotation !== region.rotation) throw new Error('部分重叠或不同旋转的共享矩形不支持');
      existing.names.push(...region.names);
      return;
    }
    manifest.regions.push({ ...region, inputPath: `atlas-regions/${String(manifest.regions.length).padStart(4, '0')}.png` });
    if (manifest.regions.length > ATLAS_LIMITS.regions) throw new Error('图集独立 region 超过 300');
  };
  for (const description of descriptions) {
    validatePackPath(description);
    const bytes = files.get(description);
    if (!bytes || bytes.length > ATLAS_LIMITS.descriptionBytes) throw new Error('描述文件缺失或超过 2 MB');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
    manifest.descriptions.push(description);
    if (/\.json$/i.test(description)) {
      const root = object(JSON.parse(text)); unsupported(root);
      let textures: ObjectValue[];
      if (Array.isArray(root.textures) && !root.frames) textures = root.textures.map(object);
      else if (root.frames && !root.textures) textures = [root];
      else throw new Error('未知 JSON atlas schema（仅 TexturePacker frames/textures）');
      for (const texture of textures) {
        const meta = texture.meta ?? root.meta ?? {};
        const image = texture.image ?? meta.image;
        const size = texture.size ?? meta.size;
        const pagePath = await addPage(description, image, size ? [integer(size.w), integer(size.h)] : undefined);
        const frames = texture.frames;
        if (!frames || typeof frames !== 'object') throw new Error('JSON 缺少 frames');
        const entries = Array.isArray(frames) ? frames.map(f => [f.filename, f] as const) : Object.entries(frames);
        for (const [name, raw] of entries) {
          if (typeof name !== 'string' || !name) throw new Error('frame 名称缺失');
          const frame = object(raw); const rect = object(frame.frame);
          const width = integer(rect.w); const height = integer(rect.h);
          const rotated = boolean(frame.rotated); const trimmed = boolean(frame.trimmed);
          let left = 0; let top = 0; let sourceWidth = width; let sourceHeight = height;
          if (trimmed) {
            const source = object(frame.sourceSize); const trim = object(frame.spriteSourceSize);
            sourceWidth = integer(source.w); sourceHeight = integer(source.h); left = integer(trim.x); top = integer(trim.y);
            if (trim.w !== undefined && integer(trim.w) !== width || trim.h !== undefined && integer(trim.h) !== height) throw new Error('JSON 裁尺寸与 frame 不符');
          }
          const aliases = frame.aliases ?? [];
          if (!Array.isArray(aliases) || aliases.some(a => typeof a !== 'string')) throw new Error('未知 alias schema');
          addRegion({ pagePath, names: [name, ...aliases], x: integer(rect.x), y: integer(rect.y), width, height, rotation: rotated ? 'cw90' : 'none', sourceWidth, sourceHeight, left, top });
        }
      }
    } else if (/\.plist$/i.test(description)) {
      if (text.startsWith('bplist')) throw new Error('不支持 binary plist，请导入 XML format 2/3');
      const root = object(parsePlistXml(text)); unsupported(root);
      const meta = object(root.metadata); const format = integer(meta.format);
      if (format !== 2 && format !== 3) throw new Error('plist 仅支持 XML format 2/3');
      const reference = meta.textureFileName || meta.realTextureFileName;
      const pagePath = await addPage(description, reference, meta.size ? tuple(meta.size, 2) : undefined);
      for (const [name, raw] of Object.entries(object(root.frames))) {
        const frame = object(raw);
        let rect: number[]; let source: number[]; let offset: number[]; let rotated: boolean;
        if (format === 2) {
          rect = tuple(frame.frame, 4); source = tuple(frame.sourceSize, 2); offset = tuple(frame.offset, 2); rotated = boolean(frame.rotated);
        } else {
          rect = tuple(frame.textureRect, 4); source = tuple(frame.spriteSourceSize, 2); offset = tuple(frame.spriteOffset, 2); rotated = boolean(frame.textureRotated);
          const spriteSize = tuple(frame.spriteSize, 2);
          // Cocos overrides textureRect.size with spriteSize before creating the frame.
          rect[2] = spriteSize[0]; rect[3] = spriteSize[1];
        }
        const [x, y, width, height] = rect;
        const aliases = frame.aliases ?? [];
        if (!Array.isArray(aliases) || aliases.some(a => typeof a !== 'string')) throw new Error('无效的 plist aliases');
        addRegion({ pagePath, names: [name, ...aliases], x, y, width, height, rotation: rotated ? 'cw90' : 'none', sourceWidth: source[0], sourceHeight: source[1], left: (source[0] - width) / 2 + offset[0], top: (source[1] - height) / 2 - offset[1] });
      }
    } else if (/\.atlas$/i.test(description)) {
      const lines = text.split(/\r\n|\r|\n/); let index = 0;
      const fields = (): Record<string, string> => {
        const result: Record<string, string> = Object.create(null);
        while (index < lines.length && lines[index].includes(':')) {
          const line = lines[index++].trim(); const colon = line.indexOf(':'); const key = line.slice(0, colon).trim();
          if (Object.hasOwn(result, key)) throw new Error('Spine 字段重复');
          result[key] = line.slice(colon + 1).trim();
        }
        return result;
      };
      while (index < lines.length) {
        if (!lines[index].trim()) { index++; continue; }
        const reference = lines[index++].trim(); const page = fields();
        if (Object.keys(page).some(k => !['size', 'format', 'filter', 'repeat', 'pma'].includes(k))) throw new Error('未知 Spine page schema');
        if (page.pma && page.pma !== 'false') throw new Error('暂不支持 PMA 图集');
        const pagePath = await addPage(description, reference, page.size ? tuple(page.size, 2) : undefined);
        while (index < lines.length && lines[index].trim()) {
          const name = lines[index++].trim(); const frame = fields();
          if (Object.keys(frame).some(k => !['bounds', 'xy', 'size', 'offsets', 'offset', 'orig', 'rotate', 'index', 'split', 'pad'].includes(k))) throw new Error('未知 Spine region schema');
          if (frame.bounds && (frame.xy || frame.size) || frame.offsets && (frame.offset || frame.orig)) throw new Error('Spine 新旧字段冲突');
          let bounds: number[];
          if (frame.bounds) bounds = tuple(frame.bounds, 4);
          else bounds = [...tuple(frame.xy, 2), ...tuple(frame.size, 2)];
          const [x, y, width, height] = bounds;
          let offsets = [0, 0, width, height];
          if (frame.offsets) offsets = tuple(frame.offsets, 4);
          else if (frame.orig || frame.offset) offsets = [...tuple(frame.offset ?? '0,0', 2), ...tuple(frame.orig ?? `${width},${height}`, 2)];
          const rotation = frame.rotate ?? 'false';
          if (!['true', 'false', '0', '90'].includes(rotation)) throw new Error('Spine 仅支持 rotate 0/90/true/false');
          let regionName = name;
          if (frame.index !== undefined) { if (!/^-?\d+$/.test(frame.index)) throw new Error('Spine index 无效'); regionName += ` [${frame.index}]`; }
          addRegion({ pagePath, names: [regionName], x, y, width, height, rotation: rotation === 'true' || rotation === '90' ? 'ccw90' : 'none', sourceWidth: offsets[2], sourceHeight: offsets[3], left: offsets[0], top: offsets[3] - height - offsets[1] });
        }
      }
    } else throw new Error('未知描述 schema');
  }
  validateAtlasManifest(manifest);
  return { manifest, files };
}

/** Validate the original central names before JSZip can sanitize traversal or collapse duplicates. */
export function inspectAtlasZip(bytes: Uint8Array): void {
  if (bytes.length < 22) throw new Error('ZIP 目录损坏');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  if (end < Math.max(0, bytes.length - 65557)) throw new Error('ZIP 目录损坏');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw new Error('不支持分卷 ZIP');
  const count = view.getUint16(end + 10, true); const directorySize = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true); let total = 0; let fileCount = 0;
  if (count === 65535 || offset === 0xffffffff || offset + directorySize !== end || count > ATLAS_LIMITS.files * 4) throw new Error('ZIP64、目录或条目超限');
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP 目录损坏');
    const length = view.getUint16(offset + 28, true); const flags = view.getUint16(offset + 8, true);
    const next = offset + 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
    if (next > end) throw new Error('ZIP 目录损坏');
    const raw = bytes.subarray(offset + 46, offset + 46 + length);
    if (!(flags & 0x800) && raw.some(v => v > 127)) throw new Error('ZIP 路径必须为 UTF-8');
    const name = new TextDecoder('utf-8', { fatal: true }).decode(raw); const directory = name.endsWith('/');
    validatePackPath(directory ? name.slice(0, -1) : name);
    const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('ZIP 路径重复'); seen.add(key);
    const type = view.getUint32(offset + 38, true) >>> 16 & 0xf000;
    if (flags & 1 || type === 0xa000 || view.getUint16(offset + 34, true)) throw new Error('禁止加密、符号链接或分卷 ZIP');
    if (!directory) {
      const size = view.getUint32(offset + 24, true); total += size; fileCount++;
      if (size > ATLAS_LIMITS.fileBytes || total > ATLAS_LIMITS.totalBytes || fileCount > ATLAS_LIMITS.files) throw new Error('ZIP 解压大小或文件数量超限');
    }
    offset = next;
  }
  if (offset !== end || !fileCount) throw new Error('ZIP 目录无效或为空');
}
export async function importAtlas(selected: File[], descriptions?: string[]): Promise<AtlasImport> {
  const files = new Map<string, Uint8Array>(); const seen = new Set<string>(); let total = 0;
  const add = (name: string, bytes: Uint8Array) => {
    validatePackPath(name); const key = name.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error('文件路径重复'); seen.add(key);
    total += bytes.length;
    if (bytes.length > ATLAS_LIMITS.fileBytes || total > ATLAS_LIMITS.totalBytes || files.size >= ATLAS_LIMITS.files) throw new Error('素材包文件或总大小超限');
    files.set(name, bytes);
  };
  if (selected.length === 1 && /\.zip$/i.test(selected[0].name)) {
    if (selected[0].size > ATLAS_LIMITS.totalBytes) throw new Error('ZIP 超过 100 MB');
    const bytes = new Uint8Array(await selected[0].arrayBuffer()); inspectAtlasZip(bytes);
    const zip = await JSZip.loadAsync(bytes);
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const parts: Uint8Array[] = []; let size = 0;
      const streamEntry = entry as JSZip.JSZipObject & { internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array> };
      const data = await new Promise<Uint8Array>((resolve, reject) => {
        const stream = streamEntry.internalStream('uint8array');
        stream.on('data', (part: Uint8Array) => {
          size += part.length;
          if (size > ATLAS_LIMITS.fileBytes || total + size > ATLAS_LIMITS.totalBytes) { stream.pause(); reject(new Error('ZIP 实际解压大小超限')); return; }
          parts.push(part);
        });
        stream.on('error', reject); stream.on('end', () => resolve(join(parts))); stream.resume();
      });
      add(entry.name, data);
    }
  } else {
    if (selected.length > ATLAS_LIMITS.files) throw new Error('文件数量超过 300');
    for (const file of selected) {
      if (file.size > ATLAS_LIMITS.fileBytes) throw new Error('文件超过 20 MB');
      add(file.webkitRelativePath || file.name, new Uint8Array(await file.arrayBuffer()));
    }
  }
  return parseAtlasFiles(files, descriptions);
}
export function regionPagePoint(region: AtlasRegion, x: number, y: number): [number, number] {
  if (region.rotation === 'cw90') return [region.x + region.height - 1 - y, region.y + x];
  if (region.rotation === 'ccw90') return [region.x + y, region.y + region.width - 1 - x];
  return [region.x + x, region.y + y];
}
export async function atlasPackInputs(imported: AtlasImport): Promise<PackInput[]> {
  validateAtlasManifest(imported.manifest);
  const result: PackInput[] = []; const pages = new Map<string, AtlasPixels>(); let total = 0;
  for (const region of imported.manifest.regions) {
    let page = pages.get(region.pagePath);
    if (!page) { page = await decodeAtlasPng(imported.files.get(region.pagePath)!); pages.set(region.pagePath, page); }
    const pixels = new Uint8Array(region.sourceWidth * region.sourceHeight * 4);
    for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
      const [px, py] = regionPagePoint(region, x, y);
      pixels.set(page.data.subarray((py * page.width + px) * 4, (py * page.width + px) * 4 + 4), ((region.top + y) * region.sourceWidth + region.left + x) * 4);
    }
    const bytes = await encodeAtlasPng({ width: region.sourceWidth, height: region.sourceHeight, data: pixels });
    total += bytes.length;
    if (bytes.length > ATLAS_LIMITS.fileBytes || total > ATLAS_LIMITS.totalBytes) throw new Error('region PNG 编码总大小超限');
    result.push({ originalPath: region.inputPath, width: region.sourceWidth, height: region.sourceHeight, format: 'png', dataUrl: atlasDataUrl(bytes) });
  }
  return result;
}
