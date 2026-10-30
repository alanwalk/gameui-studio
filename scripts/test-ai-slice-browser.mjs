import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import JSZip from 'jszip';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { browserLaunchOptions } from './browser-options.mjs';

// This is a browser integration test, not a request to a paid image provider.
// An optional real generated RGBA sheet exercises the same UI/persistence/export path.
const fixturePath = process.env.GAMEUI_AI_SHEET_FIXTURE;
const origin = 'http://127.0.0.1:5174';
await fs.mkdir('.data', { recursive: true });
const evidenceDirectory = await fs.mkdtemp('./.data/ai-slice-browser-');
const sourceImage = await sharp({
  create: { width: 120, height: 200, channels: 4, background: '#315b7a' },
}).png().toBuffer();

function syntheticSheet() {
  const width = 240, height = 200;
  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < 9; index++) {
    const left = 12 + (index % 3) * 76, top = 12 + Math.floor(index / 3) * 62;
    for (let y = 0; y < 36; y++) for (let x = 0; x < 44; x++) {
      // Include a hollow frame whose empty interior must stay transparent.
      if (index === 0 && x > 5 && x < 38 && y > 5 && y < 30) continue;
      const edge = x === 0 || y === 0 || x === 43 || y === 35;
      pixels.set([24 + index * 20, 150, 210 - index * 12, edge ? 64 : 255], ((top + y) * width + left + x) * 4);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

const sheetImage = fixturePath ? await fs.readFile(fixturePath) : await syntheticSheet();
const sheet = await sharp(sheetImage).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
assert.ok(sheet.data.some((value, index) => index % 4 === 3 && value === 0), 'fixture must have a genuinely transparent background');
assert.ok(sheet.data.some((value, index) => index % 4 === 3 && value > 0 && value < 255), 'fixture must exercise soft alpha edges');
const project = {
  id: 'ai-slice-project', name: 'AI 拆图测试', size: { w: 1080, h: 1920 },
  orientation: 'portrait', stylePrompt: '', createdAt: 1, updatedAt: 1,
  screens: [{ id: 'screen', name: '主界面', usage: '', layout: [], activeVersionId: 'v-source',
    versions: [{ id: 'v-source', image: 'source.png', prompt: '原始界面', createdAt: 1 }] }],
};
const images = new Map([['source.png', sourceImage]]);
const unexpectedRequests = [], blockedStaticRequests = [], errors = [], savedTasks = [];
let sheetRequest, originalSheetFile, projectWrites = 0, sliceTasks = [], uploadCount = 0;
let detectCalls = 0, segmentCalls = 0, sheetCalls = 0, ownedServer, browser;

async function waitUntil(predicate, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
}

async function startFrontendIfNeeded() {
  try {
    const response = await fetch(origin, { signal: AbortSignal.timeout(1200) });
    if (response.ok) return;
    throw new Error(`Existing server at ${origin} returned HTTP ${response.status}`);
  } catch (error) {
    if (error.message?.startsWith('Existing server')) throw error;
  }
  // Do not import the application server's provider/API plugin in an isolated UI test.
  ownedServer = await createServer({
    configFile: false, root: process.cwd(), plugins: [react()], logLevel: 'error',
    cacheDir: path.resolve(evidenceDirectory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 5174, strictPort: true, hmr: false,
      watch: { ignored: ['**/.data/**', '**/.venv/**'] } },
  });
  await ownedServer.listen();
}

async function verifyIndependentPixels(elements) {
  const ownership = new Uint8Array(sheet.info.width * sheet.info.height);
  let retainedPixels = 0, softPixels = 0, sourceVisiblePixels = 0;
  for (let index = 3; index < sheet.data.length; index += 4) if (sheet.data[index]) sourceVisiblePixels++;
  for (const element of elements) {
    const image = images.get(element.slice.image);
    assert.ok(image, `persisted PNG exists for ${element.label}`);
    const output = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(output.info.width, element.rect.w);
    assert.equal(output.info.height, element.rect.h);
    let visible = 0;
    for (let y = 0; y < output.info.height; y++) for (let x = 0; x < output.info.width; x++) {
      const alpha = output.data[(y * output.info.width + x) * 4 + 3];
      if (!alpha) continue;
      const sx = element.rect.x + x, sy = element.rect.y + y;
      assert.ok(sx >= 0 && sy >= 0 && sx < sheet.info.width && sy < sheet.info.height);
      const sourceIndex = sy * sheet.info.width + sx;
      assert.equal(ownership[sourceIndex], 0, `pixel (${sx}, ${sy}) must belong to exactly one exported asset`);
      assert.equal(alpha, sheet.data[sourceIndex * 4 + 3], 'browser persistence must retain the original continuous alpha');
      ownership[sourceIndex] = 1;
      visible++; retainedPixels++;
      if (alpha < 255) softPixels++;
    }
    assert.ok(visible > 0, 'each asset contains actual assigned pixels');
  }
  assert.ok(softPixels > 0, 'semi-transparent pixels survive slicing and PNG persistence');
  assert.ok(retainedPixels / sourceVisiblePixels > 0.99, 'the major asset pixels survive the full browser path');
  const unassignedPixels = sourceVisiblePixels - retainedPixels;
  if (unassignedPixels) {
    assert.ok(elements.every(element => element.qualityWarnings?.length), 'unassigned support must surface a quality warning');
  }
  return { retainedPixels, sourceVisiblePixels, softPixels, unassignedPixels };
}

try {
  await startFrontendIfNeeded();
  browser = await chromium.launch(browserLaunchOptions());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.hostname === 'fonts.googleapis.com' && url.pathname === '/css2') {
      // The application's optional web font must not introduce network access in a fixture test.
      blockedStaticRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.fulfill({ contentType: 'text/css', body: '' }); return;
    }
    if (url.origin !== origin) {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort(); return;
    }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    const json = payload => route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
    switch (url.pathname) {
      case '/api/health': return json({ gateway: true, status: 'fixture only', visionModel: 'test-vision' });
      case '/api/models': return json({ models: [] });
      case '/api/styles': return json({ styles: [] });
      case '/api/project-render/tasks': return json([]);
      case '/api/segment-health': return json({ available: true });
      case '/api/projects':
        if (request.method() === 'PUT') { projectWrites++; Object.assign(project, request.postDataJSON().project); }
        return json({ projects: [project] });
      case '/api/slice-tasks':
        if (request.method() !== 'GET') {
          sliceTasks = [request.postDataJSON().task];
          savedTasks.push(structuredClone(sliceTasks[0]));
        }
        return json({ tasks: sliceTasks });
      case '/api/ai-slice-sheet':
        sheetCalls++; sheetRequest = request.postDataJSON();
        return json({ dataUrl: `data:image/png;base64,${sheetImage.toString('base64')}` });
      case '/api/upload': {
        const body = request.postDataJSON();
        assert.match(body.image, /^data:image\/png;base64,/);
        const fileName = `fixture-upload-${String(++uploadCount).padStart(3, '0')}.png`;
        images.set(fileName, Buffer.from(body.image.split(',')[1], 'base64'));
        if (uploadCount === 1) originalSheetFile = fileName;
        return json({ fileName });
      }
      case '/api/image': {
        const image = images.get(url.searchParams.get('name'));
        if (image) return route.fulfill({ contentType: 'image/png', body: image });
        break;
      }
      case '/api/detect': detectCalls++; break;
      case '/api/segment': segmentCalls++; break;
    }
    unexpectedRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Unexpected API call in isolated fixture test' }) });
  });

  async function openResourceEditor() {
    await page.getByRole('main', { name: '首页', exact: true }).waitFor();
    await page.locator('.home-project-open').click();
    const card = page.locator('.screen-card');
    await card.waitFor();
    await card.locator('.screen-preview-frame').last().hover();
    await card.getByRole('button', { name: '编辑资源', exact: true }).click();
    const editor = page.getByRole('dialog', { name: '资源编辑器', exact: true });
    await editor.waitFor();
    return editor;
  }

  async function downloadPageExport(editor, label) {
    await editor.getByRole('button', { name: '下载当前页', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出资源', exact: true });
    await dialog.waitFor();
    const downloaded = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '导出整页资源 ZIP', exact: true }).click();
    const download = await downloaded;
    assert.match(download.suggestedFilename(), /^ui-pages-.*\.zip$/);
    const target = path.join(evidenceDirectory, `${label}.zip`);
    await download.saveAs(target);
    const zip = await JSZip.loadAsync(await fs.readFile(target));
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    await dialog.getByRole('button', { name: '关闭导出资源', exact: true }).click();
    return { zip, manifest };
  }

  await page.goto(origin);
  let editor = await openResourceEditor();
  await editor.getByRole('button', { name: 'AI 拆图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 拆图', exact: true });
  await dialog.waitFor();
  const prompt = dialog.getByLabel('拆分要求', { exact: true });
  assert.ok((await prompt.inputValue()).includes('透明背景'));
  await prompt.fill('重点拆分按钮和图标，按类别整齐排列');
  await dialog.getByRole('button', { name: '生成拆图素材表', exact: true }).click();
  await page.waitForFunction(() => document.body.textContent?.includes('AI 拆图完成'));
  await page.waitForFunction(() => document.querySelectorAll('.atlas-sprite').length === 9);
  await waitUntil(() => sliceTasks[0]?.elements.length === 9, 'nine assets must be persisted');
  assert.equal(sheetCalls, 1);
  assert.equal(sheetRequest.size, '1024x1536');
  assert.ok(sheetRequest.reference.startsWith('data:image/png;base64,'));
  assert.ok(sheetRequest.prompt.includes('透明背景'));
  assert.ok(sheetRequest.prompt.includes('重点拆分按钮和图标'));
  assert.equal(projectWrites, 0, 'a generated sheet must not replace the source screen or create a new version');
  assert.equal(project.screens[0].versions.length, 1);
  assert.equal(sliceTasks[0].width, 120);
  assert.equal(sliceTasks[0].height, 200);
  assert.equal(sliceTasks[0].source.sourceImage, 'source.png');
  assert.deepEqual(images.get(originalSheetFile), sheetImage, 'the complete original sheet is saved byte-for-byte for recovery');
  const pending = structuredClone(sliceTasks[0]);
  for (const element of pending.elements) {
    assert.equal(element.approved, false, 'generation must not grant human approval');
    assert.equal(element.extractionMethod, 'ai-sheet');
    assert.equal(element.coordinateSpace, 'sheet');
    assert.equal(element.repainted, true);
    assert.equal(element.sourceSheetImage, originalSheetFile);
    assert.notEqual(element.slice.image, originalSheetFile, 'individual asset upload must not overwrite the source sheet');
  }
  const pixelSummary = await verifyIndependentPixels(pending.elements);
  await page.screenshot({ path: path.join(evidenceDirectory, 'pending-review.png') });
  const before = await downloadPageExport(editor, 'before-review');
  assert.deepEqual(before.manifest.pages[0].review, { total: 9, approved: 0, exported: 0 });
  assert.equal(before.manifest.pages[0].assets.length, 0, 'unreviewed assets stay out of exported PNGs');
  assert.equal(Object.keys(before.zip.files).filter(name => /\/assets\/png\/[^/]+\.png$/.test(name)).length, 0);

  for (let index = 0; index < 9; index++) {
    await editor.locator('.atlas-sprite').nth(index).click();
    const asset = page.getByRole('dialog', { name: '素材修正', exact: true });
    await asset.waitFor();
    assert.equal(await asset.getByLabel('审核通过', { exact: true }).isChecked(), false);
    assert.ok((await asset.getByLabel('素材质量检查', { exact: true }).textContent()).includes('待审核'));
    const originalLink = asset.getByRole('link', { name: '查看保留的原始组件表', exact: true });
    assert.equal(new URL(await originalLink.getAttribute('href'), origin).searchParams.get('name'), originalSheetFile);
    assert.equal(await asset.getByRole('button', { name: '按此框从原图色键提取', exact: true }).count(), 0,
      'sheet coordinates must not be used to recut the original screen');
    await asset.getByLabel('审核通过', { exact: true }).check();
    await asset.getByRole('button', { name: '关闭', exact: true }).click();
    await waitUntil(() => sliceTasks[0]?.elements.filter(element => element.approved).length === index + 1, 'review status must persist');
  }
  const after = await downloadPageExport(editor, 'after-review');
  const exportedPage = after.manifest.pages[0];
  assert.deepEqual(exportedPage.review, { total: 9, approved: 9, exported: 9 });
  assert.equal(Object.keys(after.zip.files).filter(name => /\/assets\/png\/[^/]+\.png$/.test(name)).length, 9);
  const coords = JSON.parse(await after.zip.file(`${exportedPage.directory}/coords.json`).async('string'));
  assert.equal(coords.length, 9);
  for (const asset of exportedPage.assets) {
    assert.equal(asset.coordinateSpace, 'sheet');
    assert.equal(asset.requiresPlacement, true);
    assert.equal(asset.exportRect, null, 'generated sheet coordinates must not masquerade as source-screen placement');
    assert.equal(asset.sourceSheetImage, originalSheetFile);
    assert.ok(after.zip.file(asset.path), 'each manifest asset has a real PNG in the downloaded ZIP');
    const coordinate = coords.find(entry => entry.id === asset.id);
    assert.equal(coordinate.exportRect, null);
    assert.equal(coordinate.sourceSheetImage, originalSheetFile);
  }

  // Reload the application: inspect decoded stored assets, not just in-memory canvases.
  await page.reload();
  editor = await openResourceEditor();
  await page.waitForFunction(() => document.querySelectorAll('.atlas-sprite').length === 9);
  await editor.locator('.atlas-sprite').first().click();
  const restored = page.getByRole('dialog', { name: '素材修正', exact: true });
  assert.equal(await restored.getByLabel('审核通过', { exact: true }).isChecked(), true);
  assert.equal(await restored.getByRole('link', { name: '查看保留的原始组件表', exact: true }).count(), 1);
  await page.screenshot({ path: path.join(evidenceDirectory, 'restored-reviewed.png') });
  assert.equal(detectCalls, 0, 'alpha-only sheet slicing must not call the vision detector');
  assert.equal(segmentCalls, 0, 'alpha-only sheet slicing must not call SAM');
  assert.deepEqual(unexpectedRequests, [], 'all APIs are intercepted; no provider or unexpected endpoint may be called');
  assert.deepEqual(errors, []);
  const result = {
    fixture: fixturePath ? path.resolve(fixturePath) : 'synthetic transparent nine-asset sheet',
    dimensions: { width: sheet.info.width, height: sheet.info.height }, assets: 9,
    ...pixelSummary, sourceSheetImage: originalSheetFile, uploadCount, savedRevisions: savedTasks.length,
    pendingExported: 0, reviewedExported: 9, detectCalls, segmentCalls, unexpectedRequests, blockedStaticRequests,
    warnings: pending.elements[0].qualityWarnings ?? [],
  };
  await fs.writeFile(path.join(evidenceDirectory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`PASS AI sheet browser integration: 9 independent RGBA assets, pending review, original-sheet recovery, persisted approval, ZIP export, no SAM/vision/provider calls; ${evidenceDirectory}`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  if (browser?.contexts()[0]?.pages()[0]) {
    await browser.contexts()[0].pages()[0].screenshot({ path: path.join(evidenceDirectory, 'failure.png') }).catch(() => {});
  }
  console.error(`Browser test evidence: ${evidenceDirectory}`);
  throw error;
} finally {
  await browser?.close();
  if (ownedServer) {
    ownedServer.httpServer?.closeAllConnections();
    await ownedServer.close();
  }
}
