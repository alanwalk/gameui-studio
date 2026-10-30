export type PackFormat = 'png' | 'jpeg' | 'webp';
export type PackStyle = { id?: string; name: string; prompt: string; image?: string };
export type PackInput = {
  /** Relative path in the original pack, including its unchanged extension. */
  originalPath: string;
  format: PackFormat;
  /** Display dimensions after EXIF orientation, not the raw JPEG frame dimensions. */
  width: number;
  height: number;
  dataUrl: string;
};
export type PackItem = Omit<PackInput, 'dataUrl'> & {
  id: string;
  originalImage: string;
  /** Server-derived metadata. Optional only for tasks written before full decoding. */
  encodedWidth?: number;
  encodedHeight?: number;
  orientation?: number;
  /** Oriented canonical PNG for generation; originalImage always retains exact source bytes. */
  referenceImage?: string;
  resultImage?: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
  error?: string;
  pendingId?: string;
  watchPath?: string;
  submitted?: boolean;
};
export type PackTask = {
  schemaVersion: 1;
  id: string;
  name: string;
  sourceTaskId?: string;
  style: PackStyle;
  items: PackItem[];
  status: 'idle' | 'running' | 'done' | 'interrupted';
  createdAt: number;
  updatedAt: number;
};
export const PACK_LIMITS = { files: 300, fileBytes: 20 * 1024 * 1024, totalBytes: 100 * 1024 * 1024, pixels: 16_777_216 };

export function validatePackPath(value: string): string {
  if (!value || value.length > 500 || value.includes('\\') || value.startsWith('/') ||
      /[\x00-\x1f\x7f:*?"<>|]/.test(value) || value.split('/').some((part) =>
        !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`不安全的素材路径：${value}`);
  }
  return value;
}
export function packFormat(fileName: string): PackFormat {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension === 'png' || extension === 'webp') return extension;
  if (extension === 'jpg' || extension === 'jpeg') return 'jpeg';
  throw new Error(`不支持的图片格式：${fileName}（仅 PNG/JPG/JPEG/WebP）`);
}
export function packMime(format: PackFormat): string { return `image/${format}`; }
