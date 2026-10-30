import fs from 'node:fs/promises';
import path from 'node:path';
import { CliError, protocol } from './options.mjs';
import { sharedModule, sharpModule, imagePlan, jsonText, writeDirectory, decodeImage, base64Bytes, writeFile } from './io.mjs';

export async function splitSheet(image, directory, zipRequested) {
  const sharp = await sharpModule();
  const { analyzeAlphaSheetPixels } = await sharedModule('alphaComponents');
  const raw = await sharp(image.png).ensureAlpha().raw().toBuffer();
  let analysis;
  try { analysis = analyzeAlphaSheetPixels(new Uint8ClampedArray(raw), image.width, image.height); }
  catch (error) { throw new CliError(error.message, 'INVALID_SHEET', 5); }
  if (analysis.components.length > 1000) throw new CliError('组件数超过 1000，请拆成更小的图集', 'ASSET_LIMIT', 5);
  return writeDirectory(directory, async (stage) => {
    await fs.mkdir(path.join(stage, 'png'));
    await fs.writeFile(path.join(stage, 'source.png'), image.png);
    const manifest = {
      schemaVersion: 1, purpose: 'review-candidates', extractionMethod: 'alpha-components',
      source: imagePlan(image), coordinateSpace: 'sheet', approved: false,
      note: '只复制输入像素；不证明输入来自原图还是 AI。坐标是素材表坐标，不是原界面坐标。',
      assets: [], diagnostics: analysis.diagnostics,
    };
    const archive = zipRequested ? new (await import('jszip')).default() : undefined;
    let totalBytes = image.png.length;
    for (const [index, component] of analysis.components.entries()) {
      const file = `png/Component${String(index + 1).padStart(3, '0')}.png`;
      const { rect } = component;
      const png = await sharp(Buffer.from(component.rgba), { raw: { width: rect.w, height: rect.h, channels: 4 } }).png().toBuffer();
      totalBytes += png.length;
      if (totalBytes > 100 * 1024 * 1024) throw new CliError('切图总编码大小超过 100 MB', 'ASSET_LIMIT', 5);
      await fs.writeFile(path.join(stage, file), png);
      archive?.file(file, png);
      manifest.assets.push({ file, sourceRect: rect, width: rect.w, height: rect.h,
        pixelCount: component.pixelCount, componentCount: component.componentCount, approved: false });
    }
    await fs.writeFile(path.join(stage, 'manifest.json'), jsonText(manifest));
    await fs.writeFile(path.join(stage, 'diagnostics.json'), jsonText(analysis.diagnostics));
    if (archive) {
      archive.file('source.png', image.png);
      archive.file('manifest.json', jsonText(manifest));
      archive.file('diagnostics.json', jsonText(analysis.diagnostics));
      await fs.writeFile(path.join(stage, 'candidates.zip'), await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    }
    return { count: manifest.assets.length, approved: false, modelCalled: false,
      diagnostics: analysis.diagnostics, manifest: 'manifest.json', archive: archive ? 'candidates.zip' : undefined };
  });
}

export async function saveSegment(image, rect, result, directory) {
  const { isSegmentationDiagnostics } = await sharedModule('segmentationTypes');
  protocol(result?.protocolVersion === 2 && result.width === image.width && result.height === image.height &&
    isSegmentationDiagnostics(result, image.width, image.height), '分割 v2 协议、边界或精修诊断无效');
  const expectedPrompt = [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
  protocol(result.promptBounds.every((coordinate, index) => coordinate === expectedPrompt[index]), '分割返回了另一个目标的提示框');
  const rgba = await decodeImage(base64Bytes(result.rgbaBase64));
  const mask = await decodeImage(base64Bytes(result.maskBase64));
  protocol([rgba, mask].every((item) => item.width === image.width && item.height === image.height), '分割 PNG 尺寸与原图不一致');
  const [left, top, right, bottom] = result.outputBounds;
  const sourceRect = { x: left, y: top, w: right - left, h: bottom - top };
  const sharp = await sharpModule();
  // Use the full refined RGBA, not the original RGB with only its alpha replaced.
  const png = await sharp(rgba.png).extract({ left, top, width: sourceRect.w, height: sourceRect.h }).png().toBuffer();
  const metadata = {
    schemaVersion: 1, extractionMethod: 'segmentation', coordinateSpace: 'source', approved: false,
    source: imagePlan(image), sourceRect, model: result.model, score: result.score, elapsedMs: result.elapsedMs,
    promptBounds: result.promptBounds, inferenceBounds: result.inferenceBounds,
    maskBounds: result.maskBounds, outputBounds: result.outputBounds, quality: result.quality, refinement: result.refinement,
  };
  const saved = await writeDirectory(directory, async (stage) => {
    await fs.writeFile(path.join(stage, 'sprite.png'), png);
    await fs.writeFile(path.join(stage, 'full-rgba.png'), rgba.png);
    await fs.writeFile(path.join(stage, 'mask.png'), mask.png);
    await fs.writeFile(path.join(stage, 'manifest.json'), jsonText(metadata));
    return { sourceRect, approved: false, quality: result.quality, refinement: result.refinement };
  });
  if (result.quality.status === 'failed') {
    throw new CliError('分割质量检查失败；候选与诊断已保存，未标记审核通过', 'QUALITY_FAILED', 5, saved);
  }
  return saved;
}

function safeName(value, fallback) {
  const name = String(value ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return name || fallback;
}

export async function exportTask(task, client, options) {
  protocol(Array.isArray(task.elements) && task.elements.length <= 1000, '素材任务元素列表无效');
  const eligible = task.elements.filter((element) => element.approved === true && element.slice &&
    (element.kind !== 'text' || options['include-text']));
  if (!eligible.length) throw new CliError('没有已审核且有图片的可导出素材；文字图片默认排除', 'NOTHING_TO_EXPORT', 5);
  const archive = new (await import('jszip')).default();
  const entries = [];
  const usedNames = new Set();
  let totalBytes = 0;
  for (const element of eligible) {
    const slice = element.slice;
    protocol(typeof slice.image === 'string' && /^[A-Za-z0-9_-]+\.png$/.test(slice.image), '素材图片引用无效');
    protocol(Number.isSafeInteger(slice.width) && Number.isSafeInteger(slice.height) && slice.width > 0 && slice.height > 0,
      '素材尺寸无效');
    protocol(element.rect && ['x', 'y', 'w', 'h'].every((key) => Number.isSafeInteger(element.rect[key])) &&
      element.rect.x >= 0 && element.rect.y >= 0 && element.rect.w > 0 && element.rect.h > 0, '素材来源坐标无效');
    const bytes = await client.request(`/api/image?name=${encodeURIComponent(slice.image)}`, { binary: true, maxBytes: 20 * 1024 * 1024 });
    totalBytes += bytes.length;
    if (totalBytes > 100 * 1024 * 1024) throw new CliError('导出图片总大小超过 100 MB', 'ASSET_LIMIT', 5);
    const decoded = await decodeImage(bytes);
    protocol(decoded.width === slice.width && decoded.height === slice.height, `素材尺寸不符：${element.label}`);
    const state = element.state ? `_${safeName(element.state, 'Normal')}` : '';
    const base = `T_UI_${safeName(options.module, 'Common')}_${safeName(element.objectName, 'Asset')}${state}`;
    let name = `${base}.png`;
    let suffix = 2;
    while (usedNames.has(name.toLowerCase())) name = `${base}_${String(suffix++).padStart(2, '0')}.png`;
    usedNames.add(name.toLowerCase());
    archive.file(`png/${name}`, bytes); // Preserve persisted PNG bytes exactly.
    const coordinateSpace = element.coordinateSpace ?? (element.extractionMethod === 'ai-sheet' ? 'sheet' : 'source');
    protocol(coordinateSpace === 'source' || coordinateSpace === 'sheet', '未知坐标空间，拒绝推断原图坐标');
    entries.push({ id: element.id, fileName: name, label: element.label, kind: element.kind, approved: true,
      sourceRect: element.rect, coordinateSpace, originalScreenRect: coordinateSpace === 'sheet' ? null : element.rect,
      imageSize: { width: slice.width, height: slice.height },
      extractionMethod: element.extractionMethod, repainted: element.repainted === true || ['repaint', 'ai-sheet'].includes(element.extractionMethod),
      processingStatus: element.processingStatus, processingError: element.processingError,
      segmentationDiagnostics: element.segmentationDiagnostics, text: element.text, textPolicy: element.textPolicy });
  }
  const manifest = { schemaVersion: 1, taskId: task.id, source: task.source, assets: entries };
  archive.file('manifest.json', jsonText(manifest));
  archive.file('coords.json', jsonText(entries.map((entry) => ({ file: entry.fileName, coordinateSpace: entry.coordinateSpace,
    sourceRect: entry.sourceRect, originalScreenRect: entry.originalScreenRect }))));
  const output = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const outputFile = await writeFile(options.out, output, options.force);
  return { outputFile, count: entries.length, taskId: task.id, needsPlacement: entries.filter((entry) => entry.coordinateSpace === 'sheet').length };
}
