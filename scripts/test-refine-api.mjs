import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createServer } from 'vite';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

const directory = await fs.mkdtemp(path.resolve('.data/test-refine-api-'));
process.env.GAMEUI_DATA = directory;
// The obsolete Python override must have no effect on core image functionality.
process.env.GAMEUI_IMAGE_PYTHON = path.join(directory, 'must-not-run-python.exe');
const output = path.join(directory, 'api.mjs');
// Only the image provider is replaced; requests execute apiPlugin's registered HTTP routes and real store.
await build({
  entryPoints: ['server/apiPlugin.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output,
  packages: 'external', plugins: [{ name: 'controlled-image-provider', setup(build) {
    build.onResolve({ filter: /\/magpieMcp$/ }, () => ({ path: 'image-provider', namespace: 'controlled' }));
    build.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: `
      import fs from 'node:fs/promises';
      export async function generateImage(args) {
        globalThis.refineCalls ??= [];
        globalThis.refineCalls.push({ ...args, references: await Promise.all(args.referenceImages.map(file => fs.readFile(file, 'base64'))) });
        if (args.prompt.includes('PROVIDER_FAIL')) throw new Error('controlled provider failure');
        if (args.prompt.includes('EMPTY_RESULT')) return { text: 'no image', isError: false };
        if (args.prompt.includes('PENDING_RESULT')) return { pendingId: 'controlled-job', isError: false };
        if (args.prompt.includes('PATH_RESULT')) { await fs.copyFile(args.referenceImages[0], args.path); return { path: args.path, isError: false }; }
        if (args.prompt.includes('INVALID_RESULT')) return { base64: Buffer.from('not a PNG').toString('base64'), isError: false };
        if (args.prompt.includes('CORRUPT_RESULT')) return { base64: globalThis.corruptPng, isError: false };
        if (args.prompt.includes('TRUNCATED_RESULT')) return { base64: Buffer.from(globalThis.testPng, 'base64').subarray(0, 48).toString('base64'), isError: false };
        if (args.prompt.includes('WRONG_RATIO')) return { base64: globalThis.wrongRatioPng, isError: false };
        if (args.prompt.includes('LARGER_RESULT')) return { base64: globalThis.largerPng, isError: false };
        if (args.prompt.includes('JPEG_RESULT')) return { base64: globalThis.jpegImage, isError: false };
        if (args.prompt.includes('WEBP_RESULT')) return { base64: globalThis.webpImage, isError: false };
        if (args.prompt.includes('ORIENTED_RESULT')) return { base64: globalThis.orientedImage, isError: false };
        return { base64: globalThis.testPng, text: '', isError: false };
      }
      export async function waitForGeneration(args) {
        if (args.pendingId === 'controlled-job') return { base64: globalThis.testPng, isError: false };
        return { text: 'controlled missing image', isError: false };
      }
    `, loader: 'js' }));
  } }],
});
const { magpieApi } = await import(pathToFileURL(output));
const vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, watch: null }, plugins: [magpieApi()] });
const server = http.createServer(vite.middlewares);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
// Real RGBA fixtures, rather than a header-only image substitute.
globalThis.testPng = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFUlEQVR4nGMUCVjwn4GBgYEJRKAwADAtAglcQ1nCAAAAAElFTkSuQmCC';
globalThis.largerPng = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAGCAYAAADkOT91AAAAFUlEQVR4nGMUCVjwnwEJMCFzqCUAAMlsAg+hTG4rAAAAAElFTkSuQmCC';
globalThis.wrongRatioPng = 'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFElEQVR4nGMUCVjwnwEKmGAMEA0ALgwCB6mbJUgAAAAASUVORK5CYII=';
const corrupt = Buffer.from(globalThis.testPng, 'base64');
// Valid signature, dimensions, chunk layout and CRC; corrupt compressed pixels require a real decode to reject.
corrupt.fill(0, 41, 41 + corrupt.readUInt32BE(33));
corrupt.writeUInt32BE(crc32(corrupt.subarray(37, 41 + corrupt.readUInt32BE(33))), 41 + corrupt.readUInt32BE(33));
globalThis.corruptPng = corrupt.toString('base64');
const sourcePixels = Buffer.from(globalThis.testPng, 'base64');
globalThis.jpegImage = (await sharp(sourcePixels).jpeg().toBuffer()).toString('base64');
globalThis.webpImage = (await sharp(sourcePixels).webp().toBuffer()).toString('base64');
globalThis.orientedImage = (await sharp(sourcePixels).withMetadata({ orientation: 6 }).jpeg().toBuffer()).toString('base64');
async function assertSamePixels(actual, expected) {
  const actualPixels = await sharp(actual, { failOn: 'warning' }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const expectedPixels = await sharp(expected, { failOn: 'warning' }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(actualPixels.info.width, expectedPixels.info.width);
  assert.equal(actualPixels.info.height, expectedPixels.info.height);
  assert.deepEqual(actualPixels.data, expectedPixels.data);
}
async function request(route, body, method = 'POST') {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
try {
  const source = await request('/api/upload', { image: `data:image/png;base64,${globalThis.testPng}`, prefix: 'source' });
  const style = await request('/api/upload', { image: `data:image/png;base64,${globalThis.testPng}`, prefix: 'style' });
  const sourceImage = source.body.fileName;
  const styleImage = style.body.fileName;
  assert.ok(sourceImage && styleImage);
  const regressions = [];
  const beforeInvalid = await fs.readdir(path.join(directory, 'images'));
  for (const prompt of ['INVALID_RESULT', 'CORRUPT_RESULT', 'TRUNCATED_RESULT', 'WRONG_RATIO']) {
    const result = await request('/api/refine', { sourceImage, prompt });
    if (result.status === 200) regressions.push(`${prompt}: accepted HTTP 200`);
  }
  if ((await fs.readdir(path.join(directory, 'images'))).length !== beforeInvalid.length) regressions.push('invalid model images were persisted');
  const larger = await request('/api/refine', { sourceImage, prompt: 'LARGER_RESULT' });
  assert.equal(larger.status, 200);
  const resized = Buffer.from(larger.body.dataUrl.split(',')[1], 'base64');
  if (resized.readUInt32BE(16) !== 2 || resized.readUInt32BE(20) !== 3) regressions.push('output not restored to 2x3 source canvas');
  if (globalThis.refineCalls.at(-1).size !== '2x3') regressions.push('source size not passed through supported size argument');
  assert.deepEqual(regressions, [], 'image integrity and source canvas regressions');
  globalThis.refineCalls = [];
  const refined = await request('/api/refine', { sourceImage, styleImage, prompt: 'gold button' });
  assert.equal(refined.status, 200);
  assert.ok(refined.body.fileName.startsWith('refine-'));
  assert.equal(globalThis.refineCalls.length, 1);
  assert.equal(globalThis.refineCalls[0].references.length, 2);
  for (const reference of globalThis.refineCalls[0].references) await assertSamePixels(Buffer.from(reference, 'base64'), sourcePixels);
  assert.match(globalThis.refineCalls[0].prompt, /gold button/);
  assert.equal(globalThis.refineCalls[0].background, 'opaque');
  assert.equal(globalThis.refineCalls[0].n, 1);
  assert.equal(globalThis.refineCalls[0].size, '2x3');
  await assert.rejects(fs.stat(globalThis.refineCalls[0].referenceImages[0]), /ENOENT/, 'temporary references cleaned');
  for (const prompt of ['PENDING_RESULT', 'PATH_RESULT']) {
    const result = await request('/api/refine', { sourceImage, prompt });
    assert.equal(result.status, 200);
    assert.equal(globalThis.refineCalls.at(-1).references.length, 1);
    await assertSamePixels(await fs.readFile(path.join(directory, 'images', result.body.fileName)), sourcePixels);
  }
  for (const [prompt, encoded] of [['JPEG_RESULT', globalThis.jpegImage], ['WEBP_RESULT', globalThis.webpImage]]) {
    const result = await request('/api/refine', { sourceImage, prompt });
    assert.equal(result.status, 200);
    const normalized = await fs.readFile(path.join(directory, 'images', result.body.fileName));
    assert.equal((await sharp(normalized).metadata()).format, 'png');
    await assertSamePixels(normalized, Buffer.from(encoded, 'base64'));
  }
  const rotatedSource = await request('/api/upload', { image: `data:image/jpeg;base64,${globalThis.orientedImage}`, prefix: 'oriented' });
  const oriented = await request('/api/refine', { sourceImage: rotatedSource.body.fileName, styleImage: rotatedSource.body.fileName, prompt: 'ORIENTED_RESULT' });
  assert.equal(oriented.status, 200);
  assert.equal(globalThis.refineCalls.at(-1).size, '3x2', 'size uses displayed dimensions after EXIF rotation');
  for (const reference of globalThis.refineCalls.at(-1).references) {
    const metadata = await sharp(Buffer.from(reference, 'base64')).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 3);
    assert.equal(metadata.height, 2);
    assert.ok(!metadata.orientation || metadata.orientation === 1);
    await assertSamePixels(Buffer.from(reference, 'base64'), Buffer.from(globalThis.orientedImage, 'base64'));
  }
  const orientedOutput = Buffer.from(oriented.body.dataUrl.split(',')[1], 'base64');
  assert.equal((await sharp(orientedOutput).metadata()).format, 'png');
  assert.equal(oriented.body.width, 3);
  assert.equal(oriented.body.height, 2);
  await assertSamePixels(orientedOutput, Buffer.from(globalThis.orientedImage, 'base64'));
  const beforeFailure = await fs.readdir(path.join(directory, 'images'));
  const callCount = globalThis.refineCalls.length;
  for (const body of [null, [], {}, { sourceImage, prompt: ' ' },
    { sourceImage: '../source.png', prompt: 'x' }, { sourceImage: 'C:\\secret.png', prompt: 'x' },
    { sourceImage: '/etc/passwd', prompt: 'x' }, { sourceImage, styleImage: '../style.png', prompt: 'x' },
    { sourceImage: 'missing.png', prompt: 'x' }]) {
    const result = await request('/api/refine', body);
    assert.notEqual(result.status, 200);
    assert.ok(result.body.error);
  }
  assert.equal(globalThis.refineCalls.length, callCount, 'invalid input never reaches model');
  for (const prompt of ['PROVIDER_FAIL', 'EMPTY_RESULT']) {
    const result = await request('/api/refine', { sourceImage, prompt });
    assert.equal(result.status, 502);
    assert.ok(result.body.error);
  }
  assert.deepEqual(await fs.readdir(path.join(directory, 'images')), beforeFailure, 'failed calls write no image');
  assert.equal((await request('/api/refine', undefined, 'GET')).status, 405);
  const malformed = await fetch(base + '/api/refine', { method: 'POST', body: '{' });
  assert.equal(malformed.status, 502);
  const oversized = await request('/api/refine', { sourceImage, prompt: 'x'.repeat(65536) });
  assert.notEqual(oversized.status, 200);
  const version = { id: 'v2', parentVersionId: 'v1', image: refined.body.fileName, prompt: 'gold', createdAt: 2, name: '金色', note: '布局保留', operation: 'refine', styleSnapshot: { prompt: 'ice', image: styleImage } };
  const project = { id: 'refine-test', name: 'test', screens: [{ id: 's1', versions: [version], activeVersionId: 'v2' }], createdAt: 1, updatedAt: 1 };
  assert.equal((await request('/api/projects', { project }, 'PUT')).status, 200);
  const reloaded = await request('/api/projects', undefined, 'GET');
  assert.deepEqual(reloaded.body.projects[0].screens[0].versions[0], version);
  const image = await fetch(base + '/api/image?name=' + encodeURIComponent(version.image));
  assert.equal(image.status, 200);
  await assertSamePixels(Buffer.from(await image.arrayBuffer()), sourcePixels);
  const drawing = await request('/api/drawing/state', undefined, 'GET');
  assert.equal(drawing.status, 200, 'Drawing API registered before Vite fallback');
  assert.ok(Array.isArray(drawing.body.tasks));
  console.log('PASS actual apiPlugin routes: source/style references, base64/path/pending results, cleanup, traversal/method/JSON/size validation, model failure writes nothing, metadata persistence and derived image retrieval without parent');
  console.log('PASS shared sharp decode: invalid/truncated/correct-CRC corrupt pixels rejected without persistence; source size and proportional canvas recovery; JPEG/WebP normalized PNG; EXIF orientation corrected for source/style/output; obsolete Python path unused; Drawing state route registered');
  console.log('Image provider: controlled substitute; no real model calls');
  console.log(`Evidence: ${directory}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await vite.close();
}
