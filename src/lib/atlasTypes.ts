import { PACK_LIMITS, validatePackPath } from './packTypes';

export type AtlasRegion = {
  inputPath: string;
  pagePath: string;
  names: string[];
  x: number; y: number;
  width: number; height: number;
  rotation: 'none' | 'cw90' | 'ccw90';
  sourceWidth: number; sourceHeight: number;
  left: number; top: number;
};
export type AtlasManifest = {
  schemaVersion: 1;
  files: string[];
  descriptions: string[];
  pages: { path: string; width: number; height: number }[];
  regions: AtlasRegion[];
};
export type AtlasFileRef = { path: string; image?: string; asset?: string };
export type AtlasJob = {
  id: string; name: string; manifest: AtlasManifest; files: AtlasFileRef[];
  packTaskId?: string; createdAt: number; updatedAt: number;
};
export type AtlasImport = { manifest: AtlasManifest; files: Map<string, Uint8Array> };
export const ATLAS_LIMITS = { ...PACK_LIMITS, descriptionBytes: 2 * 1024 * 1024, regions: 300 };

/** References may traverse a parent directory, but never escape the imported root. */
export function resolveAtlasPath(description: string, reference: string): string {
  validatePackPath(description);
  if (typeof reference !== 'string' || !reference || reference.includes('\\') || reference.startsWith('/')) throw new Error('不安全的图集页引用');
  const parts = description.split('/').slice(0, -1);
  for (const part of reference.split('/')) {
    if (part === '..') {
      if (!parts.length) throw new Error('图集页引用逃逸素材根目录');
      parts.pop();
    } else if (part !== '.') { validatePackPath(part); parts.push(part); }
  }
  return validatePackPath(parts.join('/'));
}
export function atlasRect(region: AtlasRegion, edge = 0) {
  let width = region.width;
  let height = region.height;
  if (region.rotation !== 'none') { width = region.height; height = region.width; }
  return { x: region.x - edge, y: region.y - edge, width: width + edge * 2, height: height + edge * 2 };
}
export function atlasOverlap(a: ReturnType<typeof atlasRect>, b: ReturnType<typeof atlasRect>) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
export function validateAtlasManifest(value: AtlasManifest): void {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files) || !value.files.length || value.files.length > ATLAS_LIMITS.files ||
      !Array.isArray(value.descriptions) || !value.descriptions.length || !Array.isArray(value.pages) || !value.pages.length ||
      !Array.isArray(value.regions) || !value.regions.length || value.regions.length > ATLAS_LIMITS.regions) throw new Error('无效的图集 manifest 或数量超限');
  const paths = new Set<string>();
  for (const name of value.files) {
    validatePackPath(name);
    const key = name.normalize('NFC').toLowerCase();
    if (paths.has(key)) throw new Error(`路径重复：${name}`);
    paths.add(key);
  }
  const files = new Set(value.files);
  const descriptions = new Set(value.descriptions);
  if (descriptions.size !== value.descriptions.length) throw new Error('描述路径重复');
  for (const name of descriptions) if (!files.has(name) || !/\.(json|plist|atlas)$/i.test(name)) throw new Error('描述文件缺失或格式未知');
  const pages = new Map<string, AtlasManifest['pages'][number]>();
  for (const page of value.pages) {
    if (!files.has(page.path) || !/\.png$/i.test(page.path) || pages.has(page.path) || !Number.isInteger(page.width) || !Number.isInteger(page.height) ||
        page.width < 1 || page.height < 1 || page.width * page.height > ATLAS_LIMITS.pixels) throw new Error('图集页缺失、重复、格式或尺寸无效（页仅支持 PNG）');
    pages.set(page.path, page);
  }
  const inputs = new Set<string>();
  let sourcePixels = 0;
  for (const region of value.regions) {
    validatePackPath(region.inputPath);
    const page = pages.get(region.pagePath);
    const fields = [region.x, region.y, region.width, region.height, region.sourceWidth, region.sourceHeight, region.left, region.top];
    if (!page || fields.some(n => !Number.isInteger(n)) || !['none', 'cw90', 'ccw90'].includes(region.rotation) ||
        !Array.isArray(region.names) || !region.names.length || region.names.length > 1000 || region.names.some(n => typeof n !== 'string' || !n || n.length > 500) ||
        region.width < 1 || region.height < 1 || region.sourceWidth < 1 || region.sourceHeight < 1 || region.left < 0 || region.top < 0 ||
        region.left + region.width > region.sourceWidth || region.top + region.height > region.sourceHeight) throw new Error('region 尺寸、旋转或 trim 越界');
    const rect = atlasRect(region);
    sourcePixels += region.sourceWidth * region.sourceHeight;
    if (sourcePixels > ATLAS_LIMITS.pixels * 4 || region.sourceWidth * region.sourceHeight > ATLAS_LIMITS.pixels) throw new Error('region 总像素超限');
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > page.width || rect.y + rect.height > page.height) throw new Error(`region 超出图集页：${region.names[0]}`);
    if (inputs.has(region.inputPath.toLowerCase())) throw new Error('region PackInput 路径重复');
    inputs.add(region.inputPath.toLowerCase());
  }
  for (let i = 0; i < value.regions.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = value.regions[i]; const b = value.regions[j];
      if (a.pagePath === b.pagePath && atlasOverlap(atlasRect(a), atlasRect(b))) throw new Error('region 重叠：共享矩形必须先合并，禁止覆盖邻区');
    }
  }
}
