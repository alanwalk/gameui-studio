import JSZip from 'jszip';
import type { Project, Rect, Screen, Settings, SliceTask } from '../types';
import { buildZip, nameExportElements, type ExportEntry } from './export';
import { loadImageElement } from './image';
import { imageUrl } from './magpie';
import { decodeElements } from './sliceTasks';

export const PAGE_EXPORT_SIZES = {
  original: null,
  '750x1334': { width: 750, height: 1334 },
  '1500x2668': { width: 1500, height: 2668 },
  '1334x750': { width: 1334, height: 750 },
  '2668x1500': { width: 2668, height: 1500 },
} as const;

export type PageExportOptions = {
  scope: 'current' | 'all';
  currentScreenId?: string;
  size: keyof typeof PAGE_EXPORT_SIZES;
};
type Size = { width: number; height: number };
export type PageTransform = {
  fit: 'contain';
  padding: 'transparent';
  sourceSize: Size;
  exportSize: Size;
  scale: number;
  offset: { x: number; y: number };
};
type PageAsset = ExportEntry & { id: string; approved: true; path: string; exportRect: Rect };
export type PageExportManifest = {
  schemaVersion: 1;
  project: Pick<Project, 'id' | 'name' | 'orientation' | 'size' | 'stylePrompt' | 'styleImage'>;
  options: PageExportOptions;
  settings: Pick<Settings, 'module' | 'includeTextAsImage'>;
  pages: {
    screenId: string;
    screenName: string;
    version: Screen['versions'][number];
    directory: string;
    image: string;
    transform: PageTransform;
    task?: Pick<SliceTask, 'id' | 'name' | 'status' | 'updatedAt' | 'source'>;
    review: { total: number; approved: number; exported: number };
    assets: PageAsset[];
    report: string;
  }[];
  skipped: { screenId: string; screenName: string; reason: string }[];
};

function safeSegment(value: string): string {
  const segment = value.normalize('NFKC').replace(/[^\p{L}\p{N}_-]/gu, '_').slice(0, 60);
  if (!segment || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(segment)) return `page_${segment}`;
  return segment;
}

export function pageExportDirectory(screen: Pick<Screen, 'id' | 'name'>, used: Set<string>): string {
  const base = `${safeSegment(screen.name)}--${safeSegment(screen.id)}`;
  let directory = base;
  let suffix = 2;
  while (used.has(directory.toLowerCase())) directory = `${base}_${suffix++}`;
  used.add(directory.toLowerCase());
  return directory;
}

function assertSize(size: Size): void {
  if (![size.width, size.height].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('图片尺寸无效');
  }
}

export function pageExportTransform(sourceSize: Size, exportSize: Size): PageTransform {
  assertSize(sourceSize);
  assertSize(exportSize);
  const scale = Math.min(exportSize.width / sourceSize.width, exportSize.height / sourceSize.height);
  const offset = {
    x: (exportSize.width - sourceSize.width * scale) / 2,
    y: (exportSize.height - sourceSize.height * scale) / 2,
  };
  return { fit: 'contain', padding: 'transparent', sourceSize, exportSize, scale, offset };
}

export function mapPageExportRect(rect: Rect, transform: PageTransform): Rect {
  return {
    x: rect.x * transform.scale + transform.offset.x,
    y: rect.y * transform.scale + transform.offset.y,
    w: rect.w * transform.scale,
    h: rect.h * transform.scale,
  };
}

async function encodePage(image: HTMLImageElement, transform: PageTransform): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = transform.exportSize.width;
  canvas.height = transform.exportSize.height;
  if (canvas.width !== transform.exportSize.width || canvas.height !== transform.exportSize.height) {
    throw new Error('导出画布尺寸不一致');
  }
  const context = canvas.getContext('2d');
  if (!context) throw new Error('无法创建导出画布');
  context.drawImage(image, transform.offset.x, transform.offset.y,
    transform.sourceSize.width * transform.scale, transform.sourceSize.height * transform.scale);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (!result || result.type !== 'image/png' || result.size === 0) reject(new Error('整图 PNG 编码失败'));
      else resolve(result);
    }, 'image/png');
  });
  const url = URL.createObjectURL(blob);
  try {
    const encoded = await loadImageElement(url);
    if (encoded.naturalWidth !== canvas.width || encoded.naturalHeight !== canvas.height) {
      throw new Error('整图 PNG 实际尺寸不一致');
    }
  } finally {
    URL.revokeObjectURL(url);
  }
  return blob;
}

async function loadTasks(): Promise<SliceTask[]> {
  const response = await fetch('/api/slice-tasks');
  if (!response.ok) throw new Error(`读取已存素材任务失败（HTTP ${response.status}）`);
  const payload = await response.json();
  if (payload.error || !Array.isArray(payload.tasks)) throw new Error(payload.error || '已存素材任务响应无效');
  return payload.tasks;
}

/** Reads saved tasks only. Unsaved editor changes must be saved by the caller first. */
export async function buildPageExport(project: Project, settings: Settings, options: PageExportOptions) {
  if (!Object.hasOwn(PAGE_EXPORT_SIZES, options.size)) throw new Error('不支持的导出尺寸');
  if (options.scope !== 'current' && options.scope !== 'all') throw new Error('不支持的导出范围');
  const screens = project.screens.filter((screen) => options.scope === 'all' || screen.id === options.currentScreenId);
  if (!screens.length) throw new Error('没有可导出的界面，请选择当前界面');
  const tasks = await loadTasks();
  const zip = new JSZip();
  const manifest: PageExportManifest = {
    schemaVersion: 1,
    project: { id: project.id, name: project.name, orientation: project.orientation, size: project.size,
      stylePrompt: project.stylePrompt, styleImage: project.styleImage },
    options: { ...options },
    settings: { module: settings.module, includeTextAsImage: settings.includeTextAsImage },
    pages: [], skipped: [],
  };
  // Assign against the entire project so current/all scopes produce identical paths.
  const usedDirectories = new Set<string>();
  const directories = new Map(project.screens.map((screen) => [screen, pageExportDirectory(screen, usedDirectories)]));
  for (const screen of screens) {
    const version = screen.activeVersionId
      ? screen.versions.find((entry) => entry.id === screen.activeVersionId)
      : screen.versions.at(-1);
    if (!version?.image) {
      manifest.skipped.push({ screenId: screen.id, screenName: screen.name,
        reason: '无图：当前版本不存在或尚未生成图片，已跳过' });
      continue;
    }
    try {
      const image = await loadImageElement(imageUrl(version.image));
      const sourceSize = { width: image.naturalWidth, height: image.naturalHeight };
      const exportSize = PAGE_EXPORT_SIZES[options.size] ?? sourceSize;
      const transform = pageExportTransform(sourceSize, exportSize);
      const directory = `pages/${directories.get(screen)!}`;
      const imagePath = `${directory}/page.png`;
      zip.file(imagePath, await encodePage(image, transform));
      const matchingTasks = tasks.filter(({ source }) => source.kind === 'project' &&
        source.projectId === project.id && source.screenId === screen.id &&
        source.versionId === version.id && source.sourceImage === version.image);
      if (matchingTasks.length > 1) throw new Error('同一版本存在多个素材任务，无法确定来源');
      const task = matchingTasks[0];
      const screenSettings = { ...settings, ...screen.assetSettings };
      const assets: PageAsset[] = [];
      zip.folder(`${directory}/assets/png`);
      if (task) {
        if (task.width !== sourceSize.width || task.height !== sourceSize.height) {
          throw new Error('素材任务尺寸与源图实际尺寸不一致，无法映射坐标');
        }
        // Same eligibility as nameExportElements; do not decode excluded images.
        const eligible = task.elements.filter((element) => element.approved && element.slice &&
          (element.kind !== 'text' || screenSettings.includeTextAsImage));
        for (const element of eligible) {
          const slice = element.slice!;
          const storedImage = await loadImageElement(imageUrl(slice.image));
          if (storedImage.naturalWidth !== slice.width || storedImage.naturalHeight !== slice.height) {
            throw new Error(`素材 PNG 实际尺寸不一致：${element.label}`);
          }
        }
        if (eligible.length) {
          const elements = await decodeElements(eligible);
          const named = nameExportElements(elements, screenSettings);
          const pack = await buildZip(elements, screenSettings);
          const assetZip = await JSZip.loadAsync(pack.blob);
          for (const file of Object.values(assetZip.files)) {
            if (!file.dir) zip.file(`${directory}/assets/${file.name}`, await file.async('uint8array'));
          }
          for (const [index, entry] of pack.entries.entries()) {
            assets.push({ ...entry, id: named[index].element.id, approved: true,
              path: `${directory}/assets/png/${entry.fileName}`,
              exportRect: mapPageExportRect(entry.source, transform) });
          }
        }
      }
      let report = `整图已导出；素材 ${assets.length} 项`;
      if (!task) report = '整图已导出；无素材：当前版本没有已存切图任务';
      else if (!assets.length) report = '整图已导出；无素材：没有符合审核、切图及文本图片设置的素材';
      const page: PageExportManifest['pages'][number] = {
        screenId: screen.id, screenName: screen.name, version, directory, image: imagePath, transform,
        task: task && { id: task.id, name: task.name, status: task.status, updatedAt: task.updatedAt, source: task.source },
        review: { total: task?.elements.length ?? 0,
          approved: task?.elements.filter((element) => element.approved).length ?? 0, exported: assets.length },
        assets, report,
      };
      manifest.pages.push(page);
      zip.file(`${directory}/manifest.json`, JSON.stringify(page, null, 2));
      const coords = assets.map((asset) => ({ file: asset.path, id: asset.id, layer: asset.layer,
        sourceRect: asset.source, exportRect: asset.exportRect, imageSize: asset.imageSize }));
      zip.file(`${directory}/coords.json`, JSON.stringify(coords, null, 2));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`界面「${screen.name}」（${screen.id}）导出失败：${message}`);
    }
  }
  if (!manifest.pages.length) throw new Error(`没有可导出的整图：${manifest.skipped.map((page) => `${page.screenName}：${page.reason}`).join('；')}`);
  const report = [
    `已导出 ${manifest.pages.length} 个界面；跳过 ${manifest.skipped.length} 个无图界面。`,
    ...manifest.pages.map((page) => `${page.screenName} → ${page.directory}：${page.report}`),
    ...manifest.skipped.map((page) => `${page.screenName}（${page.screenId}）：${page.reason}`),
  ].join('\n');
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('REPORT.txt', report);
  zip.file('README.txt', '整图为 PNG；contain 等比缩放，透明居中补边。\nmanifest.transform 记录实际源图尺寸、导出尺寸、scale、offset。\ncoords.sourceRect 是源图像素；exportRect 是导出整图像素，保留小数。\nassets/png 保留已存素材的原始分辨率，不随整图预设缩放；assets/coords.json 沿用原素材包的源图坐标。\n版本 styleSnapshot 为版本风格，project.stylePrompt/styleImage 为项目当前风格。\n仅导出当前版本、同源图的已存素材任务；编辑器未保存修改不包含在内。');
  return { blob: await zip.generateAsync({ type: 'blob' }),
    fileName: `ui-pages-${safeSegment(project.name)}-${options.size}.zip`, manifest, report };
}
