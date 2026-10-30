import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { browserLaunchOptions } from './browser-options.mjs';

// Real browser decoding, alpha, Canvas and ZIP. Only provider/HTTP responses are
// controlled; this test cannot reach Magpie or any external model service.
const compiled = await build({
  stdin: {
    contents: `
      export { fitToBox } from './src/lib/magpie';
      export { prepareAssetReferences, referenceCrop } from './src/lib/assetReference';
      export { buildAiSlicePrompt, buildAssetRepairPrompt } from './src/lib/assetPrompts';
      export { plateOccluded } from './src/lib/pipeline';
      export { buildPageExport } from './src/lib/pageExport';
      export { default as JSZip } from 'jszip';
    `,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, platform: 'browser', format: 'iife', globalName: 'qualityApi', write: false,
});
const browser = await chromium.launch(browserLaunchOptions());
const page = await browser.newPage();
const unexpected = [];
const imageFixtures = new Map();
let fixtureTasks = [];
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.origin === 'http://quality.fixture' && url.pathname === '/') {
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Asset quality regression</title>' });
  } else if (url.origin === 'http://quality.fixture' && url.pathname === '/api/image' && imageFixtures.has(url.searchParams.get('name'))) {
    await route.fulfill({ contentType: 'image/png', body: imageFixtures.get(url.searchParams.get('name')) });
  } else if (url.origin === 'http://quality.fixture' && url.pathname === '/api/slice-tasks') {
    await route.fulfill({ json: { tasks: fixtureTasks } });
  } else {
    unexpected.push(route.request().url());
    await route.abort();
  }
});

try {
  await page.goto('http://quality.fixture');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    const api = window.qualityApi;
    const checks = [];
    const expect = (value, message) => { if (!value) throw Error(message); };
    const check = (name) => checks.push(name);
    const rejects = async (operation, pattern) => {
      try { await operation(); } catch (error) { expect(pattern.test(error.message), error.message); return; }
      throw Error('Expected a failed operation: ' + pattern);
    };
    const canvas = (w, h) => { const value = document.createElement('canvas'); value.width = w; value.height = h; return value; };
    const decode = async (url) => {
      const image = new Image(); image.src = url; await image.decode();
      const output = canvas(image.naturalWidth, image.naturalHeight);
      output.getContext('2d').drawImage(image, 0, 0);
      return output;
    };

    const generated = canvas(1024, 1024);
    const context = generated.getContext('2d');
    context.fillStyle = '#21aa44'; context.fillRect(12, 412, 1000, 200);
    context.putImageData(new ImageData(new Uint8ClampedArray([255, 0, 255, 1]), 1, 1), 1023, 1023);
    const fitted = await api.fitToBox(generated.toDataURL(), 300, 60);
    const output = await decode(fitted.dataUrl);
    expect(output.width === 300 && output.height === 60, 'fitted output dimensions');
    const pixels = output.getContext('2d').getImageData(0, 0, 300, 60).data;
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i] === 255, 'transparent canvas padding must not shrink the plate');
    expect(fitted.warnings.some((warning) => warning.includes('1 像素')), 'discarded far alpha-1 speck is reported');
    check('foreground aspect ratio and size survive square padding plus a distant alpha-1 speck');

    const translucent = canvas(50, 30);
    const soft = translucent.getContext('2d');
    soft.fillStyle = '#ff9933'; soft.fillRect(5, 5, 10, 10);
    soft.fillStyle = 'rgba(255,153,51,0.25)'; soft.fillRect(15, 9, 25, 1);
    const softResult = await api.fitToBox(translucent.toDataURL(), 35, 10);
    const softPixels = (await decode(softResult.dataUrl)).getContext('2d').getImageData(0, 0, 35, 10).data;
    expect(softPixels[(4 * 35 + 34) * 4 + 3] >= 63 && softPixels[(4 * 35 + 34) * 4 + 3] <= 65, 'continuous soft tail and alpha must survive');
    expect(softResult.warnings.length === 0, 'a valid soft tail must not become debris');
    check('continuous low-alpha tail remains complete during fitting');

    await rejects(() => api.fitToBox(canvas(20, 20).toDataURL(), 20, 20), /没有/);
    await rejects(() => api.fitToBox(generated.toDataURL(), 0, 60), /尺寸无效/);
    const multiple = canvas(100, 50); const multi = multiple.getContext('2d');
    multi.fillStyle = '#22ff33'; multi.fillRect(5, 10, 20, 20); multi.fillRect(70, 10, 20, 20);
    await rejects(() => api.fitToBox(multiple.toDataURL(), 40, 40), /2 个独立主体/);
    check('empty, invalid-size and multiple-subject repairs fail instead of silently replacing an asset');

    const source = canvas(200, 100); const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#dc8844'; sourceContext.fillRect(0, 0, 200, 100);
    sourceContext.fillStyle = '#0055ff'; sourceContext.fillRect(100, 50, 20, 10);
    const target = canvas(20, 10); const targetContext = target.getContext('2d');
    targetContext.fillStyle = '#ffcc00'; targetContext.fillRect(0, 0, 20, 10);
    const border = { bgColor: [0, 0, 0], sideScore: { top: 0, right: 0, bottom: 0, left: 0 }, dirtySides: [] };
    const element = {
      id: 'target', kind: 'button', label: 'Coin plate', description: 'gold panel', objectName: 'CoinPlate',
      state: 'Normal', rect: { x: 100, y: 50, w: 20, h: 10 }, layer: 0, occluded: true, needsAi: true,
      approved: false, textPolicy: 'separate', slice: { width: 20, height: 10, canvas: target, border },
    };
    const reference = await api.prepareAssetReferences(element, source.toDataURL());
    expect(reference.referenceDataUrl === target.toDataURL(), 'existing cutout remains the primary reference');
    const contextImage = await decode(reference.contextDataUrl);
    expect(contextImage.width === 28 && contextImage.height === 18, 'context is padded locally, not a full screenshot');
    const contextPixel = contextImage.getContext('2d').getImageData(4, 4, 1, 1).data;
    expect(contextPixel[2] === 255 && contextPixel[0] === 0, 'context uses original-screen coordinates');
    const noSlice = await api.prepareAssetReferences({ ...element, slice: undefined }, source.toDataURL());
    expect((await decode(noSlice.referenceDataUrl)).width === 20, 'missing cutout falls back to the exact target crop');
    const clamped = api.referenceCrop({ x: 0, y: 0, w: 20, h: 10 }, 200, 100, 4);
    expect(clamped.x === 0 && clamped.y === 0 && clamped.w === 24 && clamped.h === 14, 'context clamps at the image border');
    await rejects(() => api.prepareAssetReferences({ ...element, rect: { x: 199, y: 0, w: 20, h: 10 } }, source.toDataURL()), /范围/);
    check('repair receives a specific cutout plus bounded local context, with coordinate validation');

    const standalone = await api.prepareAssetReferences({ ...element, rect: { x: 700, y: 500, w: 20, h: 10 } });
    expect(standalone.referenceDataUrl === target.toDataURL() && !standalone.contextDataUrl, 'no-source repair uses the existing cutout');
    const sheet = await api.prepareAssetReferences({ ...element, coordinateSpace: 'sheet', rect: { x: 700, y: 500, w: 20, h: 10 } }, 'not-an-image');
    expect(sheet.referenceDataUrl === target.toDataURL() && !sheet.contextDataUrl, 'sheet coordinates are never applied to the original screen');
    check('standalone and AI-sheet assets can be repaired without an invalid original-screen crop');

    expect(api.buildAiSlicePrompt({ textPolicy: 'separate', keepCharacters: true }, '').includes('删除已有的动态数值'), 'default explicitly removes existing numbers');
    expect(api.buildAiSlicePrompt({ textPolicy: 'preserve', keepCharacters: true }, '').includes('保留素材本身已有的文字'), 'preserve policy is explicit');
    expect(api.buildAiSlicePrompt({ textPolicy: 'separate', keepCharacters: false }, '').includes('不输出角色'), 'character choice is honored');
    expect(api.buildAssetRepairPrompt(element, 'remove').includes('Restore the continuous blank material'), 'text removal restores the plate, not holes');
    check('text policies and character inclusion produce different explicit generation instructions');

    const originalFetch = window.fetch;
    let providerCalls = 0;
    window.fetch = async (url, options) => {
      expect(url === '/api/plate', 'only the controlled repair endpoint may be requested');
      providerCalls++;
      const request = JSON.parse(options.body);
      expect(request.reference === target.toDataURL() && request.contextReference === reference.contextDataUrl, 'repair requests use target/local context');
      expect(request.prompt.includes('Remove the existing text'), 'repair prompt removes existing text');
      return new Response(JSON.stringify({ dataUrl: generated.toDataURL() }), { headers: { 'Content-Type': 'application/json' } });
    };
    try {
      const previous = { ...element, processingStatus: 'failed', processingError: 'old failure', maskImage: 'old-mask.png' };
      const repaired = await api.plateOccluded([previous], { dataUrl: source.toDataURL() }, () => {});
      const asset = repaired.updated[0];
      expect(providerCalls === 1 && repaired.outcomes[0].ok, 'unapproved assets are eligible for repair');
      expect(asset.approved === false && asset.processingStatus === 'done' && asset.processingError === undefined, 'successful repair clears failure and needs review');
      expect(asset.maskImage === undefined && asset.qualityWarnings.length === 1, 'old mask is invalidated and new debris warning retained');
      expect(previous.processingStatus === 'failed', 'repair must not mutate the original asset');
      check('real repair pipeline replaces pixels, resets stale failures, reports debris and still requires approval');
    } finally { window.fetch = originalFetch; }

    const stored = { ...element, needsAi: false, approved: true, slice: { width: 20, height: 10, image: 'asset.png', border } };
    return { checks, source: source.toDataURL(), asset: target.toDataURL(), stored };
  });

  imageFixtures.set('source.png', Buffer.from(result.source.split(',')[1], 'base64'));
  imageFixtures.set('asset.png', Buffer.from(result.asset.split(',')[1], 'base64'));
  fixtureTasks = [{
    schemaVersion: 1, id: 'task', name: 'Quality test', width: 200, height: 100,
    source: { kind: 'project', projectId: 'p', screenId: 's', versionId: 'v', sourceImage: 'source.png' },
    elements: [result.stored, { ...result.stored, id: 'sheet', coordinateSpace: 'sheet', extractionMethod: 'repaint',
      sourceSheetImage: 'original-sheet.png', rect: { x: 700, y: 500, w: 20, h: 10 } }],
    status: 'done', createdAt: 1, updatedAt: 1,
  }];
  const exportChecks = await page.evaluate(async () => {
    const project = { id: 'p', name: 'Quality test', orientation: 'landscape', size: { w: 200, h: 100 }, stylePrompt: '',
      createdAt: 1, updatedAt: 1, screens: [{ id: 's', name: 'Screen', usage: '', layout: [], activeVersionId: 'v',
        versions: [{ id: 'v', name: 'Original', operation: 'import', image: 'source.png', createdAt: 1 }] }] };
    const pack = await window.qualityApi.buildPageExport(project, { module: 'Common', includeTextAsImage: false }, { scope: 'all', size: 'original' });
    const exported = pack.manifest.pages[0];
    if (exported.assets.length !== 2 || exported.assets[0].exportRect.x !== 100 || exported.assets[1].exportRect !== null) {
      throw Error('AI-sheet coordinates were mapped into original-screen coordinates');
    }
    const zip = await window.qualityApi.JSZip.loadAsync(pack.blob);
    const coords = JSON.parse(await zip.file(`${exported.directory}/coords.json`).async('string'));
    if (coords[1].exportRect !== null || !coords[1].requiresPlacement || coords[1].sourceSheetImage !== 'original-sheet.png') {
      throw Error('Page ZIP lost coordinate-space provenance');
    }
    return ['real page ZIP preserves original positions and marks sheet assets as requiring placement'];
  });
  assert.deepEqual(unexpected, [], 'no uncontrolled network/provider requests');
  console.log(JSON.stringify({ passed: true, checks: [...result.checks, ...exportChecks], externalModelCalls: 0 }));
} finally {
  await browser.close();
}
