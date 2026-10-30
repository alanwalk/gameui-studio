import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createServer } from 'vite';
import sharp from 'sharp';

const directory = await fs.mkdtemp(path.resolve('.data/ai-slice-api-'));
process.env.GAMEUI_DATA = directory;
const apiFile = path.join(directory, 'api.mjs');
await build({
  entryPoints: ['server/apiPlugin.ts'],
  outfile: apiFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  plugins: [{
    name: 'controlled-ai-slice-provider',
    setup(builder) {
      builder.onResolve({ filter: /\/magpieMcp$/ }, () => ({ path: 'provider', namespace: 'controlled' }));
      builder.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({
        contents: `
          export const generateImage = (...args) => globalThis.aiSliceProvider.generateImage(...args);
          export const waitForGeneration = (...args) => globalThis.aiSliceProvider.waitForGeneration(...args);
        `,
        loader: 'js',
      }));
    },
  }],
});

const fixture = await sharp({
  create: { width: 12, height: 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
}).png().toBuffer();
const reference = await sharp({
  create: { width: 12, height: 8, channels: 4, background: '#123456' },
}).png().toBuffer();
let mode = 'immediate';
let calls = 0;
let expectedKind = 'sheet';
let expectedReferences = 1;
globalThis.aiSliceProvider = {
  async generateImage(args) {
    calls++;
    assert.equal(args.background, 'transparent');
    assert.equal(args.quality, 'high');
    assert.equal(args.n, 1);
    assert.equal(args.size, expectedKind === 'sheet' ? '12x8' : undefined);
    assert.equal(args.referenceImages.length, expectedReferences);
    assert.equal((await sharp(args.referenceImages[0]).metadata()).width, 12);
    assert.equal((await sharp(args.referenceImages[0]).metadata()).format, 'png');
    if (expectedReferences === 2) {
      assert.equal((await sharp(args.referenceImages[1]).metadata()).width, 16);
      assert.equal((await sharp(args.referenceImages[1]).metadata()).format, 'png');
    }
    if (mode === 'pending') return { pendingId: 'controlled-sheet', text: 'still running', isError: false };
    return { base64: fixture.toString('base64'), text: '', isError: false };
  },
  async waitForGeneration(args) {
    assert.equal(args.pendingId, 'controlled-sheet');
    assert.ok(args.watchPath.endsWith('slice-sheet.png'));
    return { base64: fixture.toString('base64'), text: '', isError: false };
  },
};

const { magpieApi } = await import(pathToFileURL(apiFile));
const vite = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { host: '127.0.0.1', port: 0, watch: null },
  plugins: [magpieApi()],
});
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;

async function request(method, body, expected = 200, route = '/api/ai-slice-sheet') {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, expected, JSON.stringify(payload));
  return payload;
}

try {
  const valid = {
    reference: `data:image/png;base64,${reference.toString('base64')}`,
    prompt: '拆成透明组件表',
    size: '12x8',
  };
  const immediate = await request('POST', valid);
  assert.equal(immediate.dataUrl, `data:image/png;base64,${fixture.toString('base64')}`);
  assert.equal(calls, 1);

  mode = 'pending';
  const pending = await request('POST', valid);
  assert.equal(pending.dataUrl, immediate.dataUrl);
  assert.equal(calls, 2);

  await request('GET', undefined, 405);
  await request('POST', { ...valid, prompt: '' }, 502);
  await request('POST', { ...valid, reference: 'not-an-image' }, 502);
  await request('POST', { ...valid, size: '12 by 8' }, 502);

  mode = 'immediate';
  expectedKind = 'plate';
  const plateBody = { reference: valid.reference, prompt: 'Repair only this asset and remove its text' };
  assert.equal((await request('POST', plateBody, 200, '/api/plate')).dataUrl, immediate.dataUrl);
  const context = await sharp({ create: { width: 16, height: 12, channels: 3, background: '#abcdef' } }).jpeg().toBuffer();
  expectedReferences = 2;
  await request('POST', { ...plateBody, contextReference: `data:image/jpeg;base64,${context.toString('base64')}` }, 200, '/api/plate');
  assert.equal(calls, 4, 'one target plus optional local context reaches only the controlled provider');
  for (const body of [
    { ...plateBody, reference: 'not-an-image' },
    { ...plateBody, reference: 'data:image/png;base64,YmFk' },
    { ...plateBody, reference: undefined },
    { ...plateBody, contextReference: 'data:image/png;base64,YmFk' },
    { ...plateBody, contextReference: 42 },
    { ...plateBody, prompt: 'x'.repeat(12_001) },
  ]) await request('POST', body, 502, '/api/plate');
  assert.equal(calls, 4, 'invalid target/context must be rejected before model access');

  console.log(JSON.stringify({
    passed: true,
    checks: ['transparent-background', 'reference-normalization', 'pending-result', 'method-and-input-validation',
      'plate-target-and-local-context', 'plate-reference-validation-before-provider'],
    evidence: directory,
  }));
} finally {
  vite.httpServer.closeAllConnections();
  await vite.close();
}
