import JSZip from 'jszip';
import { decodePackImage } from './packImport';
import { packImageUrl } from './packApi';
import { packMime, validatePackPath, type PackItem, type PackTask } from './packTypes';

async function fetchImage(name: string): Promise<Blob> {
  // Browsers tolerate some truncated JPEGs; the server also applies the strict shared decoder.
  const response = await fetch(`${packImageUrl(name)}?validate=1`);
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.error || `无法读取或完整解码图片：${name}`);
  }
  return response.blob();
}
async function withImage<T>(blob: Blob, operation: (image: HTMLImageElement) => Promise<T>): Promise<T> {
  const url = URL.createObjectURL(blob);
  try { return await operation(await decodePackImage(url)); }
  finally { URL.revokeObjectURL(url); }
}
export async function encodePackResult(blob: Blob, item: PackItem): Promise<Blob> {
  const orientation = item.orientation ?? 1;
  const encodedWidth = item.encodedWidth ?? item.width;
  const encodedHeight = item.encodedHeight ?? item.height;
  if (orientation !== 1 && item.format !== 'jpeg') {
    throw new Error(`${item.originalPath}：此格式的 EXIF 方向暂不支持重新编码，将保留原文件与方向`);
  }
  const encoded = await withImage(blob, async (image) => {
    const canvas = document.createElement('canvas');
    canvas.width = encodedWidth;
    canvas.height = encodedHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建画布');
    if (item.format === 'jpeg') {
      context.fillStyle = '#fff';
      context.fillRect(0, 0, encodedWidth, encodedHeight);
    }
    // Undo the display orientation before encoding; the EXIF tag reapplies it when viewed.
    let displayTransform: DOMMatrix;
    switch (orientation) {
      case 1: displayTransform = new DOMMatrix(); break;
      case 2: displayTransform = new DOMMatrix([-1, 0, 0, 1, encodedWidth, 0]); break;
      case 3: displayTransform = new DOMMatrix([-1, 0, 0, -1, encodedWidth, encodedHeight]); break;
      case 4: displayTransform = new DOMMatrix([1, 0, 0, -1, 0, encodedHeight]); break;
      case 5: displayTransform = new DOMMatrix([0, 1, 1, 0, 0, 0]); break;
      case 6: displayTransform = new DOMMatrix([0, 1, -1, 0, encodedHeight, 0]); break;
      case 7: displayTransform = new DOMMatrix([0, -1, -1, 0, encodedHeight, encodedWidth]); break;
      case 8: displayTransform = new DOMMatrix([0, -1, 1, 0, 0, encodedWidth]); break;
      default: throw new Error(`无效的 EXIF 方向：${orientation}`);
    }
    context.setTransform(displayTransform.inverse());
    context.drawImage(image, 0, 0, item.width, item.height);
    const mime = packMime(item.format);
    const result = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => {
      if (!value || value.type !== mime) reject(new Error(`浏览器不支持 ${mime} 编码，未导出 ${item.originalPath}`));
      else resolve(value);
    }, mime, 0.95));
    return result;
  });
  let result = encoded;
  if (item.format === 'jpeg') {
    const bytes = new Uint8Array(await encoded.arrayBuffer());
    // Canvas strips metadata, so one minimal APP1/IFD0 Orientation entry is sufficient.
    const exif = new Uint8Array([
      0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0,
      73, 73, 42, 0, 8, 0, 0, 0, 1, 0,
      0x12, 1, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0, 0, 0, 0, 0,
    ]);
    result = new Blob([bytes.subarray(0, 2), exif, bytes.subarray(2)], { type: 'image/jpeg' });
  }
  await verifyPackSize(result, item);
  return result;
}
async function verifyPackSize(blob: Blob, item: PackItem): Promise<void> {
  await withImage(blob, async (image) => {
    if (image.naturalWidth !== item.width || image.naturalHeight !== item.height) throw new Error(`导出尺寸不一致：${item.originalPath}`);
  });
}
export async function exportPack(task: PackTask): Promise<{ blob: Blob; report: string }> {
  const zip = new JSZip();
  const successful: string[] = [];
  const originals: string[] = [];
  for (const item of task.items) {
    validatePackPath(item.originalPath);
    let blob: Blob;
    let fallbackReason = item.error || '尚未完成';
    let result: Blob | undefined;
    if (item.status === 'done' && item.resultImage) {
      try { result = await encodePackResult(await fetchImage(item.resultImage), item); }
      catch (error) { fallbackReason = `结果不可导出：${error instanceof Error ? error.message : String(error)}`; }
    }
    if (result) {
      blob = result;
      successful.push(item.originalPath);
    } else {
      blob = await fetchImage(item.originalImage);
      await verifyPackSize(blob, item);
      originals.push(`${item.originalPath}（${item.status}：${fallbackReason}；保留原文件字节）`);
    }
    zip.file(item.originalPath, blob);
  }
  const report = `换肤成功 ${successful.length} 项：\n${successful.join('\n')}\n\n保留原图 ${originals.length} 项：\n${originals.join('\n')}`;
  return { blob: await zip.generateAsync({ type: 'blob' }), report };
}
