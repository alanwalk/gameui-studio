import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import JSZip from 'jszip';

// Real CLI subprocesses, filesystem, PNG/ZIP codecs and localhost HTTP transport.
// AI and SAM responses below are controlled fixtures, NOT model inference.
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = path.join(root, 'scripts/gameui.mjs');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-cli-test-'));
const events = [];
const reports = [];
let mode = 'normal';
let pendingTimer;
const width = 96;
const height = 64;
const pixels = Buffer.alloc(width * height * 4);
function pixel(x, y, rgba) { pixels.set(rgba, (y * width + x) * 4); }
for (let y = 10; y < 22; y++) for (let x = 10; x < 22; x++) pixel(x, y, [255, 30, 10, 255]);
for (let y = 10; y < 22; y++) pixel(22, y, [240, 20, 8, 128]);
for (let y = 35; y < 47; y++) for (let x = 60; x < 74; x++) pixel(x, y, [10, 80, 200, 100]);
pixel(90, 60, [20, 40, 80, 1]);
const sheet = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
const screenshot = await sharp({ create: { width, height, channels: 3, background: '#aabbcc' } }).png().toBuffer();
const dataUrl = (bytes) => `data:image/png;base64,${bytes.toString('base64')}`;
const sheetFile = path.join(directory, '输入 透明图集.png');
const inputFile = path.join(directory, 'screen.png');
await fs.writeFile(sheetFile, sheet);
await fs.writeFile(inputFile, screenshot);
await fs.writeFile(path.join(directory, 'bad.png'), 'not an image');
const detections = { elements: [
  { label: 'BlankPanel', kind: 'panel', x: 4, y: 4, w: 86, h: 20, layer: 0, description: 'blank panel' },
  { label: 'A<script> & "label"', kind: 'text', x: 10, y: 8, w: 30, h: 12, layer: 1, text: '123', textPolicy: 'separate' },
  { label: 'Coin', kind: 'icon', x: 60, y: 35, w: 14, h: 12, layer: 2, description: 'gold coin' },
] };
const analysisFile = path.join(directory, 'analysis.json');
await fs.writeFile(analysisFile, JSON.stringify(detections));
const styleFile = path.join(directory, 'external-style.json');
await fs.writeFile(styleFile, '\uFEFF' + JSON.stringify({ name: '森林', prompt: '叶绿、奶油色、金边、圆润卡通。' }));
const files = new Map([['generated.png', screenshot], ['approved.png', sheet], ['text.png', sheet]]);
const element = (id, extra = {}) => ({ id, objectName: '../../同名/Coin', label: 'coin', kind: 'icon', state: '',
  rect: { x: 0, y: 0, w: width, h: height }, approved: true,
  slice: { image: 'approved.png', width, height }, ...extra });
const task = { id: 'fixture-task', source: { kind: 'standalone', sourceImage: 'generated.png' }, elements: [
  element('one'), element('two', { coordinateSpace: 'sheet', extractionMethod: 'ai-sheet', repainted: true }),
  element('three', { kind: 'text', slice: { image: 'text.png', width, height } }),
  element('four', { approved: false, slice: { image: 'never-fetch.png', width, height } }),
] };
const segmentPixels = Buffer.alloc(width * height * 4);
const maskPixels = Buffer.alloc(width * height);
for (let y = 6; y < 26; y++) for (let x = 7; x < 27; x++) {
  segmentPixels.set([40, 220, 170, x === 7 ? 100 : 255], (y * width + x) * 4);
  maskPixels[y * width + x] = 255;
}
const rgba = await sharp(segmentPixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
const mask = await sharp(maskPixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
function segmentationResult() {
  return { protocolVersion: 2, width, height, rgbaBase64: rgba.toString('base64'), maskBase64: mask.toString('base64'),
    promptBounds: [8, 8, 20, 20], inferenceBounds: [0, 0, 40, 40], maskBounds: [7, 6, 27, 26], outputBounds: [6, 5, 28, 27],
    quality: { status: 'review', issues: [], removedComponents: 0, removedPixels: 0, retainedComponents: 1 },
    refinement: { method: 'source-alpha', status: 'preserved', softAlphaPixels: 20, changedRgbPixels: 0, trimapRadius: 0 },
    model: 'controlled-fixture-NOT-SAM', elapsedMs: 1, score: 0.9 };
}

const server = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const url = new URL(request.url, 'http://localhost');
    const route = url.pathname.replace(/^\/studio/, '');
    events.push({ route, body, method: request.method, auth: request.headers.authorization, query: url.search });
    const send = (value, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (mode === 'html') { response.end('<!doctype html>static page'); return; }
    if (mode === 'oversize') { response.writeHead(200, { 'Content-Length': 70 * 1024 * 1024 }); response.end('{}'); return; }
    if (mode === 'redirect' && route === '/api/models') { response.writeHead(302, { Location: '/leak' }); response.end(); return; }
    if (mode === 'token-error') { send({ error: 'fixture failure secret-cli-token' }, 502); return; }
    if (route === '/api/health') { send({ gateway: true, status: 'controlled fixture', visionModel: 'fixture' }); return; }
    if (route === '/api/segment-health') { send({ available: mode !== 'missing-sam' }, mode === 'missing-sam' ? 503 : 200); return; }
    if (route === '/api/models') { send({ models: ['fixture-model'] }); return; }
    if (route === '/api/upload' || route === '/api/style-generation/reference') {
      const image = body.image ?? body.dataUrl;
      assert.match(image, /^data:image\/png;base64,/);
      const name = `upload-${files.size}.png`;
      files.set(name, Buffer.from(image.split(',')[1], 'base64'));
      send({ fileName: name }); return;
    }
    if (route === '/api/detect') {
      assert.equal(body.width, width); assert.equal(body.height, height); assert.match(body.system, /ORIGINAL image/);
      send({ content: mode === 'bad-detect' ? '{oops' : JSON.stringify(detections) }); return;
    }
    if (route === '/api/style-generation/analyze') {
      assert.ok(body.referenceImages.every((name) => files.has(name)));
      send({ name: '森林', prompt: '叶绿、奶油色、金边、圆润卡通。', drawingReferences: [] }); return;
    }
    if (route === '/api/generate' || route === '/api/ai-slice-sheet') {
      assert.match(body.wireframe ?? body.reference, /^data:image\/png;base64,/);
      if (body.styleImage) assert.ok(files.has(body.styleImage));
      const answer = () => send({ fileName: route === '/api/generate' ? 'generated.png' : undefined,
        dataUrl: mode === 'bad-image' ? 'data:image/png;base64,AAAA' : dataUrl(route === '/api/generate' ? screenshot : sheet),
        text: 'controlled fixture, NOT model generation' });
      if (mode === 'slow') { pendingTimer = setTimeout(answer, 1200); return; }
      if (mode === 'http-error') { send({ error: 'controlled provider failure' }, 502); return; }
      answer(); return;
    }
    if (route === '/api/segment') {
      assert.deepEqual(body.rect, { x: 8, y: 8, w: 12, h: 12 }); assert.ok(files.has(body.sourceImage));
      const result = segmentationResult();
      if (mode === 'failed-quality') result.quality = { ...result.quality, status: 'failed', issues: [{ code: 'cut-edge', severity: 'error', message: 'fixture edge failure' }] };
      if (mode === 'bad-bounds') result.outputBounds = [-1, 0, 999, 999];
      if (mode === 'bad-prompt') result.promptBounds = [9, 8, 20, 20];
      send(result); return;
    }
    if (route === '/api/slice-tasks') { send({ tasks: [mode === 'unapproved-task' ? { ...task, elements: task.elements.map((item) => ({ ...item, approved: false })) } : task] }); return; }
    if (route === '/api/image') {
      const bytes = files.get(url.searchParams.get('name'));
      if (!bytes) { send({ error: 'missing image' }, 404); return; }
      response.writeHead(200, { 'Content-Type': 'image/png' }); response.end(bytes); return;
    }
    send({ error: `Unexpected route ${route}` }, 404);
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: error.stack }));
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

async function run(args, expectedCode = 0, env = {}) {
  const child = spawn(process.execPath, [entry, ...args, '--json'], {
    cwd: directory, env: { ...process.env, GAMEUI_URL: origin, GAMEUI_TOKEN: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timeout);
  assert.equal(code, expectedCode, `${args.join(' ')}\n${stdout}\n${stderr}`);
  let result;
  try { result = JSON.parse(stdout); } catch { throw Error(`stdout must be one JSON object: ${stdout}; ${stderr}`); }
  assert.equal(result.ok, expectedCode === 0, stdout);
  return { result, stderr, stdout };
}
async function check(name, operation) {
  mode = 'normal';
  await operation();
  reports.push(name);
  console.log(`PASS ${name}`);
}
const out = (name) => path.join(directory, name);
const exists = async (file) => fs.access(file).then(() => true, () => false);

try {
  await check('help / unknown command / strict flags / duplicate flags / timeout range', async () => {
    await run(['health', '--help']);
    await run(['typo'], 2);
    await run(['health', '--typo'], 2);
    await run(['health', '--url', origin, '--url', origin], 2);
    await run(['health', '--timeout', '0'], 2);
    await run(['upload'], 2);
    assert.equal(events.length, 0);
  });
  await check('HTTP health, models, base path, auth header and missing SAM readiness', async () => {
    assert.equal((await run(['health'])).result.data.serviceReachable, true);
    assert.deepEqual((await run(['models', '--url', `${origin}/studio`], 0, { GAMEUI_TOKEN: 'secret-cli-token' })).result.data.models, ['fixture-model']);
    assert.equal(events.at(-1).auth, 'Bearer secret-cli-token');
    await run(['health', '--segment']);
    mode = 'missing-sam';
    assert.equal((await run(['health', '--segment'], 3)).result.error.code, 'DEPENDENCY_UNAVAILABLE');
  });
  await check('unsafe remote HTTP, credentials, path traversal rejected before requests', async () => {
    const before = events.length;
    await run(['models', '--url', 'http://example.com'], 2);
    await run(['models', '--url', 'https://user:pass@example.com'], 2);
    await run(['download', '--name', '../secret.png', '--out', out('secret.png')], 2);
    assert.equal(events.length, before);
  });
  await check('upload from a different cwd and Unicode/space input path', async () => {
    const { data } = (await run(['upload', '--input', sheetFile])).result;
    assert.equal(data.width, width); assert.equal(data.height, height); assert.ok(files.has(data.fileName));
  });
  await check('real JSON detect and PNG/SVG wireframe, escaped labels and normalized coordinates', async () => {
    await run(['detect', '--input', inputFile, '--out', out('elements.json')]);
    const elements = JSON.parse(await fs.readFile(out('elements.json')));
    assert.equal(elements.elements.length, 3);
    await run(['layout', '--input', inputFile, '--out', out('layout')]);
    const layout = JSON.parse(await fs.readFile(out('layout/layout.json')));
    assert.equal(layout.nodes.length, 3); assert.equal(layout.nodes[0].rect.x, 4 / width);
    const svg = await fs.readFile(out('layout/wireframe.svg'), 'utf8');
    // Text node displays its actual text; malicious labels remain data in JSON only.
    assert.ok(!svg.includes('<script>'));
    assert.equal((await sharp(out('layout/wireframe.png')).metadata()).width, width);
  });
  await check('style extraction with multiple uploaded references and explicit model', async () => {
    await run(['style', '--input', inputFile, '--reference', sheetFile, '--model', 'fixture-model', '--out', out('style.json')]);
    const style = JSON.parse(await fs.readFile(out('style.json')));
    assert.equal(style.name, '森林');
    const call = events.findLast((event) => event.route === '/api/style-generation/analyze');
    assert.equal(call.body.referenceImages.length, 2); assert.equal(call.body.model, 'fixture-model');
  });
  await check('generation and AI-sheet are separate explicit endpoints; dimensions are not forced', async () => {
    const result = await run(['generate', '--wireframe', out('layout/wireframe.png'), '--style', out('style.json'),
      '--style-image', inputFile, '--size', '108x192', '--out', out('generated.png')]);
    assert.equal(result.result.data.actualSize, `${width}x${height}`); assert.equal(result.result.data.warnings.length, 1);
    const generation = events.findLast((event) => event.route === '/api/generate');
    assert.match(generation.body.prompt, /叶绿/); assert.ok(generation.body.styleImage);
    await run(['ai-sheet', '--input', inputFile, '--out', out('ai-sheet.png')]);
    assert.match(events.at(-1).body.prompt, /Remove existing UI labels/);
  });
  await check('dry-run and external-response workflows make ZERO HTTP/model requests', async () => {
    const before = events.length;
    for (const args of [
      ['style', '--input', inputFile], ['detect', '--input', inputFile], ['layout', '--input', inputFile],
      ['generate', '--wireframe', inputFile], ['ai-sheet', '--input', inputFile],
      ['segment', '--input', inputFile, '--rect', '8,8,12,12'],
    ]) assert.equal((await run([...args, '--dry-run'])).result.data.modelCalled, false);
    await run(['style', '--input', inputFile, '--response', styleFile, '--out', out('imported-style.json')]);
    await run(['detect', '--input', inputFile, '--response', analysisFile]);
    await run(['layout', '--input', inputFile, '--response', analysisFile, '--out', out('offline-layout')]);
    await run(['generate', '--wireframe', inputFile, '--response', inputFile, '--out', out('imported-effect.png')]);
    await run(['ai-sheet', '--input', inputFile, '--response', sheetFile, '--out', out('imported-sheet.png')]);
    await run(['detect', '--input', inputFile, '--response', analysisFile, '--dry-run'], 2);
    assert.equal(events.length, before);
  });
  await check('offline shared alpha algorithm: two assets, exact visible RGBA, no overlap, residual reporting, real ZIP', async () => {
    const before = events.length;
    const result = await run(['slice-sheet', '--input', sheetFile, '--out', out('cutouts'), '--zip']);
    assert.equal(events.length, before); assert.equal(result.result.data.count, 2);
    assert.equal(result.result.data.diagnostics.ungroupedPixelCount, 1);
    const manifest = JSON.parse(await fs.readFile(out('cutouts/manifest.json')));
    const ownership = new Uint8Array(width * height);
    for (const asset of manifest.assets) {
      assert.equal(asset.approved, false);
      const extracted = await sharp(out(`cutouts/${asset.file}`)).ensureAlpha().raw().toBuffer();
      for (let y = 0; y < asset.height; y++) for (let x = 0; x < asset.width; x++) {
        const offset = (y * asset.width + x) * 4;
        if (!extracted[offset + 3]) continue;
        const sourceIndex = (asset.sourceRect.y + y) * width + asset.sourceRect.x + x;
        assert.equal(ownership[sourceIndex]++, 0, 'pixels must have only one owner');
        assert.deepEqual(extracted.subarray(offset, offset + 4), pixels.subarray(sourceIndex * 4, sourceIndex * 4 + 4));
      }
    }
    const zip = await JSZip.loadAsync(await fs.readFile(out('cutouts/candidates.zip')));
    assert.ok(zip.file('source.png')); assert.ok(zip.file('manifest.json'));
    assert.equal(Object.keys(zip.files).filter((name) => name.startsWith('png/') && name.endsWith('.png')).length, 2);
  });
  await check('opaque screenshot cannot masquerade as transparent sheet; invalid images rejected', async () => {
    assert.equal((await run(['slice-sheet', '--input', inputFile, '--out', out('opaque')], 5)).result.error.code, 'INVALID_SHEET');
    assert.equal(await exists(out('opaque')), false);
    await run(['upload', '--input', out('bad.png')], 2);
  });
  await check('SAM v2 enlarged output bounds, refined RGB and continuous alpha, full mask/diagnostics saved', async () => {
    await run(['segment', '--input', inputFile, '--rect', '8,8,12,12', '--out', out('segmented')]);
    const meta = JSON.parse(await fs.readFile(out('segmented/manifest.json')));
    assert.deepEqual(meta.sourceRect, { x: 6, y: 5, w: 22, h: 22 }); assert.equal(meta.approved, false);
    const actual = await sharp(out('segmented/sprite.png')).ensureAlpha().raw().toBuffer();
    assert.deepEqual([...actual.subarray((1 * 22 + 1) * 4, (1 * 22 + 1) * 4 + 4)], [40, 220, 170, 100]);
    assert.equal((await sharp(out('segmented/mask.png')).metadata()).width, width);
  });
  await check('SAM failed quality is exit 5 with retained evidence; malformed bounds/prompt rejected', async () => {
    mode = 'failed-quality';
    const failed = await run(['segment', '--input', inputFile, '--rect', '8,8,12,12', '--out', out('failed-quality')], 5);
    assert.ok(failed.result.error.details.outputDirectory); assert.ok(await exists(out('failed-quality/manifest.json')));
    mode = 'bad-bounds';
    await run(['segment', '--input', inputFile, '--rect', '8,8,12,12', '--out', out('bad-bounds')], 3);
    assert.equal(await exists(out('bad-bounds')), false);
    mode = 'bad-prompt';
    await run(['segment', '--input', inputFile, '--rect', '8,8,12,12', '--out', out('bad-prompt')], 3);
  });
  await check('SAM rect/points validation happens before upload', async () => {
    const before = events.length;
    await fs.writeFile(out('points.json'), JSON.stringify([{ x: 200, y: 2, label: 1 }]));
    await run(['segment', '--input', inputFile, '--rect', '8,8,12,12', '--points', out('points.json'), '--out', out('invalid-points')], 2);
    await run(['segment', '--input', inputFile, '--rect', '8,8,1200,12', '--out', out('invalid-rect')], 2);
    assert.equal(events.length, before);
  });
  await check('task list/get and approved-only ZIP: text opt-in, safe unique names and sheet coordinates', async () => {
    await run(['tasks']);
    assert.equal((await run(['tasks', '--id', task.id])).result.data.id, task.id);
    await run(['tasks', '--id', 'missing'], 3);
    const result = await run(['export', '--task', task.id, '--out', out('assets.zip')]);
    assert.equal(result.result.data.count, 2); assert.equal(result.result.data.needsPlacement, 1);
    const zip = await JSZip.loadAsync(await fs.readFile(out('assets.zip')));
    const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
    assert.equal(manifest.assets[1].originalScreenRect, null);
    assert.notEqual(manifest.assets[0].fileName, manifest.assets[1].fileName);
    assert.ok(manifest.assets.every((asset) => !asset.fileName.includes('/') && !asset.fileName.includes('..')));
    assert.deepEqual(await zip.file(`png/${manifest.assets[0].fileName}`).async('nodebuffer'), sheet);
    assert.equal(events.some((event) => event.query?.includes('never-fetch')), false);
    assert.equal((await run(['export', '--task', task.id, '--out', out('with-text.zip'), '--include-text'])).result.data.count, 3);
    mode = 'unapproved-task';
    await run(['export', '--task', task.id, '--out', out('no-approved.zip')], 5);
    assert.equal(await exists(out('no-approved.zip')), false);
  });
  await check('PNG download preserves bytes; no overwrite without force; existing directory protected', async () => {
    const args = ['download', '--name', 'approved.png', '--out', out('download.png')];
    await run(args); assert.deepEqual(await fs.readFile(out('download.png')), sheet);
    const before = events.length;
    await run(args, 2); assert.equal(events.length, before);
    await run([...args, '--force']);
    await run(['slice-sheet', '--input', sheetFile, '--out', out('cutouts'), '--force'], 2);
  });
  await check('generation preflight refuses existing output and symlink BEFORE paid submission', async () => {
    const before = events.length;
    await run(['generate', '--wireframe', inputFile, '--out', out('generated.png')], 2);
    if (process.platform === 'win32') await fs.symlink(out('cutouts'), out('linked.png'), 'junction');
    else await fs.symlink(out('generated.png'), out('linked.png'));
    await run(['generate', '--wireframe', inputFile, '--out', out('linked.png'), '--force'], 2);
    assert.equal(events.length, before);
  });
  await check('HTTP error, bad model JSON/image, HTML static server, response size bound and redirect refusal', async () => {
    mode = 'http-error';
    const failed = await run(['generate', '--wireframe', inputFile, '--out', out('http-failure.png')], 3);
    assert.equal(failed.result.error.details.mayHaveBeenSubmitted, true);
    mode = 'bad-detect'; await run(['detect', '--input', inputFile], 3);
    mode = 'bad-image'; await run(['generate', '--wireframe', inputFile, '--out', out('bad-result.png')], 3);
    mode = 'html'; await run(['health'], 3);
    mode = 'oversize'; await run(['models'], 3);
    mode = 'redirect'; await run(['models'], 3);
    assert.equal(events.some((event) => event.route === '/leak'), false);
  });
  await check('token never appears in JSON or stderr on provider error', async () => {
    mode = 'token-error';
    const result = await run(['models'], 3, { GAMEUI_TOKEN: 'secret-cli-token' });
    assert.equal(result.stdout.includes('secret-cli-token'), false); assert.equal(result.stderr.includes('secret-cli-token'), false);
  });
  await check('timeout: one POST only, uncertain submission recorded, no output, no automatic retry', async () => {
    mode = 'slow';
    const before = events.filter((event) => event.route === '/api/generate').length;
    const result = await run(['generate', '--wireframe', inputFile, '--timeout', '250', '--out', out('timed-out.png')], 4);
    assert.equal(result.result.error.code, 'TIMEOUT'); assert.equal(result.result.error.details.mayHaveBeenSubmitted, true);
    assert.equal(result.result.error.details.retried, false);
    assert.equal(events.filter((event) => event.route === '/api/generate').length - before, 1);
    assert.equal(await exists(out('timed-out.png')), false);
    clearTimeout(pendingTimer);
  });
  await check('prompt file, size/port validation and contradictory generation inputs', async () => {
    const before = events.length;
    await fs.writeFile(out('prompt.txt'), 'Use golden rounded panels.');
    const planned = await run(['generate', '--wireframe', inputFile, '--prompt-file', out('prompt.txt'), '--dry-run']);
    assert.equal(planned.result.data.body.prompt, 'Use golden rounded panels.');
    await run(['generate', '--wireframe', inputFile, '--size', '0x200', '--dry-run'], 2);
    await run(['generate', '--wireframe', inputFile, '--size', '8192x8192', '--dry-run'], 2);
    await run(['generate', '--wireframe', inputFile, '--prompt', 'x', '--prompt-file', out('prompt.txt'), '--dry-run'], 2);
    await run(['serve', '--port', '0'], 2);
    await run(['serve', '--port', '65536'], 2);
    assert.equal(events.length, before);
  });
  await check('no abandoned staging directories after success and failure', async () => {
    assert.equal((await fs.readdir(directory)).some((name) => name.startsWith('.gameui-')), false);
  });
  console.log(`\nPASS ${reports.length} CLI groups; real PNG/ZIP and shared pixel algorithms; controlled HTTP model/SAM responses only.`);
  if (process.env.GAMEUI_CLI_TEST_REPORT) await fs.writeFile(process.env.GAMEUI_CLI_TEST_REPORT, JSON.stringify({
    passed: reports.length, groups: reports, modelInference: false, transport: 'real local HTTP + CLI subprocesses',
    directory, node: process.version, imageLibrary: sharp.versions.sharp,
  }, null, 2));
} finally {
  clearTimeout(pendingTimer);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (!process.env.GAMEUI_CLI_KEEP_TEST_FILES) await fs.rm(directory, { recursive: true, force: true });
}
