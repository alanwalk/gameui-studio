import JSZip from 'jszip';
import type { Settings, UiElement } from '../types';
import { canvasToDataUrl } from './image';
import { suggestNineSlice } from './geometry';
import { buildFileName, safeModuleName } from './naming';
import { IMPORTER_SCRIPT, README_NOTE } from './templates';

export type ExportEntry = {
  fileName: string;
  /** Unity destination: Assets/Art/Textures/UI/<Module>/<file>.png */
  unityPath: string;
  source: { x: number; y: number; w: number; h: number };
  kind: string;
  label: string;
  description: string;
  state: string;
  layer: number;
  occluded: boolean;
  repainted: boolean;
  extractionMethod?: UiElement['extractionMethod'];
  processingStatus?: UiElement['processingStatus'];
  processingError?: string;
  imageSize: { width: number; height: number };
  /** Full PNG maps to source rect; differing sizes mean scaling, not an inferred trim. */
  sourceMapping: { source: UiElement['rect']; destination: UiElement['rect'] };
  text?: string;
  nineSlice: ReturnType<typeof suggestNineSlice>;
};

export function buildEntries(elements: UiElement[], settings: Settings): ExportEntry[] {
  return collectAssets(elements, settings).map((asset) => asset.entry);
}

/** Shared by export and reskin: filter and assign each element's actual ZIP name once. */
export function nameExportElements(
  elements: UiElement[],
  settings: Pick<Settings, 'module' | 'includeTextAsImage'>,
) {
  const moduleDir = safeModuleName(settings.module);
  const usedNames = new Set<string>();

  return elements
    .filter((element) => element.approved && element.slice &&
      (element.kind !== 'text' || settings.includeTextAsImage))
    .map((element) => {
      // Keep paths flat even for legacy or manually edited names.
      const baseFileName = buildFileName(moduleDir, element.objectName, element.state)
        .replace(/[^A-Za-z0-9_.-]/g, '_');
      let fileName = baseFileName;
      let suffix = 2;
      while (usedNames.has(fileName.toLowerCase())) {
        fileName = `${baseFileName.slice(0, -4)}_${String(suffix).padStart(2, '0')}.png`;
        suffix++;
      }
      usedNames.add(fileName.toLowerCase());
      return { element, fileName, moduleDir };
    });
}

function collectAssets(elements: UiElement[], settings: Settings) {
  return nameExportElements(elements, settings).map(({ element, fileName, moduleDir }) => {
    const slice = element.slice!;
    const dimensions = [slice.width, slice.height, slice.canvas.width, slice.canvas.height,
      element.rect.w, element.rect.h];
    if (dimensions.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
        !Number.isFinite(element.rect.x) || !Number.isFinite(element.rect.y)) {
      throw new Error(`素材尺寸无效：${element.label}`);
    }
    if (slice.canvas.width !== slice.width || slice.canvas.height !== slice.height) {
      throw new Error(`画布与切片尺寸不一致：${element.label}`);
    }
    const quietEdge = slice.border.dirtySides.length === 0;

    const entry = {
      fileName,
      unityPath: `Assets/Art/Textures/UI/${moduleDir}/${fileName}`,
      source: element.rect,
      kind: element.kind,
      label: element.label,
      description: element.description,
      state: element.state,
      layer: element.layer,
      occluded: element.occluded,
      repainted: element.repainted === true || element.extractionMethod === 'repaint',
      extractionMethod: element.extractionMethod,
      processingStatus: element.processingStatus,
      processingError: element.processingError,
      imageSize: { width: slice.width, height: slice.height },
      sourceMapping: {
        source: element.rect,
        destination: { x: 0, y: 0, w: slice.width, h: slice.height },
      },
      text: element.text,
      nineSlice: suggestNineSlice(element, quietEdge),
    } satisfies ExportEntry;
    return { slice, entry };
  });
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  if (!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    throw new Error('素材未生成有效的 PNG 数据');
  }
  const comma = dataUrl.indexOf(',');
  const base64 = dataUrl.slice(comma + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function buildZip(
  elements: UiElement[],
  settings: Settings,
): Promise<{ blob: Blob; entries: ExportEntry[]; fileName: string }> {
  const assets = collectAssets(elements, settings);
  if (assets.length === 0) throw new Error('没有可导出的图片：请确认审核、切图和文本图片开关');
  const entries = assets.map((asset) => asset.entry);
  const zip = new JSZip();
  const pngFolder = zip.folder('png');
  if (!pngFolder) throw new Error('无法创建 zip 目录');

  for (const { slice, entry } of assets) {
    pngFolder.file(entry.fileName, dataUrlToBytes(canvasToDataUrl(slice.canvas)));
  }

  zip.file('manifest.json', JSON.stringify(entries, null, 2));
  zip.file(
    'coords.json',
    JSON.stringify(
      entries.map((entry) => ({
        file: entry.fileName,
        x: entry.source.x,
        y: entry.source.y,
        w: entry.source.w,
        h: entry.source.h,
        layer: entry.layer,
      })),
      null,
      2,
    ),
  );
  zip.file('GameUiSliceImporter.cs', IMPORTER_SCRIPT);
  zip.file('README.md', README_NOTE);

  const blob = await zip.generateAsync({ type: 'blob' });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '');
  return { blob, entries, fileName: `ui-assets-${safeModuleName(settings.module)}-${stamp}.zip` };
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
