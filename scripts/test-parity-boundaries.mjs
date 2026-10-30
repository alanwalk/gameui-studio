import assert from 'node:assert/strict';
import { build } from 'esbuild';
import sharp from 'sharp';

// In-memory bundle: no app server, Unity, model calls, or shared project data.
const bundled = await build({
  stdin: {
    contents: `export { exportAtlas } from './src/lib/atlasExport';
      export { parseAtlasFiles, decodeAtlasPng } from './src/lib/atlasImport';
      export { loadStyleDraft, STYLE_DRAFT_KEY } from './src/lib/styleGeneration';`,
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, platform: 'browser', format: 'esm', write: false,
});
const { exportAtlas, parseAtlasFiles, decodeAtlasPng, loadStyleDraft, STYLE_DRAFT_KEY } =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString('base64')}`);
const failures = [];
async function check(name, operation) {
  try {
    await operation();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

const originalFetch = globalThis.fetch;
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
});
try {
  // The successful sibling must still export when another HTTP-200 image is corrupt.
  const originalPixels = Buffer.from([11, 12, 13, 255, 21, 22, 23, 255, 31, 32, 33, 255]);
  const originalPng = await sharp(originalPixels, { raw: { width: 3, height: 1, channels: 4 } }).png().toBuffer();
  const replacementPng = await sharp(Buffer.from([101, 102, 103, 255]),
    { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const descriptor = JSON.stringify({
    frames: {
      broken: { frame: { x: 0, y: 0, w: 1, h: 1 } },
      good: { frame: { x: 2, y: 0, w: 1, h: 1 } },
    },
    meta: { image: 'page.png', size: { w: 3, h: 1 } },
  });
  const imported = await parseAtlasFiles(new Map([
    ['page.png', originalPng], ['sheet.json', new TextEncoder().encode(descriptor)],
  ]));
  const task = {
    items: imported.manifest.regions.map((region, index) => ({
      id: `item-${index}`, originalPath: region.inputPath,
      width: 1, height: 1, format: 'png', status: 'done',
      resultImage: index === 0 ? 'broken.png' : 'good.png',
    })),
  };
  globalThis.fetch = async url => {
    if (url === '/api/reskin-images/good.png') return new Response(replacementPng);
    if (url === '/api/reskin-images/broken.png') return new Response('HTTP 200 but not PNG');
    throw Error(`Unexpected request: ${url}`);
  };
  await check('Atlas HTTP-200 corrupt result preserves its rectangle and untouched gap; valid sibling exports', async () => {
    const result = await exportAtlas(imported, task);
    const page = await decodeAtlasPng(new Uint8Array(await result.pages.get('page.png').arrayBuffer()));
    assert.deepEqual([...page.data], [11, 12, 13, 255, 21, 22, 23, 255, 101, 102, 103, 255]);
    assert.match(result.report, /回填 1 \/ 2/);
    assert.match(result.report, /broken：保留原像素/);
  });

  const draft = {
    id: '11111111-1111-4111-8111-111111111111', description: 'fixture', referenceImages: [],
    name: 'fixture', prompt: 'fixture', submitted: true,
    pendingDrawingID: '22222222-2222-4222-8222-222222222222',
  };
  await check('Style ordinary submitted draft restores the original task identity', () => {
    storage.set(STYLE_DRAFT_KEY, JSON.stringify(draft));
    assert.deepEqual(loadStyleDraft(), draft);
  });
  await check('Style valid 8000-character description/prompt survive refresh including JSON escaping', () => {
    const longDraft = { ...draft, description: '"'.repeat(8000), prompt: 'x'.repeat(8000) };
    const serialized = JSON.stringify(longDraft);
    storage.set(STYLE_DRAFT_KEY, serialized);
    const restored = loadStyleDraft();
    assert.equal(restored.id, longDraft.id,
      `Valid draft (${serialized.length} JSON characters) lost its submitted identity on refresh`);
    assert.deepEqual(restored, longDraft);
  });
} finally {
  globalThis.fetch = originalFetch;
  if (originalStorage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', originalStorage);
}
if (failures.length) {
  console.error(`${failures.length} independent boundary failure(s): ${failures.join('; ')}`);
  process.exitCode = 1;
}
