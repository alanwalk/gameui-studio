import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

// This is a controlled provider fixture, not an assertion about real image generation quality.
const PNG = (await sharp({ create: { width: 12, height: 8, channels: 3, background: '#80b858' } }).png().toBuffer()).toString('base64');
const asset = { base64: PNG, text: 'controlled PNG fixture', isError: false };
const MISMATCH = await sharp({ create: { width: 1774, height: 887, channels: 3, background: '#5e918b' } }).png().toBuffer();

if (process.env.DRAWING_TEST_CHILD === '1') {
  const { createDrawingHandler } = await import('../server/drawingApi.ts');
  const directory = process.env.GAMEUI_DATA;
  const event = async (value) => fs.appendFile(path.join(directory, 'provider.jsonl'), JSON.stringify(value) + '\n');
  const drawing = createDrawingHandler({
    async generateImage(args) {
      const inputPrompt = args.prompt.split('\n\nCanvas requirements:')[0];
      await event({ kind: 'generate', ...args, inputPrompt });
      if (inputPrompt === 'ratio-mismatch') return { base64: MISMATCH.toString('base64'), text: '', isError: false };
      if (inputPrompt === 'unknown-window') { await new Promise(() => {}); }
      if (inputPrompt === 'uncertain') throw new Error('controlled transport response lost');
      if (inputPrompt === 'invalid-result') return { base64: 'bm90LWFuLWltYWdl', text: '', isError: false };
      if (inputPrompt.startsWith('malformed-')) {
        const format = inputPrompt.split('-').at(-1);
        const bytes = await fs.readFile(path.join(directory, `bad.${format}`));
        if (inputPrompt.includes('-path-')) { await fs.writeFile(args.path, bytes); return { path: args.path, text: '', isError: false }; }
        return { base64: bytes.toString('base64'), text: '', isError: false };
      }
      if (inputPrompt === 'oriented-jpeg') return { base64: (await fs.readFile(path.join(directory, 'oriented.jpg'))).toString('base64'), text: '', isError: false };
      if (inputPrompt === 'pending-bad-png') return { pendingId: 'controlled-bad-png', text: 'still running', isError: false };
      if (inputPrompt === 'pending') return { pendingId: 'controlled-pending-123', text: 'still running', isError: false };
      if (inputPrompt === 'path-result') { await fs.writeFile(args.path, Buffer.from(PNG, 'base64')); return { path: args.path, text: '', isError: false }; }
      return asset;
    },
    async waitForGeneration(args) {
      await event({ kind: 'wait', ...args });
      while (true) {
        try { await fs.access(path.join(directory, 'release')); break; } catch { await delay(40); }
      }
      if (args.pendingId === 'controlled-bad-png') return { base64: (await fs.readFile(path.join(directory, 'bad.png'))).toString('base64'), text: '', isError: false };
      return asset;
    },
  });
  const server = http.createServer((req, res) => {
    void drawing.handle(req, res, () => { res.statusCode = 404; res.end('not drawing'); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.send?.({ port: server.address().port });
} else {
  const { build } = await import('esbuild');
  const directory = path.resolve('.data', `drawing-test-${Date.now()}-${randomUUID()}`);
  await fs.mkdir(directory, { recursive: true });
  const runner = path.join(directory, 'runner.mjs');
  await build({ entryPoints: ['scripts/test-drawing-api.mjs'], bundle: true, platform: 'node', format: 'esm', outfile: runner, external: ['esbuild', 'sharp'], logLevel: 'warning' });
  let child;
  let origin;
  let launchCount = 0;
  async function launch() {
    child = spawn(process.execPath, [runner], { env: { ...process.env, DRAWING_TEST_CHILD: '1', GAMEUI_DATA: directory }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const output = await fs.open(path.join(directory, `server-${++launchCount}.log`), 'a');
    child.stdout.on('data', (chunk) => { void output.appendFile(chunk); });
    child.stderr.on('data', (chunk) => { void output.appendFile(chunk); });
    child.once('close', () => { void output.close(); });
    const startTimeout = AbortSignal.timeout(10000);
    const message = await Promise.race([once(child, 'message', { signal: startTimeout }), once(child, 'exit', { signal: startTimeout }).then(([code]) => { throw new Error(`test server exited ${code}`); })]);
    origin = `http://127.0.0.1:${message[0].port}`;
  }
  async function stop() {
    if (!child || child.exitCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
  async function api(route, body, expected = 200) {
    const response = await fetch(origin + '/api/drawing/' + route, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function waitFor(check, name) {
    for (let attempt = 0; attempt < 150; attempt++) {
      const result = await check();
      if (result) return result;
      await delay(40);
    }
    throw new Error(`timeout: ${name}`);
  }
  async function events() {
    try { return (await fs.readFile(path.join(directory, 'provider.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async function waitTask(id, status) {
    return waitFor(async () => (await api('state')).tasks.find((task) => task.id === id && task.status === status), `task ${status}`);
  }
  async function create(prompt, references = [], ratio = '1:1', size) {
    const before = new Set((await api('state')).tasks.map((task) => task.id));
    const state = await api('tasks', { prompt, references, ratio, size }, 202);
    return state.tasks.find((task) => !before.has(task.id));
  }
  try {
    await launch();
    assert.deepEqual(await api('state'), { tasks: [], images: [] });
    const images = await Promise.all(Array.from({ length: 8 }, (_, i) => api('images', { name: `ref-${i}.png`, dataUrl: `data:image/png;base64,${PNG}` }, 201)));
    assert.equal((await api('state')).images.length, 8, 'concurrent transactions must not lose uploads');
    const upload = images[0];
    const imageResponse = await fetch(origin + `/api/drawing/images/${upload.id}?download=1`);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.match(imageResponse.headers.get('content-disposition'), /attachment/);
    const normalizedPng = Buffer.from(await imageResponse.arrayBuffer());
    const uploadedDecoded = await sharp(normalizedPng).raw().toBuffer({ resolveWithObject: true });
    assert.equal(upload.mime, 'image/png');
    assert.equal(upload.width, 12); assert.equal(upload.height, 8);
    assert.equal(uploadedDecoded.info.width, 12); assert.equal(uploadedDecoded.info.height, 8);
    for (const ratio of ['1:1', '2:3', '3:2']) {
      const references = ratio === '3:2' ? images.slice(0, 5).map((image) => image.id) : [upload.id];
      const task = await create(`fixture-${ratio}`, references, ratio);
      const done = await waitTask(task.id, 'done');
      assert.ok(done.result);
      assert.deepEqual(done.references, references);
      assert.equal(done.ratio, ratio);
      assert.equal(done.prompt, `fixture-${ratio}`, 'persisted prompt must stay exactly as authored');
      assert.deepEqual(done.resultSize, { width: 12, height: 8 }, 'actual decoded dimensions must be distinct from requested ratio');
      assert.equal(done.watchPath, undefined, 'private file paths must not be returned');
      const generated = (await events()).find((event) => event.kind === 'generate' && event.inputPrompt === `fixture-${ratio}`);
      const expected = { '1:1': '1024x1024', '2:3': '1024x1536', '3:2': '1536x1024' };
      assert.equal(generated.size, expected[ratio]);
      assert.ok(generated.prompt.startsWith(`fixture-${ratio}\n\nCanvas requirements:`));
      assert.ok(generated.prompt.includes(`Request a ${ratio} canvas at ${expected[ratio]} pixels`));
      assert.ok(generated.prompt.includes('do not crop the main subject'));
      assert.equal(generated.referenceImages.length, references.length);
      assert.equal((await sharp(await fs.readFile(generated.referenceImages[0])).metadata()).format, 'png');
    }
    const custom = await create('fixture-custom', [], 'custom', '1600x900');
    assert.equal((await waitTask(custom.id, 'done')).size, '1600x900');
    assert.equal((await events()).find(event => event.inputPrompt === 'fixture-custom').size, '1600x900');
    for (const size of ['0x900', '-1x900', '100.5x900', '9000x100', '8192x8192', 'auto', undefined]) {
      await api('tasks', { prompt: 'invalid-custom', references: [], ratio: 'custom', size }, 400);
    }
    const pathResult = await create('path-result'); await waitTask(pathResult.id, 'done');
    await api('tasks', { prompt: '', references: [], ratio: '1:1' }, 400);
    await api('tasks', { prompt: 'x'.repeat(12001), references: [], ratio: '1:1' }, 400);
    await api('tasks', { prompt: 'x', references: [], ratio: '16:9' }, 400);
    await api('tasks', { prompt: 'x', references: images.slice(0, 6).map((image) => image.id), ratio: '1:1' }, 400);
    await api('tasks', { prompt: 'x', references: [upload.id, upload.id], ratio: '1:1' }, 400);
    await api('tasks', { prompt: 'x', references: ['C:/Windows/win.ini'], ratio: '1:1' }, 400);
    await api('tasks', { prompt: 'x', references: [randomUUID()], ratio: '1:1' }, 400);
    await api('tasks', { prompt: 'x', references: [], ratio: '1:1', path: 'C:/Windows/x.png' }, 400);
    await api('tasks', { prompt: 'x', references: [], ratio: '1:1', model: 'invented-model' }, 400);
    await api('images', { name: 'bad.png', dataUrl: 'data:image/png;base64,bm90LWFuLWltYWdl' }, 400);
    await api('images', { name: 'bad.webp', dataUrl: `data:image/webp;base64,${PNG}` }, 400);
    assert.equal((await fetch(origin + '/api/drawing/images/not-a-valid-id')).status, 404);
    assert.equal((await fetch(origin + '/api/drawing/images/%2e%2e%2findex.json')).status, 404);
    assert.equal((await fetch(origin + '/api/drawing/tasks', { method: 'POST', body: '{' })).status, 400);
    const failed = await create('invalid-result');
    const invalid = await waitTask(failed.id, 'failed');
    assert.equal(invalid.result, undefined);
    const uncertain = await create('uncertain');
    const interrupted = await waitTask(uncertain.id, 'interrupted');
    assert.match(interrupted.error, /可能已计费/);
    await api(`tasks/${uncertain.id}/retry`, {}, 409);
    const generateCount = (await events()).filter((event) => event.kind === 'generate').length;
    await fs.writeFile(path.join(directory, 'release'), 'yes');
    await api(`tasks/${uncertain.id}/resume`, {}, 202); await waitTask(uncertain.id, 'done');
    assert.equal((await events()).filter((event) => event.kind === 'generate').length, generateCount, 'resume must never generate again');
    const retryState = await api(`tasks/${failed.id}/retry`, { confirmNewCharge: true }, 202);
    const retried = retryState.tasks.find((task) => task.retryOf === failed.id);
    assert.ok(retried); assert.equal(retried.prompt, failed.prompt);
    await waitTask(retried.id, 'failed');
    await fs.rm(path.join(directory, 'release'));
    const pending = await create('pending', [upload.id], '2:3');
    await waitFor(async () => {
      const index = JSON.parse(await fs.readFile(path.join(directory, 'drawing/index.json'), 'utf8'));
      return index.tasks.find((task) => task.id === pending.id && task.pendingId === 'controlled-pending-123' && task.watchPath && task.submitted);
    }, 'durable pending checkpoint');
    const beforeRestart = (await events()).filter((event) => event.kind === 'generate').length;
    await stop();
    await launch();
    await waitFor(async () => (await events()).filter((event) => event.kind === 'wait' && event.pendingId === 'controlled-pending-123').length >= 2, 'restart resumes wait');
    await fs.writeFile(path.join(directory, 'release'), 'yes');
    const restored = await waitTask(pending.id, 'done');
    assert.equal(restored.size, '1024x1536');
    assert.equal((await events()).filter((event) => event.kind === 'generate').length, beforeRestart, 'process restart must not resubmit paid generation');
    const unknown = await create('unknown-window');
    await waitFor(async () => (await events()).some((entry) => entry.kind === 'generate' && entry.inputPrompt === 'unknown-window'), 'submission without response');
    const unknownCount = (await events()).filter((event) => event.kind === 'generate').length;
    await stop();
    await launch();
    await waitTask(unknown.id, 'done');
    assert.equal((await events()).filter((event) => event.kind === 'generate').length, unknownCount, 'unknown response window must recover using persisted watchPath, not generate again');
    // Preserve headers/dimensions accepted by the old parser while removing encoded pixel data.
    const badPng = Buffer.from(PNG, 'base64');
    const idat = badPng.indexOf(Buffer.from('IDAT'));
    badPng.fill(0, idat + 4, idat + 4 + badPng.readUInt32BE(idat - 4));
    const jpeg = await sharp(Buffer.from(PNG, 'base64')).jpeg().toBuffer();
    const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
    const badJpeg = Buffer.concat([jpeg.subarray(0, scan), Buffer.from([0xff, 0xd9])]);
    const webp = await sharp(Buffer.from(PNG, 'base64')).webp().toBuffer();
    const badWebp = Buffer.from(webp.subarray(0, 30)); badWebp.writeUInt32LE(badWebp.length - 8, 4);
    const badFormats = { png: badPng, jpeg: badJpeg, webp: badWebp };
    for (const [format, bytes] of Object.entries(badFormats)) {
      await fs.writeFile(path.join(directory, `bad.${format}`), bytes);
      const imageCount = (await api('state')).images.length;
      const rejected = await api('images', { name: `bad.${format}`, dataUrl: `data:image/${format};base64,${bytes.toString('base64')}` }, 400);
      assert.match(rejected.error, /解码/);
      assert.equal((await api('state')).images.length, imageCount, 'bad upload must not be persisted');
      const task = await create(`malformed-${format}`);
      const rejectedTask = await waitTask(task.id, 'failed');
      assert.equal(rejectedTask.result, undefined); assert.equal(rejectedTask.resultSize, undefined);
      assert.match(rejectedTask.error, /解码/);
    }
    const badPath = await create('malformed-path-png'); assert.equal((await waitTask(badPath.id, 'failed')).result, undefined);
    const waitCount = (await events()).filter((event) => event.kind === 'generate').length;
    const badPending = await create('pending-bad-png'); await waitTask(badPending.id, 'failed');
    await api(`tasks/${badPending.id}/resume`, {}, 202); await waitTask(badPending.id, 'failed');
    assert.equal((await events()).filter((event) => event.kind === 'generate').length, waitCount + 1, 'bad pending result may be rechecked but never resubmitted automatically');
    const pixels = Buffer.alloc(12 * 8 * 3);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
      const offset = (y * 12 + x) * 3;
      pixels[offset] = x < 6 ? 240 : 10;
      pixels[offset + 1] = 10;
      pixels[offset + 2] = x < 6 ? 10 : 240;
    }
    const oriented = await sharp(pixels, { raw: { width: 12, height: 8, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toBuffer();
    await fs.writeFile(path.join(directory, 'oriented.jpg'), oriented);
    const orientedUpload = await api('images', { name: 'orientation-6.jpg', dataUrl: `data:image/jpeg;base64,${oriented.toString('base64')}` }, 201);
    assert.equal(orientedUpload.mime, 'image/png'); assert.equal(orientedUpload.width, 8); assert.equal(orientedUpload.height, 12);
    const orientedResponse = await fetch(origin + `/api/drawing/images/${orientedUpload.id}?download=1`);
    assert.equal(orientedResponse.headers.get('content-type'), 'image/png');
    const normalized = await sharp(Buffer.from(await orientedResponse.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    assert.equal(normalized.info.width, 8); assert.equal(normalized.info.height, 12);
    assert.ok(normalized.data[0] > 200 && normalized.data[2] < 50, 'orientation 6 rotates red left half to top');
    const bottom = (11 * 8) * normalized.info.channels;
    assert.ok(normalized.data[bottom] < 50 && normalized.data[bottom + 2] > 200, 'blue right half must be at bottom');
    const orientedTask = await create('oriented-jpeg', [orientedUpload.id], '2:3');
    const orientedDone = await waitTask(orientedTask.id, 'done');
    assert.deepEqual(orientedDone.resultSize, { width: 8, height: 12 });
    assert.equal(orientedDone.ratio, '2:3'); assert.equal(orientedDone.size, '1024x1536');
    const orientedEvent = (await events()).find((entry) => entry.kind === 'generate' && entry.inputPrompt === 'oriented-jpeg');
    const forwarded = await sharp(await fs.readFile(orientedEvent.referenceImages[0])).metadata();
    assert.equal(forwarded.format, 'png'); assert.equal(forwarded.width, 8); assert.equal(forwarded.height, 12); assert.equal(forwarded.orientation, undefined);
    const mismatchTask = await create('ratio-mismatch');
    const mismatch = await waitTask(mismatchTask.id, 'done');
    assert.equal(mismatch.prompt, 'ratio-mismatch');
    assert.equal(mismatch.ratio, '1:1'); assert.equal(mismatch.size, '1024x1024');
    assert.deepEqual(mismatch.resultSize, { width: 1774, height: 887 });
    const downloadedMismatch = await fetch(origin + `/api/drawing/images/${mismatch.result}?download=1`);
    const downloadedBytes = Buffer.from(await downloadedMismatch.arrayBuffer());
    const expectedPng = await sharp(MISMATCH).rotate().png().toBuffer();
    assert.deepEqual(downloadedBytes, expectedPng, 'ratio mismatch must not change the existing PNG byte export pipeline');
    const mismatchDecoded = await sharp(downloadedBytes).metadata();
    assert.equal(mismatchDecoded.width, 1774); assert.equal(mismatchDecoded.height, 887);
    const state = await api('state');
    assert.equal(state.tasks.length, 17);
    const indexText = await fs.readFile(path.join(directory, 'drawing/index.json'), 'utf8');
    assert.ok(!indexText.includes(PNG), 'index must not embed image base64');
    const persisted = JSON.parse(indexText);
    assert.ok(persisted.tasks.every((task) => !task.result || persisted.images.some((image) => image.id === task.result)));
    console.log(JSON.stringify({ ok: true, tests: 'HTTP upload/download, atomic concurrent writes, all ratios, prompt/reference snapshots, input/path boundaries, malformed output, explicit charged retry, transport uncertainty, resume, real process restart without re-generation', provider: 'controlled fixture; no real image generation acceptance claimed', tasks: state.tasks.length, evidence: directory }));
  } finally { await stop(); }
}
