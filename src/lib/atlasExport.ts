import JSZip from 'jszip';
import { packImageUrl } from './packApi';
import { encodePackResult } from './packExport';
import type { PackTask } from './packTypes';
import { atlasOverlap, atlasRect, validateAtlasManifest, type AtlasImport, type AtlasJob } from './atlasTypes';
import { decodeAtlasPng, encodeAtlasPng, regionPagePoint, type AtlasPixels } from './atlasImport';

export const atlasFileUrl = (jobId: string, index: number) => `/api/atlas-jobs/${encodeURIComponent(jobId)}/files/${index}`;
export async function readAtlasJob(job: AtlasJob): Promise<AtlasImport> {
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < job.files.length; index++) {
    const response = await fetch(atlasFileUrl(job.id, index));
    if (!response.ok) throw new Error(`无法读取原文件：${job.files[index].path}`);
    files.set(job.files[index].path, new Uint8Array(await response.arrayBuffer()));
  }
  return { manifest: job.manifest, files };
}
export function validateAtlasTask(imported: AtlasImport, task: PackTask): void {
  const regions = imported.manifest.regions;
  if (task.items.length !== regions.length) throw new Error('Pack 任务 region 数量不符');
  const seen = new Set<string>();
  for (const item of task.items) {
    const region = regions.find(r => r.inputPath === item.originalPath);
    if (!region || seen.has(item.originalPath) || item.width !== region.sourceWidth || item.height !== region.sourceHeight || item.format !== 'png') throw new Error('Pack 任务 region 路径或尺寸不符');
    seen.add(item.originalPath);
  }
}

/** Only successful regions overwrite their own rectangles. Padding is an explicit, checked option. */
export async function exportAtlas(imported: AtlasImport, task?: PackTask, edgePixels = 0): Promise<{ blob: Blob; report: string; pages: Map<string, Blob> }> {
  const { manifest, files } = imported;
  validateAtlasManifest(manifest);
  if (task) validateAtlasTask(imported, task);
  if (![0, 1, 2, 4].includes(edgePixels)) throw new Error('边缘像素只能选择 0/1/2/4');
  const zip = new JSZip();
  for (const name of manifest.files) {
    const bytes = files.get(name);
    if (!bytes) throw new Error(`原文件缺失：${name}`);
    zip.file(name, bytes);
  }
  const pages = new Map<string, Blob>();
  const buffers = new Map<string, AtlasPixels>();
  const messages: string[] = [];
  let completed = 0;
  for (const region of manifest.regions) {
    const item = task?.items.find(entry => entry.originalPath === region.inputPath);
    if (item?.status !== 'done' || !item.resultImage) {
      messages.push(`${region.names.join(' / ')}：保留原像素（${item?.status ?? '未运行'} ${item?.error ?? ''}）`);
      continue;
    }
    if (edgePixels) {
      const expanded = atlasRect(region, edgePixels);
      const page = manifest.pages.find(page => page.path === region.pagePath)!;
      if (expanded.x < 0 || expanded.y < 0 || expanded.x + expanded.width > page.width || expanded.y + expanded.height > page.height ||
          manifest.regions.some(other => other !== region && other.pagePath === region.pagePath && atlasOverlap(expanded, atlasRect(other, edgePixels)))) throw new Error(`边缘复制会越界或碰到邻区：${region.names[0]}；请选择保留原边缘`);
    }
    // Read/decode failures retain the original rectangle; no partial writes occur before validation.
    let result: AtlasPixels;
    try {
      const response = await fetch(packImageUrl(item.resultImage));
      if (!response.ok) throw new Error('结果图片读取失败');
      const blob = await response.blob();
      result = await decodeAtlasPng(new Uint8Array(await blob.arrayBuffer()));
      if (result.width !== region.sourceWidth || result.height !== region.sourceHeight) {
        const fitted = await encodePackResult(blob, item);
        result = await decodeAtlasPng(new Uint8Array(await fitted.arrayBuffer()));
      }
    } catch (error) {
      messages.push(`${region.names.join(' / ')}：保留原像素（${(error as Error).message}）`);
      continue;
    }
    let page = buffers.get(region.pagePath);
    if (!page) {
      page = await decodeAtlasPng(files.get(region.pagePath)!);
      buffers.set(region.pagePath, page);
    }
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const [px, py] = regionPagePoint(region, x, y);
        const sourceOffset = ((region.top + y) * result.width + region.left + x) * 4;
        const targetOffset = (py * page.width + px) * 4;
        page.data.set(result.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
    if (edgePixels) {
      const rect = atlasRect(region);
      for (let y = -edgePixels; y < rect.height + edgePixels; y++) {
        for (let x = -edgePixels; x < rect.width + edgePixels; x++) {
          if (x >= 0 && x < rect.width && y >= 0 && y < rect.height) continue;
          const sourceX = rect.x + Math.max(0, Math.min(rect.width - 1, x));
          const sourceY = rect.y + Math.max(0, Math.min(rect.height - 1, y));
          const sourceOffset = (sourceY * page.width + sourceX) * 4;
          const targetOffset = ((rect.y + y) * page.width + rect.x + x) * 4;
          page.data.set(page.data.subarray(sourceOffset, sourceOffset + 4), targetOffset);
        }
      }
    }
    completed++;
    messages.push(`${region.names.join(' / ')}：已回填（共享矩形只处理一次）`);
  }
  for (const page of manifest.pages) {
    let bytes = files.get(page.path)!;
    const changed = buffers.get(page.path);
    if (changed) {
      bytes = await encodeAtlasPng(changed);
      zip.file(page.path, bytes);
    }
    pages.set(page.path, new Blob([bytes], { type: 'image/png' }));
  }
  return { blob: await zip.generateAsync({ type: 'blob' }), pages,
    report: `回填 ${completed} / ${manifest.regions.length} 个独立 region；边缘复制 ${edgePixels} 像素。描述与其他文件保持原始字节。\n${messages.join('\n')}` };
}
