import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import sharp from 'sharp';

// node scripts/test-segmentation-api.mjs [--real]
// HTTP, middleware and disk store are real. Default: only the Python process/files are controlled.
// --real additionally executes the fixed project Python script with the installed CPU model.
const root = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(root, '.data', `segmentation-api-${Date.now()}-${randomUUID().slice(0, 8)}`);
await fs.mkdir(evidence, { recursive: true });
process.env.GAMEUI_DATA = path.join(evidence, 'store');
const events = [];
const children = [];
let mode = 'ok';
globalThis.__segmentationApiTest = { get mode() { return mode; }, children, calls: [] };
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

async function loadApi(controlled) {
  const result = await build({
    entryPoints: [path.join(root, 'server/apiPlugin.ts')], bundle: true, write: false,
    format: 'esm', platform: 'node', packages: 'external',
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(root, 'server/segmentation.ts')).href) },
    plugins: controlled ? [{ name: 'controlled-python-only', setup(builder) {
      builder.onLoad({ filter: /server[\\/]segmentation\.ts$/ }, async ({ path: file }) => ({
        contents: (await fs.readFile(file, 'utf8')).replace('120_000', '1500').replace('30_000', '1500'), loader: 'ts',
      }));
      builder.onResolve({ filter: /^node:(child_process|fs\/promises)$/ }, ({ path: name, importer }) => {
        if (importer.endsWith('segmentation.ts')) return { path: name, namespace: 'controlled' };
      });
      builder.onLoad({ filter: /.*/, namespace: 'controlled' }, ({ path: name }) => {
        if (name === 'node:fs/promises') return { contents: `import fs from 'node:fs/promises'; export default { ...fs, stat: async (file) => {
          const mode = globalThis.__segmentationApiTest.mode;
          if ((mode === 'missing' && file.endsWith('python.exe')) || (mode === 'weights' && file.endsWith('.pt'))) throw new Error('missing fixture');
          return { isFile: () => true, isDirectory: () => true };
        } };` };
        return { contents: `import { spawn as realSpawn } from 'node:child_process';
          export function spawn(exe, args, options) {
            const state = globalThis.__segmentationApiTest;
            state.calls.push({ exe, args, shell: options.shell });
            const code = ${JSON.stringify(`
              const mode = process.argv[1];
              const probe = process.argv[2] === 'probe';
              let input = '';
              process.stdin.setEncoding('utf8');
              process.stdin.on('data', chunk => input += chunk);
              process.stdin.on('end', () => {
                if (mode === 'timeout') { setInterval(() => {}, 1000); return; }
                if (mode === 'imports') { process.stderr.write('ModuleNotFoundError: mobile_sam'); process.exitCode = 1; console.log(JSON.stringify({ok:false,error:{type:'ModuleNotFoundError',message:'mobile_sam unavailable'}})); return; }
                if (probe) { console.log(JSON.stringify({importsAvailable:true})); return; }
                if (mode === 'malformed') { console.log('not JSON'); return; }
                if (mode === 'overflow') { process.stdout.write('x'.repeat(65 * 1024 * 1024)); return; }
                if (mode === 'stderr') { process.stderr.write('E'.repeat(20000)); console.log('{}'); process.exitCode = 1; return; }
                const request = JSON.parse(input);
                if (request.imageBase64.startsWith('data:') || !Array.isArray(request.bbox)) throw new Error('invalid protocol');
                if (request.bbox[2] > 1 || request.bbox[3] > 1 || request.points?.some(p => p.x >= 1 || p.y >= 1)) {
                  console.log(JSON.stringify({ok:false,error:{type:'ValueError',message:'bbox/point outside image bounds'}})); process.exitCode=1; return;
                }
                console.log(JSON.stringify({width:1,height:1,maskBase64:'${png}',rgbaBase64:'${png}',score:0.9,elapsedMs:3,model:'controlled-protocol',request}));
              });
            `)};
            const child = realSpawn(process.execPath, ['-e', code, state.mode, args.includes('--health') ? 'probe' : 'segment'], options);
            state.children.push(child);
            return child;
          }` };
      });
    } }] : [],
  });
  // A file URL lets Node resolve native dependencies such as sharp beside the project.
  const bundlePath = path.join(evidence, `api-${controlled ? 'controlled' : 'real'}.mjs`);
  await fs.writeFile(bundlePath, result.outputFiles[0].text);
  return import(pathToFileURL(bundlePath).href);
}

async function serve(api) {
  const routes = [];
  api.magpieApi().configureServer({ middlewares: { use(prefix, handler) { routes.push({ prefix, handler }); } } });
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const route = routes.find(({ prefix }) => pathname === prefix);
    if (!route) { res.writeHead(404).end(); return; }
    req.url = req.url.slice(route.prefix.length) || '/';
    Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500).end(error.message); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(resolve => server.close(resolve)) };
}

async function call(base, route, body, method = 'POST') {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

async function controlledTests() {
  const service = await serve(await loadApi(true));
  try {
    const upload = await call(service.base, '/api/upload', { image: `data:image/png;base64,${png}`, prefix: 'seg-test' });
    assert.equal(upload.status, 200);
    const valid = { sourceImage: upload.body.fileName, rect: { x: 0, y: 0, w: 1, h: 1 }, points: [{ x: 0, y: 0, label: 1 }, { x: 0, y: 0, label: 0 }] };
    const check = async (name, body, status, route = '/api/segment', method = 'POST') => {
      const result = await call(service.base, route, body, method);
      events.push({ name, ...result });
      assert.equal(result.status, status, `${name}: ${JSON.stringify(result.body)}`);
      return result.body;
    };
    await check('protocol-success', valid, 200);
    const launch = globalThis.__segmentationApiTest.calls.at(-1);
    assert.equal(launch.shell, false);
    assert.equal(launch.exe, path.join(root, '.venv-seg/Scripts/python.exe'));
    assert.deepEqual(launch.args, [
      path.join(root, 'scripts/segment.py'),
      '--checkpoint', path.join(root, '.data/segmentation/sam2/sam2.1_hiera_small.pt'),
      '--site', path.join(root, '.data/segmentation/sam2/site'),
      '--source', path.join(root, '.data/segmentation/sam2/source'),
      '--config', 'configs/sam2.1/sam2.1_hiera_s.yaml',
    ]);
    for (const sourceImage of ['../x.png', 'C:\\x.png', '/x.png', 'a/b.png', 'https://example.com/a.png', 'a.png;cmd']) await check('reject-path-' + sourceImage, { ...valid, sourceImage }, 400);
    for (const rect of [null, { x: -1, y: 0, w: 1, h: 1 }, { x: '0', y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 1 }, { x: 99999, y: 0, w: 2, h: 1 }]) await check('invalid-rect', { ...valid, rect }, 400);
    await check('invalid-point', { ...valid, points: [{ x: 0, y: 0, label: 2 }] }, 400);
    await check('too-many-points', { ...valid, points: Array(257).fill({ x: 0, y: 0, label: 1 }) }, 400);
    await check('invalid-json', '{', 400);
    await check('body-limit', { ...valid, extra: 'x'.repeat(66000) }, 413);
    await check('method', undefined, 405, '/api/segment', 'GET');
    await check('not-found', { ...valid, sourceImage: 'missing.png' }, 404);
    await check('worker-real-bounds-contract', { ...valid, rect: { x: 0, y: 0, w: 2, h: 2 } }, 400);
    for (const [testMode, status] of [['missing', 503], ['weights', 503], ['imports', 503], ['timeout', 504], ['malformed', 502], ['overflow', 502], ['stderr', 502]]) {
      mode = testMode;
      const body = await check(testMode, valid, status);
      if (mode === 'stderr') assert.ok(body.error.length < 4300);
    }
    mode = 'imports';
    const unavailable = await check('health-import-failure-despite-files', undefined, 503, '/api/segment-health', 'GET');
    assert.equal(unavailable.files.python, true);
    assert.equal(unavailable.importsAvailable, false);
    mode = 'ok';
    const health = await check('health-import-success-not-inference', undefined, 200, '/api/segment-health', 'GET');
    assert.equal(health.inferenceVerified, false);
  } finally { await service.close(); }
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once('close', resolve))));
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
}

async function realTest() {
  const service = await serve(await loadApi(false));
  try {
    const health = await call(service.base, '/api/segment-health', undefined, 'GET');
    events.push({ name: 'REAL-import-health', ...health });
    assert.equal(health.status, 200, JSON.stringify(health.body));
    const sourceFile = process.env.SEGMENTATION_TEST_IMAGE ?? 'screen-1793144933666-c4z2yw.png';
    const source = await fs.readFile(path.join(root, '.data/images', sourceFile));
    const upload = await call(service.base, '/api/upload', { image: 'data:image/png;base64,' + source.toString('base64'), prefix: 'real-source' });
    assert.equal(upload.status, 200);
    const started = Date.now();
    const result = await call(service.base, '/api/segment', { sourceImage: upload.body.fileName, rect: { x: 357, y: 56, w: 63, h: 71 }, points: [{ x: 389, y: 91, label: 1 }] });
    await fs.writeFile(path.join(evidence, 'real-response.json'), JSON.stringify(result.body));
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.model, 'SAM2.1-small');
    assert.equal(result.body.width, 1024);
    assert.equal(result.body.height, 1536);
    for (const field of ['maskBase64', 'rgbaBase64']) await fs.writeFile(path.join(evidence, `${field}.png`), Buffer.from(result.body[field], 'base64'));
    const mask = await call(service.base, '/api/upload', { image: 'data:image/png;base64,' + result.body.maskBase64, prefix: 'segmentation-mask' });
    assert.equal(mask.status, 200);
    const restored = await fetch(service.base + '/api/image?name=' + encodeURIComponent(mask.body.fileName));
    assert.equal(restored.status, 200);
    const restoredBytes = Buffer.from(await restored.arrayBuffer());
    const expectedMask = Buffer.from(result.body.maskBase64, 'base64');
    const [restoredMetadata, expectedMetadata] = await Promise.all([
      sharp(restoredBytes).metadata(), sharp(expectedMask).metadata(),
    ]);
    assert.equal(restoredMetadata.width, expectedMetadata.width);
    assert.equal(restoredMetadata.height, expectedMetadata.height);
    assert.deepEqual(
      await sharp(restoredBytes).raw().toBuffer(),
      await sharp(expectedMask).raw().toBuffer(),
    );
    events.push({ name: 'REAL-CPU-HTTP-inference-and-mask-restore', status: result.status, wallMs: Date.now() - started,
      width: result.body.width, height: result.body.height, score: result.body.score, elapsedMs: result.body.elapsedMs, model: result.body.model, maskImage: mask.body.fileName });
  } finally { await service.close(); }
}

async function clientTests() {
  const bundle = await build({ entryPoints: [path.join(root, 'src/lib/segmentation.ts')], bundle: true, write: false,
    format: 'esm', platform: 'browser' });
  const client = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const originalGlobals = { fetch: globalThis.fetch, Image: globalThis.Image, document: globalThis.document };
  const sourcePixels = new Uint8ClampedArray([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,255]);
  const rgbaPixels = new Uint8ClampedArray([201,202,203,255,201,202,203,0,201,202,203,255,201,202,203,255]);
  const requests = [];
  let fail = false;
  class Canvas {
    width = 0; height = 0; pixels;
    getContext() {
      return {
        drawImage: (image, ...args) => {
          const pixels = image.src.startsWith('data:') ? rgbaPixels : sourcePixels;
          const [x, y, w, h] = args.length > 2 ? args : [0, 0, 2, 2];
          this.pixels = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
            this.pixels.set(pixels.subarray(((y + row) * 2 + x + col) * 4, ((y + row) * 2 + x + col) * 4 + 4), (row * w + col) * 4);
          }
        },
        getImageData: (x, y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let row = 0; row < h; row++) for (let col = 0; col < w; col++) {
            data.set(this.pixels.subarray(((y + row) * this.width + x + col) * 4, ((y + row) * this.width + x + col) * 4 + 4), (row * w + col) * 4);
          }
          return { width: w, height: h, data };
        },
        putImageData: image => { this.pixels = image.data; },
      };
    }
  }
  try {
    globalThis.Image = class { naturalWidth = 2; naturalHeight = 2; async decode() {} };
    globalThis.document = { createElement: () => new Canvas() };
    globalThis.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, body });
      if (url === '/api/upload') return { ok: true, json: async () => ({ fileName: 'mask-saved.png' }) };
      if (fail) return { ok: false, status: 503, json: async () => ({ error: 'runtime missing' }) };
      return { ok: true, json: async () => ({ width: 2, height: 2, rgbaBase64: png, maskBase64: png }) };
    };
    const oldCanvas = { sentinel: true };
    const element = { id: 'original-id', label: 'coin', rect: { x: 1, y: 0, w: 1, h: 2 }, approved: false,
      repainted: true, slice: { canvas: oldCanvas }, sourceMarker: 'task-original' };
    const points = [{ x: 1, y: 1, label: 1 }, { x: 0, y: 0, label: 0 }];
    const segmented = await client.segmentElement('source.png', element, points);
    assert.deepEqual(requests[0].body.points, points);
    assert.equal(segmented.extractionMethod, 'segmentation');
    assert.equal(segmented.repainted, false);
    assert.equal(segmented.maskImage, 'mask-saved.png');
    assert.equal(segmented.approved, false);
    assert.equal(segmented.sourceMarker, 'task-original');
    assert.deepEqual(segmented.rect, element.rect);
    assert.notEqual(segmented.slice.canvas, oldCanvas);
    assert.equal(element.slice.canvas, oldCanvas);
    assert.deepEqual(Array.from(segmented.slice.canvas.pixels), [40,50,60,0,100,110,120,255]);
    assert.ok(Object.values(segmented.slice.border.sideScore).some(score => score > 0));
    assert.ok(segmented.slice.border.bgColor.some(channel => channel > 0));
    const progress = [];
    const batch = await client.segmentElements([element, { ...element, id: 'second' }], 'source.png', p => progress.push(p));
    assert.deepEqual(batch.map(e => e.id), ['original-id', 'second']);
    assert.equal(progress.at(-1).done, 2);
    fail = true;
    await assert.rejects(client.segmentElements([element], 'source.png', () => {}), /original-id.*runtime missing/);
    events.push({ name: 'client-crop-original-rgb-alpha-clone-mask-points-batch-no-fallback', passed: true,
      limitation: 'controlled canvas/image decoding, not a real browser pixel acceptance' });
  } finally { Object.assign(globalThis, originalGlobals); }
}

try {
  await controlledTests();
  await clientTests();
  if (process.argv.includes('--real')) await realTest();
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, realInference: process.argv.includes('--real'), events }, null, 2));
  console.log(JSON.stringify({ passed: true, checks: events.length, realInference: process.argv.includes('--real'), evidence }));
} catch (error) {
  await fs.writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, error: error.stack, events }, null, 2));
  console.error(error.stack);
  console.error('Full evidence:', evidence);
  process.exitCode = 1;
}
