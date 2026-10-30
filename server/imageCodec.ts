import sharp from 'sharp';

export type DecodedImage = {
  format: 'png' | 'jpeg' | 'webp';
  /** Display dimensions, after applying EXIF orientation. */
  width: number;
  height: number;
  encodedWidth: number;
  encodedHeight: number;
  orientation: number;
  /** Fully decoded, oriented and re-encoded PNG without inherited metadata. */
  png: Buffer;
};

export async function decodeImage(
  bytes: Buffer,
  limits: { maxPixels?: number; maxBytes?: number } = {},
): Promise<DecodedImage> {
  const maxPixels = limits.maxPixels ?? 16_777_216;
  const maxBytes = limits.maxBytes ?? 20 * 1024 * 1024;
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('图片解码限额必须是正整数');
  }
  if (!bytes.length || bytes.length > maxBytes) throw new Error('图片为空或编码大小超限');
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: maxPixels });
    const metadata = await image.metadata();
    const format = metadata.format;
    if (format !== 'png' && format !== 'jpeg' && format !== 'webp') throw new Error('仅支持 PNG/JPEG/WebP');
    const encodedWidth = metadata.width;
    const encodedHeight = metadata.height;
    const orientation = metadata.orientation ?? 1;
    if (!encodedWidth || !encodedHeight || encodedWidth * encodedHeight > maxPixels ||
        orientation < 1 || orientation > 8 || (metadata.pages ?? 1) !== 1) throw new Error('尺寸、方向无效，像素超限或包含多帧');
    // toBuffer forces pixel decoding; metadata alone accepts truncated/invalid images.
    const normalized = await image.rotate().png().toBuffer({ resolveWithObject: true });
    if (!normalized.info.width || !normalized.info.height || normalized.info.width * normalized.info.height > maxPixels) {
      throw new Error('解码图片像素超限');
    }
    if (normalized.data.length > maxBytes) throw new Error('规范 PNG 编码大小超限');
    return { format, width: normalized.info.width, height: normalized.info.height,
      encodedWidth, encodedHeight, orientation, png: normalized.data };
  } catch (error) {
    throw new Error(`图片完整解码失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
