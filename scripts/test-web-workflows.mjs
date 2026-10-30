import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { createServer } from 'vite';
import sharp from 'sharp';
import JSZip from 'jszip';

// Only the paid image provider and vision gateway are controlled. All UI, routes,
// image decoding, persistence, Canvas export and download code comes from the repo.
const root = process.cwd();
const directory = await fs.mkdtemp(path.join(root, '.data', 'web-e2e-'));
const log = path.join(directory, 'stdout-stderr.log');
const originalWrite = { stdout: process.stdout.write.bind(process.stdout), stderr: process.stderr.write.bind(process.stderr) };
const logHandle = await fs.open(log, 'a');
for (const stream of ['stdout', 'stderr']) {
  process[stream].write = (chunk, encoding, callback) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    void logHandle.write(bytes).catch(() => {});
    return originalWrite[stream](chunk, encoding, callback);
  };
}
console.log(`Evidence: ${directory}`);
const results = [];
const providerEvents = [];
const apiEvents = [];
const browserErrors = [];
const sourceHashes = {};
const pending = new Map();
let control = { pending: false, failPath: '', failConsumed: false, outputSize: undefined };
let browser;
let vite;
let server;
let page;
let base;
let fatal;
const previousData = process.env.GAMEUI_DATA;
const previousGateway = process.env.MAGPIE_GATEWAY;
const nativeFetch = globalThis.fetch;
process.env.GAMEUI_DATA = path.join(directory, 'store');
process.env.MAGPIE_GATEWAY = 'http://web-e2e.invalid/v1';
const deadline = setTimeout(() => {
  console.error('GLOBAL TIMEOUT: 8 minutes');
  void browser?.close();
  server?.closeAllConnections();
  server?.close();
  void vite?.close();
  process.exitCode = 2;
}, 480_000);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const png = (width, height, background = '#73bca9') => sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
const persist = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2));
async function until(predicate, description, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await delay(40);
  }
  throw new Error(`Timed out: ${description}`);
}
async function api(route, body, method = 'POST') {
  const options = body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const response = await nativeFetch(base + route, options);
  const value = await response.json();
  assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
const projects = async () => (await api('/api/projects')).projects;
const project = async () => (await projects()).find((entry) => entry.id === 'legacy-project');
const screen = async () => (await project()).screens[0];
async function navigate(view) {
  await page.locator('.view-tab').getByText(view, { exact: true }).click();
}
async function studio(stage = '2 · 生成') {
  await navigate('工作台');
  await page.getByRole('button', { name: stage, exact: true }).click();
}
async function reload(view) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '旧项目 E2E', exact: true }).waitFor();
  await page.getByRole('button', { name: '旧项目 E2E', exact: true }).click();
  if (view) await navigate(view);
}
async function imagesDecoded(selector, count) {
  await until(() => page.locator(selector).evaluateAll((images, expected) => images.length === expected && images.every((img) => img.complete && img.naturalWidth > 0), count), `decode ${selector}`);
}
async function flow(name, action) {
  if (process.env.WEB_WORKFLOWS_GROUP && !name.startsWith(process.env.WEB_WORKFLOWS_GROUP)) {
    results.push({ name, status: 'NOT_RUN', reason: 'group filter' });
    return;
  }
  console.log(`START ${name}`);
  const start = Date.now();
  const firstCall = providerEvents.length;
  try {
    await action();
    results.push({ name, status: 'PASS', durationMs: Date.now() - start, providerCalls: providerEvents.length - firstCall });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.stack, durationMs: Date.now() - start, providerCalls: providerEvents.length - firstCall });
    console.error(`FAIL ${name}: ${error.stack}`);
    await fs.writeFile(path.join(directory, `${name}.html`), await page.content()).catch(() => {});
    await fs.writeFile(path.join(directory, `${name}.txt`), await page.locator('body').innerText()).catch(() => {});
  } finally {
    await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
    await persist('results.json', results);
    await persist('provider-calls.json', providerEvents);
  }
}
async function download(button, name) {
  const event = page.waitForEvent('download', { timeout: 12000 });
  await button.click();
  const item = await event;
  assert.equal(await item.failure(), null);
  const output = path.join(directory, name);
  await item.saveAs(output);
  assert.ok((await fs.stat(output)).size > 0);
  return fs.readFile(output);
}

try {
  const playwrightPath = process.env.WEB_WORKFLOWS_PLAYWRIGHT || 'playwright';
  const { chromium } = await import(path.isAbsolute(playwrightPath) ? pathToFileURL(playwrightPath).href : playwrightPath);
  globalThis.__webWorkflowsProvider = {
    async generateImage(args) {
      const references = [];
      for (const file of args.referenceImages ?? []) {
        const bytes = await fs.readFile(file);
        const metadata = await sharp(bytes).metadata();
        references.push({ path: file, sha256: hash(bytes), width: metadata.width, height: metadata.height });
      }
      const event = { method: 'generateImage', at: Date.now(), args, references, controlled: true };
      providerEvents.push(event);
      await persist('provider-calls.json', providerEvents);
      await delay(400);
      if (control.failPath && args.prompt.includes(control.failPath) && !control.failConsumed) {
        control.failConsumed = true;
        event.outcome = 'controlled failure';
        // The real Magpie boundary throws when its tool reports isError.
        throw new Error('CONTROLLED provider failure, not a real model');
      }
      const dimensions = control.outputSize || args.size || args.prompt.match(/Fit a (\d+x\d+) pixel box/)?.[1] || '1024x1024';
      event.controlledOutputSize = dimensions;
      const [width, height] = dimensions.split('x').map(Number);
      const bytes = await png(width, height);
      const asset = { base64: bytes.toString('base64'), isError: false, text: 'CONTROLLED valid PNG; no real model call' };
      if (control.pending) {
        const pendingId = `controlled-${providerEvents.length}`;
        pending.set(pendingId, { asset, args });
        event.outcome = 'controlled pending';
        return { pendingId, isError: false, text: 'CONTROLLED pending' };
      }
      event.completedAt = Date.now();
      event.outcome = 'PNG';
      return asset;
    },
    async waitForGeneration(args) {
      const event = { method: 'waitForGeneration', at: Date.now(), args, controlled: true };
      providerEvents.push(event);
      await persist('provider-calls.json', providerEvents);
      await delay(400);
      const job = pending.get(args.pendingId) || [...pending.values()].find((entry) => entry.args.path === args.watchPath);
      assert.ok(job, 'controlled pending job must exist');
      event.completedAt = Date.now();
      return job.asset;
    },
  };
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith(process.env.MAGPIE_GATEWAY)) return nativeFetch(url, options);
    const body = options?.body ? JSON.parse(options.body) : undefined;
    const event = { method: 'visionGateway.fetch', at: Date.now(), url: String(url), body, controlled: true };
    providerEvents.push(event);
    await delay(400);
    if (String(url).endsWith('/models')) return Response.json({ data: [{ id: 'controlled-image-model' }, { id: 'codex/gpt-6.1-terra' }] });
    let content;
    const system = body.messages?.find((message) => message.role === 'system')?.content || '';
    if (system.includes('"name"') && system.includes('"prompt"')) {
      const textOnly = JSON.stringify(body.messages).includes('TEXT_ONLY');
      content = JSON.stringify({ name: textOnly ? '文字画风 E2E' : '参考画风 E2E', prompt: 'CONTROLLED_STYLE_PROMPT: blue stone, warm gold, hand-painted UI; not a real model' });
    } else {
      content = JSON.stringify({ elements: [{ label: 'Controlled reference button', kind: 'button', x: 8, y: 8, w: 40, h: 24, layer: 1, description: 'reference-only button' }] });
    }
    event.completedAt = Date.now();
    return Response.json({ choices: [{ message: { content } }] });
  };
  const frozenBuild = async (options) => {
    const result = await build({ ...options, metafile: true, logLevel: 'warning' });
    for (const file of Object.keys(result.metafile.inputs)) {
      if (!file.startsWith('node_modules/') && !file.startsWith('<')) {
        sourceHashes[file] = hash(await fs.readFile(file));
      }
    }
    return result;
  };
  await frozenBuild({ entryPoints: ['src/main.tsx'], bundle: true, platform: 'browser', format: 'esm', jsx: 'automatic', outfile: path.join(directory, 'app.js'), define: { 'process.env.NODE_ENV': '"production"' } });
  await frozenBuild({ entryPoints: ['server/apiPlugin.ts'], bundle: true, platform: 'node', format: 'esm', outfile: path.join(directory, 'api.mjs'), packages: 'external', plugins: [{ name: 'controlled-image-boundary', setup(builder) {
    builder.onLoad({ filter: /[\\/]server[\\/]magpieMcp\.ts$/ }, () => ({ contents: 'export const generateImage = (...args) => globalThis.__webWorkflowsProvider.generateImage(...args); export const waitForGeneration = (...args) => globalThis.__webWorkflowsProvider.waitForGeneration(...args);', loader: 'js' }));
  } }] });
  await persist('source-hashes.json', sourceHashes);
  const { magpieApi } = await import(pathToFileURL(path.join(directory, 'api.mjs')).href);
  vite = await createServer({ configFile: false, root, cacheDir: path.join(directory, 'vite-cache'), plugins: [magpieApi()], appType: 'custom', server: { middlewareMode: true, watch: null, hmr: false, ws: false } });
  server = http.createServer((req, res) => {
    const event = { method: req.method, url: req.url, at: Date.now() };
    if (req.url.startsWith('/api/')) apiEvents.push(event);
    res.once('finish', () => { event.status = res.statusCode; event.finishedAt = Date.now(); });
    if (req.url.startsWith('/api/')) { vite.middlewares(req, res, () => { res.statusCode = 404; res.end('No actual API route'); }); return; }
    if (req.url === '/app.js' || req.url === '/app.css') {
      const file = req.url.slice(1);
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
      void fs.readFile(path.join(directory, file)).then((bytes) => res.end(bytes));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  const source = await png(96, 64, '#cc8844');
  const sourceFile = path.join(directory, 'reference.png');
  await fs.writeFile(sourceFile, source);
  const upload = await api('/api/upload', { image: `data:image/png;base64,${source.toString('base64')}`, prefix: 'web-e2e-source' });
  const now = Date.now();
  const style = { id: 'e2e-style', name: '旧风格 E2E', prompt: 'OLD_STYLE_SNAPSHOT', image: upload.fileName, createdAt: now, updatedAt: now };
  await api('/api/styles', { style }, 'PUT');
  const legacy = { id: 'legacy-project', name: '旧项目 E2E', stylePrompt: style.prompt, styleImage: upload.fileName, orientation: 'landscape', size: { w: 1920, h: 1080 }, createdAt: now, updatedAt: now,
    screens: [{ id: 'legacy-screen', name: '来源界面 A', usage: 'WEB_E2E_GENERATION', layout: [], activeVersionId: 'legacy-version', versions: [{ id: 'legacy-version', image: upload.fileName, prompt: 'legacy imported schema', createdAt: now }] }, { id: 'other-screen', name: '隔离界面 B', usage: '', layout: [], versions: [] }] };
  await api('/api/projects', { project: legacy }, 'PUT');
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, acceptDownloads: true });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', (error) => { browserErrors.push(error.stack); console.error(`BROWSER ${error.stack}`); });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(base);
  await page.getByRole('button', { name: '旧项目 E2E', exact: true }).waitFor();

  await flow('project-refine-metadata-compare', async () => {
    await studio();
    await imagesDecoded('.version-figure img', 1);
    assert.equal((await screen()).versions.length, 1);
    await page.getByLabel('基于此版本微调').fill('WEB_E2E_REFINE gold button');
    const first = providerEvents.length;
    await page.getByRole('button', { name: '生成微调版本', exact: true }).click();
    await until(async () => {
      const versions = (await screen()).versions;
      return versions.length === 2 && versions[1].image;
    }, 'completed refined version persisted');
    const versions = (await screen()).versions;
    assert.equal(versions[1].parentVersionId, 'legacy-version');
    assert.equal(versions[1].operation, 'refine');
    assert.equal(versions[1].styleSnapshot.prompt, style.prompt);
    assert.equal(versions[0].image, upload.fileName);
    const call = providerEvents.slice(first).find((entry) => entry.method === 'generateImage');
    assert.equal(call.references[0].sha256, hash(source));
    assert.equal(call.args.size, '96x64');
    assert.equal(call.references.length, 2);
    await page.getByLabel('版本名称', { exact: true }).fill('金色微调 E2E');
    await page.getByLabel('版本备注', { exact: true }).fill('metadata survives reload');
    await page.getByRole('button', { name: '保存名称和备注', exact: true }).click();
    await until(async () => (await screen()).versions[1].note === 'metadata survives reload', 'metadata disk save');
    await reload();
    await studio();
    assert.equal(await page.getByLabel('版本名称', { exact: true }).inputValue(), '金色微调 E2E');
    await page.getByLabel('对比两个版本（整图）').check();
    await imagesDecoded('.version-compare img', 2);
    const sources = await page.locator('.version-compare img').evaluateAll((items) => items.map((item) => item.getAttribute('src')));
    assert.equal(new Set(sources).size, 2);
  });

  await flow('project-generate-normal', async () => {
    await reload(); await studio();
    const before = (await screen()).versions.length;
    await page.getByRole('button', { name: '生成', exact: true }).click();
    await until(async () => {
      const versions = (await screen()).versions;
      return versions.length === before + 1 && versions.at(-1).image;
    }, 'completed normal generated version');
    const version = (await screen()).versions.at(-1);
    assert.equal(version.operation, 'generate');
    assert.equal(version.styleSnapshot.prompt, style.prompt);
    const call = providerEvents.filter((entry) => entry.method === 'generateImage').at(-1);
    assert.equal(call.references.length, 2);
    assert.equal(call.references[0].width, 1536);
    assert.equal(call.references[0].height, 1024);
    await imagesDecoded('.version-figure img', 1);
  });

  for (const operation of ['generate', 'refine']) {
    await flow(`project-${operation}-refresh-inflight`, async () => {
      await reload(); await studio();
      const beforeProject = await project();
      const beforeScreen = beforeProject.screens[0];
      const before = beforeScreen.versions.length;
      const existingIds = new Set(beforeScreen.versions.map((version) => version.id));
      const first = providerEvents.length;
      const filesBefore = new Set(await fs.readdir(path.join(process.env.GAMEUI_DATA, 'images')));
      if (operation === 'refine') {
        await page.getByLabel('基于此版本微调').fill('WEB_E2E_REFRESH_REFINE');
        await page.getByRole('button', { name: '生成微调版本', exact: true }).click();
      } else await page.getByRole('button', { name: '生成', exact: true }).click();
      const call = await until(() => providerEvents.slice(first).find((entry) => entry.method === 'generateImage'), 'provider entered before refresh');
      assert.ok(!call.completedAt, 'refresh must happen during provider delay');
      const refreshStartedAt = Date.now();
      await reload();
      await until(() => call.completedAt, 'controlled provider completed');
      let recoveryError;
      try {
        await until(async () => (await screen()).versions.some((version) => !existingIds.has(version.id) && version.image), 'completed image recovered to the source screen');
      } catch (error) { recoveryError = error.message; }
      await reload(); await studio();
      const after = await screen();
      const newVersions = after.versions.filter((version) => !existingIds.has(version.id));
      const createdImages = (await fs.readdir(path.join(process.env.GAMEUI_DATA, 'images'))).filter((file) => !filesBefore.has(file));
      const tasks = await api('/api/project-render/tasks');
      await persist(`${operation}-refresh-evidence.json`, { beforeVersions: before, afterVersions: after.versions.length, createdImages,
        recoveredVersions: newVersions, refreshStartedAt, provider: call, persistedProject: await project(), renderTasks: tasks, recoveryError });
      assert.equal(recoveryError, undefined, `${operation}: backend completed but source screen has no image recovery`);
      assert.equal(after.versions.length, before + 1, `${operation}: source screen must contain exactly one new version after refresh`);
      assert.equal(newVersions.length, 1);
      const recovered = newVersions[0];
      assert.ok(recovered.image); assert.ok(createdImages.includes(recovered.image));
      assert.equal(recovered.operation, operation);
      assert.deepEqual(recovered.styleSnapshot, { id: style.id, name: style.name, prompt: beforeProject.stylePrompt, image: beforeProject.styleImage });
      if (operation === 'refine') assert.equal(recovered.parentVersionId, beforeScreen.activeVersionId);
      assert.deepEqual((await project()).screens.slice(1), beforeProject.screens.slice(1), 'refresh recovery must not write into another source screen');
      assert.deepEqual(after.versions.filter((version) => existingIds.has(version.id)), beforeScreen.versions, 'prior versions must remain unchanged');
      assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'generateImage').length, 1, 'refresh recovery must not submit another paid request');
      const acknowledged = await until(async () => (await api('/api/project-render/tasks')).find((task) => task.id === recovered.id && task.status === 'acknowledged'), 'persisted version acknowledged exactly once');
      assert.equal(acknowledged.projectId, beforeProject.id); assert.equal(acknowledged.screenId, beforeScreen.id);
      assert.equal(acknowledged.result, recovered.image);
      await imagesDecoded('.version-figure img', 1);
      assert.equal(after.activeVersionId, recovered.id);
      await persist(`${operation}-refresh-evidence.json`, { beforeVersions: before, afterVersions: after.versions.length, createdImages,
        recoveredVersions: newVersions, refreshStartedAt, provider: call, persistedProject: await project(), renderTasks: await api('/api/project-render/tasks'), acknowledged });
    });
  }

  await flow('drawing-multi-reference-ratio-reload-download', async () => {
    await reload('画图');
    await page.locator('.drawing-tool input[type=file]').setInputFiles([{ name: 'reference.png', mimeType: 'image/png', buffer: source }, { name: 'blue.png', mimeType: 'image/png', buffer: await png(80, 120, '#4455bb') }]);
    await imagesDecoded('.drawing-reference img', 2);
    await page.locator('#drawing-prompt').fill('WEB_E2E_DRAW_PENDING');
    await page.locator('input[value="3:2"]').check();
    const first = providerEvents.length;
    control.pending = true;
    await page.locator('.drawing-generate').click();
    await until(() => providerEvents.slice(first).find((entry) => entry.method === 'generateImage'), 'drawing started');
    await reload('画图');
    const task = await until(async () => (await api('/api/drawing/state')).tasks.find((entry) => entry.prompt === 'WEB_E2E_DRAW_PENDING' && entry.status === 'done'), 'drawing survived reload');
    control.pending = false;
    assert.equal(task.references.length, 2);
    assert.equal(task.prompt, 'WEB_E2E_DRAW_PENDING', 'stored prompt remains the original user input');
    assert.equal(task.size, '1536x1024');
    assert.deepEqual(task.resultSize, { width: 1536, height: 1024 });
    assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'generateImage').length, 1);
    assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'waitForGeneration').length, 1);
    const call = providerEvents.slice(first).find((entry) => entry.method === 'generateImage');
    assert.ok(call.args.prompt.startsWith(`${task.prompt}\n\n`));
    assert.ok(call.args.prompt.includes('Canvas requirements: Request a 3:2 canvas at 1536x1024 pixels.'));
    await imagesDecoded('.drawing-result-image img', 1);
    assert.equal(await page.locator('#drawing-prompt').inputValue(), 'WEB_E2E_DRAW_PENDING');
    assert.equal(await page.locator('input[value="3:2"]').isChecked(), true);
    await imagesDecoded('.drawing-originals img', 2);
    const image = await download(page.getByRole('link', { name: '↓ 下载原图', exact: true }), 'drawing-result.png');
    const metadata = await sharp(image).metadata();
    assert.equal(metadata.width, 1536); assert.equal(metadata.height, 1024);
    await reload('画图');
    await until(async () => await page.locator('.drawing-history > button').count() === 1, 'first drawing history restored in UI');
    assert.equal(await page.locator('.drawing-history > button').count(), 1);
    await imagesDecoded('.drawing-result-image img', 1);
    for (const [ratio, size] of [['2:3', { width: 1024, height: 1536 }], ['1:1', { width: 1024, height: 1024 }]]) {
      const prompt = `WEB_E2E_DRAW_${ratio}`;
      await page.locator('#drawing-prompt').fill(prompt);
      await page.locator(`input[value="${ratio}"]`).check();
      await page.locator('.drawing-generate').click();
      const next = await until(async () => (await api('/api/drawing/state')).tasks.find((entry) => entry.prompt === prompt && entry.status === 'done'), `drawing ${ratio}`);
      assert.deepEqual(next.resultSize, size);
    }
    await reload('画图');
    await until(async () => await page.locator('.drawing-history > button').count() === 3, 'three persisted drawing histories');
    await page.locator('.drawing-history > button').filter({ hasText: 'WEB_E2E_DRAW_PENDING' }).click();
    await imagesDecoded('.drawing-originals img', 2);
    await imagesDecoded('.drawing-result-image img', 1);
    assert.ok((await page.locator('.drawing-snapshot').innerText()).includes('1536×1024'));
  });

  await flow('drawing-provider-ratio-mismatch-preserves-original', async () => {
    await reload('画图');
    const prompt = 'WEB_E2E_DRAW_MISMATCH_CONTROLLED';
    await page.locator('#drawing-prompt').fill(prompt);
    await page.locator('input[value="3:2"]').check();
    const first = providerEvents.length;
    control.outputSize = '1774x887';
    try {
      await page.locator('.drawing-generate').click();
      const task = await until(async () => (await api('/api/drawing/state')).tasks.find((entry) => entry.prompt === prompt && entry.status === 'done'), 'controlled mismatched provider result');
      assert.equal(task.prompt, prompt);
      assert.equal(task.size, '1536x1024');
      assert.deepEqual(task.resultSize, { width: 1774, height: 887 });
      const call = providerEvents.slice(first).find((entry) => entry.method === 'generateImage');
      assert.equal(call.args.size, '1536x1024');
      assert.ok(call.args.prompt.includes('Canvas requirements: Request a 3:2 canvas at 1536x1024 pixels.'));
      await reload('画图');
      await page.locator('.drawing-history > button').filter({ hasText: prompt }).click();
      await until(async () => (await page.locator('.drawing-results > .drawing-ratio-warning').innerText()).includes('实际 1774×887，请求 3:2（1536x1024）'), 'explicit preview ratio warning');
      assert.ok((await page.locator('.drawing-history > button').filter({ hasText: prompt }).locator('.drawing-ratio-warning').innerText()).includes('比例与请求不符'));
      await imagesDecoded('.drawing-result-image img', 1);
      const natural = await page.locator('.drawing-result-image img').evaluate((image) => [image.naturalWidth, image.naturalHeight]);
      assert.deepEqual(natural, [1774, 887]);
      const bytes = await download(page.getByRole('link', { name: '↓ 下载原图', exact: true }), 'drawing-mismatch-original.png');
      const metadata = await sharp(bytes).metadata();
      assert.equal(metadata.width, 1774); assert.equal(metadata.height, 887);
      const stored = await nativeFetch(`${base}/api/drawing/images/${task.result}`);
      assert.ok(stored.ok); assert.deepEqual(bytes, Buffer.from(await stored.arrayBuffer()), 'download must retain stored original bytes without resizing/cropping');
      assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'generateImage').length, 1);
      await persist('drawing-mismatch-evidence.json', { task, provider: call, downloadedSha256: hash(bytes), natural, controlled: true });
    } finally {
      control.outputSize = undefined;
    }
  });

  await flow('reskin-nested-zip-refresh-partial-retry-download', async () => {
    control.pending = false;
    await reload('整包换肤');
    const originals = { 'ui/a/icon.png': await png(32, 24, '#bb5522'), 'ui/b/icon.png': await png(48, 36, '#2255bb') };
    const archive = new JSZip();
    for (const [name, bytes] of Object.entries(originals)) archive.file(name, bytes);
    const zipFile = path.join(directory, 'nested-originals.zip');
    await fs.writeFile(zipFile, await archive.generateAsync({ type: 'nodebuffer' }));
    await page.getByLabel('导入 ZIP', { exact: true }).setInputFiles(zipFile);
    await page.getByLabel('目标风格描述').fill('WEB_E2E_PACK_STYLE');
    await page.getByRole('button', { name: '保存换肤任务（2 项）' }).click();
    const task = await until(async () => (await api('/api/reskin-tasks'))[0], 'reskin task saved');
    assert.deepEqual(task.items.map((item) => item.originalPath).sort(), Object.keys(originals).sort());
    await imagesDecoded('.reskin-comparison img', 2);
    control.failPath = 'ui/b/icon.png'; control.failConsumed = false;
    const first = providerEvents.length;
    await page.getByRole('button', { name: '开始 / 继续未完成项' }).click();
    await until(() => providerEvents.slice(first).find((entry) => entry.method === 'generateImage'), 'reskin started');
    await reload('整包换肤');
    const partial = await until(async () => {
      const saved = await api(`/api/reskin-tasks/${task.id}`);
      return saved.status === 'done' ? saved : null;
    }, 'server reskin completed after refresh');
    assert.equal(partial.items.filter((item) => item.status === 'done').length, 1);
    assert.equal(partial.items.filter((item) => item.status === 'failed').length, 1);
    await until(() => page.getByRole('button', { name: /导出原结构 ZIP/ }).isEnabled(), 'export enabled after polling');
    const verifyZip = async (bytes, expectedFailed) => {
      const zip = await JSZip.loadAsync(bytes);
      assert.deepEqual(Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort(), Object.keys(originals).sort());
      for (const item of task.items) {
        const output = await zip.file(item.originalPath).async('nodebuffer');
        const metadata = await sharp(output).metadata();
        assert.equal(metadata.width, item.width); assert.equal(metadata.height, item.height);
        if (item.originalPath === expectedFailed) assert.deepEqual(output, originals[item.originalPath]);
        else assert.notEqual(hash(output), hash(originals[item.originalPath]), 'successful output must differ from original');
      }
    };
    await verifyZip(await download(page.getByRole('button', { name: /导出原结构 ZIP/ }), 'reskin-partial.zip'), 'ui/b/icon.png');
    const successful = partial.items.find((item) => item.status === 'done');
    const beforeRetry = providerEvents.length;
    await page.getByRole('button', { name: '确认费用后重新生成', exact: true }).click();
    const completed = await until(async () => {
      const saved = await api(`/api/reskin-tasks/${task.id}`);
      return saved.items.every((item) => item.status === 'done') ? saved : null;
    }, 'partial failure retried');
    assert.equal(completed.items.find((item) => item.id === successful.id).resultImage, successful.resultImage);
    const retriedCalls = providerEvents.slice(beforeRetry).filter((entry) => entry.method === 'generateImage');
    assert.equal(retriedCalls.length, 1);
    assert.ok(retriedCalls[0].args.prompt.includes('ui/b/icon.png'));
    await reload('整包换肤');
    await imagesDecoded('.reskin-comparison img', 4);
    await verifyZip(await download(page.getByRole('button', { name: /导出原结构 ZIP/ }), 'reskin-completed.zip'));
    await persist('reskin-evidence.json', { partial, completed });
  });

  await flow('style-edit-preserves-snapshots', async () => {
    const before = await project();
    const packBefore = await api('/api/reskin-tasks');
    await reload('风格库');
    await page.locator('.style-card').filter({ hasText: '旧风格 E2E' }).getByRole('button', { name: '编辑', exact: true }).click();
    await page.locator('#style-name').fill('新风格 E2E');
    await page.locator('#style-prompt').fill('NEW_STYLE_MUST_NOT_MUTATE_SNAPSHOTS');
    await page.getByRole('button', { name: '保存到风格库', exact: true }).click();
    await until(async () => (await api('/api/styles')).styles.find((entry) => entry.id === style.id)?.name === '新风格 E2E', 'style update');
    await reload('风格库');
    assert.deepEqual(await project(), before);
    assert.deepEqual(await api('/api/reskin-tasks'), packBefore);
    await page.locator('.style-card').filter({ hasText: '新风格 E2E' }).waitFor();
  });

  await flow('layout-template-undo-reference-source-isolation', async () => {
    await reload(); await studio('1 · 布局');
    const before = structuredClone((await screen()).layout);
    await page.getByRole('button', { name: '主界面', exact: true }).click();
    await until(async () => (await screen()).layout.length === 7, 'template persisted');
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await until(async () => JSON.stringify((await screen()).layout) === JSON.stringify(before), 'template undo persisted');
    const first = providerEvents.length;
    await page.locator('.layout-reference-picker input').setInputFiles(sourceFile);
    await until(() => providerEvents.slice(first).some((entry) => entry.method === 'visionGateway.fetch' && entry.body), 'reference analysis started');
    await page.locator('.screen-pick[title="隔离界面 B"]').click();
    await delay(900);
    assert.equal(await page.getByRole('button', { name: '应用识别布局', exact: true }).count(), 0);
    const storedB = (await project()).screens[1];
    assert.deepEqual(storedB.layout, []); assert.equal(storedB.layoutReferenceImage, undefined);
    await page.locator('.screen-pick[title="来源界面 A"]').click();
    await page.locator('.layout-reference-picker input').setInputFiles(sourceFile);
    await page.getByRole('button', { name: '应用识别布局', exact: true }).waitFor();
    assert.deepEqual((await screen()).layout, before, 'analysis preview must not autoapply');
    await page.getByRole('button', { name: '应用识别布局', exact: true }).click();
    await until(async () => (await screen()).layoutReferenceImage, 'reference applied and persisted');
    assert.equal((await screen()).layout[0].name, 'Controlled reference button');
    await reload(); await studio('1 · 布局');
    assert.equal((await screen()).layout[0].name, 'Controlled reference button');
    assert.deepEqual((await project()).screens[1], storedB);
  });

  await flow('styleai-reference-extract-preview-refresh-save', async () => {
    await reload(); await studio();
    const before = await project();
    const sourceImage = before.screens[0].versions.find((version) => version.id === before.screens[0].activeVersionId).image;
    await page.getByRole('button', { name: '提取当前图画风', exact: true }).click();
    const generator = page.getByRole('region', { name: 'AI 画风创建', exact: true });
    await imagesDecoded('.style-generator-refs img', 1);
    assert.ok((await generator.locator('.style-generator-refs img').getAttribute('src')).includes(encodeURIComponent(sourceImage)));
    await generator.locator('input[type=file]').setInputFiles(sourceFile);
    await imagesDecoded('.style-generator-refs img', 2);
    await page.locator('#style-ai-description').fill('WEB_E2E_REFERENCE_STYLE');
    const first = providerEvents.length;
    control.pending = true;
    await generator.getByRole('button', { name: 'AI 生成画风与预览', exact: true }).click();
    const call = await until(() => providerEvents.slice(first).find((entry) => entry.method === 'generateImage'), 'style preview provider started');
    assert.equal(call.references.length, 1, 'two uploaded sources become a real server contact sheet');
    assert.equal(call.references[0].width, 768); assert.equal(call.references[0].height, 384);
    await reload('风格库');
    await imagesDecoded('.style-generator-result img', 1);
    control.pending = false;
    assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'generateImage').length, 1);
    const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('gameui-style-generation-v1')));
    assert.equal(draft.referenceImages.length, 2);
    assert.notEqual(draft.image, sourceImage);
    assert.ok(draft.image.startsWith('style-preview-'));
    await page.getByRole('button', { name: '保存 AI 画风到风格库', exact: true }).click();
    const saved = await until(async () => (await api('/api/styles')).styles.find((entry) => entry.name === '参考画风 E2E'), 'AI reference style persisted');
    assert.deepEqual(saved.referenceImages, draft.referenceImages);
    assert.equal(saved.image, draft.image);
    assert.deepEqual(await project(), before, 'extracting a style must not overwrite source project/version');
    await reload('风格库');
    await page.locator('.style-card').filter({ hasText: '参考画风 E2E' }).waitFor();
    await page.getByRole('region', { name: 'AI 画风创建', exact: true }).getByRole('button', { name: '新建草稿', exact: true }).click();
    await page.locator('#style-ai-description').fill('WEB_E2E_TEXT_ONLY');
    const textFirst = providerEvents.length;
    await page.getByRole('button', { name: 'AI 生成画风与预览', exact: true }).click();
    await imagesDecoded('.style-generator-result img', 1);
    const textCall = providerEvents.slice(textFirst).find((entry) => entry.method === 'generateImage');
    assert.equal(textCall.references.length, 0);
    await page.getByRole('button', { name: '保存 AI 画风到风格库', exact: true }).click();
    await until(async () => (await api('/api/styles')).styles.some((entry) => entry.name === '文字画风 E2E'), 'text-only style saved');
    await persist('styleai-evidence.json', { referenceStyle: saved, previewDraft: draft, projectUnchanged: await project() });
  });

  await flow('atlas-app-import-refresh-region-refill-zip', async () => {
    await reload('整包换肤');
    await page.getByRole('button', { name: '图集', exact: true }).click();
    const tool = page.getByRole('region', { name: '图集换肤', exact: true });
    const width = 64; const height = 48;
    const regions = [
      { name: 'trimmed', x: 4, y: 4, w: 8, h: 6, sourceW: 12, sourceH: 10, left: 2, top: 2, rotated: false },
      { name: 'rotated', x: 28, y: 20, w: 6, h: 8, sourceW: 6, sourceH: 8, left: 0, top: 0, rotated: true },
    ];
    const files = new Map([['atlas/pages/one.png', await png(width, height, '#cb6b34')], ['atlas/pages/two.png', await png(width, height, '#5566bb')], ['atlas/notes.txt', Buffer.from('ORIGINAL ancillary bytes\r\n')]]);
    for (const [index, region] of regions.entries()) {
      const frame = { frame: { x: region.x, y: region.y, w: region.w, h: region.h }, rotated: region.rotated, trimmed: true,
        sourceSize: { w: region.sourceW, h: region.sourceH }, spriteSourceSize: { x: region.left, y: region.top, w: region.w, h: region.h } };
      const frames = { [region.name]: frame };
      if (index === 0) frames.alias = frame;
      const description = JSON.stringify({ frames, meta: { image: `../pages/${index === 0 ? 'one' : 'two'}.png`, size: { w: width, h: height } } }, null, 2) + '\r\n';
      files.set(`atlas/meta/sheet-${index}.json`, Buffer.from(description));
    }
    const archive = new JSZip();
    for (const [name, bytes] of files) archive.file(name, bytes);
    const input = path.join(directory, 'atlas-original.zip');
    await fs.writeFile(input, await archive.generateAsync({ type: 'nodebuffer' }));
    await tool.getByLabel('导入 ZIP 或素材与描述', { exact: true }).setInputFiles(input);
    await tool.getByRole('button', { name: '保存原图集', exact: true }).click();
    const job = await until(async () => (await api('/api/atlas-jobs'))[0], 'atlas job persisted');
    assert.equal(job.manifest.pages.length, 2); assert.equal(job.manifest.regions.length, 2, 'alias does not cause duplicate generation');
    await reload('整包换肤'); await page.getByRole('button', { name: '图集', exact: true }).click();
    await imagesDecoded('.atlas-pages img', 2);
    assert.equal(await tool.getByRole('combobox', { name: /^已保存图集/ }).inputValue(), job.id);
    await tool.getByLabel('换肤描述', { exact: true }).fill('WEB_E2E_ATLAS');
    const first = providerEvents.length;
    await tool.getByRole('button', { name: '开始 region 换肤', exact: true }).click();
    await until(() => providerEvents.slice(first).some((entry) => entry.method === 'generateImage'), 'atlas region generation started');
    await reload('整包换肤'); await page.getByRole('button', { name: '图集', exact: true }).click();
    const linked = await until(async () => {
      const saved = (await api('/api/atlas-jobs')).find((entry) => entry.id === job.id);
      if (!saved.packTaskId) return null;
      const pack = await api(`/api/reskin-tasks/${saved.packTaskId}`);
      return pack.status === 'done' && pack.items.every((item) => item.status === 'done') ? { job: saved, pack } : null;
    }, 'atlas linked Pack completed after refresh');
    assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'generateImage').length, 2);
    const bytes = await download(tool.getByRole('button', { name: '导出原结构 ZIP', exact: true }), 'atlas-result.zip');
    const zip = await JSZip.loadAsync(bytes);
    assert.deepEqual(Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort(), [...files.keys()].sort());
    for (const [name, original] of files) {
      const output = await zip.file(name).async('nodebuffer');
      if (!name.endsWith('.png')) { assert.deepEqual(output, original, `original bytes ${name}`); continue; }
      const index = name.includes('one.png') ? 0 : 1;
      const region = regions[index];
      const decoded = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const originalPixels = await sharp(original).ensureAlpha().raw().toBuffer();
      assert.equal(decoded.info.width, width); assert.equal(decoded.info.height, height);
      const boxW = region.rotated ? region.h : region.w;
      const boxH = region.rotated ? region.w : region.h;
      let changed = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        const pixel = decoded.data.subarray(offset, offset + 4);
        const inRegion = x >= region.x && x < region.x + boxW && y >= region.y && y < region.y + boxH;
        if (inRegion) {
          assert.deepEqual([...pixel], [115, 188, 169, 255], `generated region ${name} at ${x},${y}`); changed++;
        } else assert.deepEqual(pixel, originalPixels.subarray(offset, offset + 4), `outside region unchanged ${name} at ${x},${y}`);
      }
      assert.equal(changed, region.w * region.h);
    }
    await persist('atlas-evidence.json', linked);
  });

  async function seedSavedScreenProject(id, name) {
    const asset = await api('/api/upload', { image: `data:image/png;base64,${(await png(16, 8, '#9977bb')).toString('base64')}`, prefix: 'web-e2e-asset' });
    const portrait = await api('/api/upload', { image: `data:image/png;base64,${(await png(80, 120, '#7799bb')).toString('base64')}`, prefix: 'web-e2e-portrait' });
    const snapshot = { name: 'Fixture snapshot', prompt: 'SNAPSHOT_MUST_STAY', image: upload.fileName };
    const first = { id: `${id}-a`, name: '同名界面', usage: 'Fixture screen', layoutReferenceImage: upload.fileName,
      layout: [{ id: `${id}-node`, name: 'Fixture button', kind: 'button', rect: { x: .1, y: .2, w: .3, h: .1 } }],
      versions: [{ id: `${id}-v1`, image: upload.fileName, operation: 'import', prompt: 'first', createdAt: now },
        { id: `${id}-v2`, parentVersionId: `${id}-v1`, image: upload.fileName, operation: 'refine', prompt: 'refined', name: 'Fixture refined', note: 'Preserve note', styleSnapshot: snapshot, createdAt: now + 1 }], activeVersionId: `${id}-v2` };
    const value = { ...structuredClone(legacy), id, name, screens: [first,
      { id: `${id}-b`, name: '同名界面', usage: '', layout: [], versions: [{ id: `${id}-portrait`, image: portrait.fileName, prompt: '', operation: 'import', createdAt: now }], activeVersionId: `${id}-portrait` },
      { id: `${id}-empty`, name: '无图界面', usage: '', layout: [], versions: [] }] };
    await api('/api/projects', { project: value }, 'PUT');
    const element = { id: `${id}-element`, kind: 'button', label: 'FixtureButton', description: 'saved UI button', objectName: 'FixtureButton', state: 'Normal',
      rect: { x: 8, y: 12, w: 16, h: 8 }, layer: 2, occluded: false, needsAi: false, approved: true, extractionMethod: 'manual', processingStatus: 'done', maskImage: asset.fileName,
      slice: { image: asset.fileName, width: 16, height: 8, border: { bgColor: [0, 0, 0], sideScore: { top: 1, right: 1, bottom: 1, left: 1 }, dirtySides: [] } } };
    const task = { schemaVersion: 1, id: `${id}-task`, name: 'Saved fixture task', source: { kind: 'project', projectId: id, screenId: first.id, versionId: first.activeVersionId, sourceImage: upload.fileName },
      width: 96, height: 64, elements: [element,
        { ...structuredClone(element), id: `${id}-unapproved`, label: 'SkippedButton', objectName: 'SkippedButton', approved: false },
        { ...structuredClone(element), id: `${id}-text`, label: 'TextCaption', objectName: 'TextCaption', kind: 'text', text: 'TMP text' }], status: 'done', createdAt: now, updatedAt: now };
    await api('/api/slice-tasks', { task }, 'PUT');
    return { project: value, task, assetImage: asset.fileName };
  }

  await flow('pageexport-app-current-all-resolution-assets-zip', async () => {
    const seeded = await seedSavedScreenProject('export-fixture', '导出项目 E2E');
    await reload();
    await page.getByRole('button', { name: seeded.project.name, exact: true }).click();
    await studio();
    const panel = page.getByRole('region', { name: '整页资源导出', exact: true });
    const verify = async (bytes, expectedPages, size) => {
      const zip = await JSZip.loadAsync(bytes);
      const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
      assert.equal(manifest.pages.length, expectedPages);
      assert.equal(new Set(manifest.pages.map((entry) => entry.directory)).size, expectedPages, 'same screen names retain distinct directories');
      const first = manifest.pages.find((entry) => entry.screenId === seeded.project.screens[0].id);
      assert.equal(first.version.id, seeded.project.screens[0].activeVersionId);
      assert.equal(first.version.styleSnapshot.prompt, 'SNAPSHOT_MUST_STAY');
      assert.equal(first.assets.length, 1, 'unapproved and text excluded');
      const asset = first.assets[0];
      assert.equal(asset.id, seeded.task.elements[0].id);
      const assetBytes = await zip.file(asset.path).async('nodebuffer');
      const assetSize = await sharp(assetBytes).metadata();
      assert.equal(assetSize.width, 16); assert.equal(assetSize.height, 8);
      for (const entry of manifest.pages) {
        const imageBytes = await zip.file(entry.image).async('nodebuffer');
        const metadata = await sharp(imageBytes).metadata();
        const expected = size || entry.transform.sourceSize;
        assert.equal(metadata.width, expected.width); assert.equal(metadata.height, expected.height);
        assert.equal(entry.transform.fit, 'contain'); assert.equal(entry.transform.padding, 'transparent');
      }
      const transform = first.transform;
      assert.equal(asset.exportRect.x, 8 * transform.scale + transform.offset.x);
      assert.equal(asset.exportRect.y, 12 * transform.scale + transform.offset.y);
      if (size) {
        const raw = await sharp(await zip.file(first.image).async('nodebuffer')).ensureAlpha().raw().toBuffer();
        assert.equal(raw[3], 0, 'contain export must preserve transparent corner padding');
        assert.equal(manifest.skipped.length, 1);
        assert.equal(manifest.skipped[0].screenId, 'export-fixture-empty');
      }
      return manifest;
    };
    const current = await verify(await download(panel.getByRole('button', { name: '导出整页资源 ZIP', exact: true }), 'page-current.zip'), 1);
    await panel.getByRole('combobox', { name: /^导出范围/ }).selectOption('all');
    await panel.getByRole('combobox', { name: /^整图分辨率/ }).selectOption('750x1334');
    const all = await verify(await download(panel.getByRole('button', { name: '导出整页资源 ZIP', exact: true }), 'page-all.zip'), 2, { width: 750, height: 1334 });
    assert.equal(current.pages[0].directory, all.pages.find((entry) => entry.screenId === current.pages[0].screenId).directory);
    await persist('pageexport-evidence.json', { current, all });
  });

  await flow('copy-app-project-screen-metadata-task-isolation', async () => {
    const seeded = await seedSavedScreenProject('copy-fixture', '复制项目 E2E');
    const original = (await projects()).find((entry) => entry.id === seeded.project.id);
    const originalTasks = (await api('/api/slice-tasks')).tasks;
    const sourceTask = originalTasks.find((entry) => entry.id === seeded.task.id);
    const imageNames = (await fs.readdir(path.join(process.env.GAMEUI_DATA, 'images'))).sort();
    const first = providerEvents.length;
    await reload();
    await page.getByRole('button', { name: original.name, exact: true }).click();
    await page.getByRole('button', { name: `复制项目：${original.name}`, exact: true }).click();
    const copied = await until(async () => (await projects()).find((entry) => entry.name === `${original.name} 副本`), 'project copied via App');
    assert.notEqual(copied.id, original.id); assert.equal(copied.screens.length, 3);
    const sourceIds = new Set([original.id, ...original.screens.flatMap((entry) => [entry.id, ...entry.layout.map((node) => node.id), ...entry.versions.map((version) => version.id)])]);
    for (const entry of copied.screens) {
      for (const id of [entry.id, ...entry.layout.map((node) => node.id), ...entry.versions.map((version) => version.id)]) assert.equal(sourceIds.has(id), false);
    }
    const copiedScreen = copied.screens[0];
    assert.equal(copiedScreen.versions[1].parentVersionId, copiedScreen.versions[0].id);
    assert.equal(copiedScreen.activeVersionId, copiedScreen.versions[1].id);
    assert.deepEqual(copiedScreen.versions[1].styleSnapshot, original.screens[0].versions[1].styleSnapshot);
    assert.equal(copiedScreen.versions[1].note, 'Preserve note');
    const copiedTask = (await api('/api/slice-tasks')).tasks.find((entry) => entry.source.projectId === copied.id);
    assert.ok(copiedTask); assert.notEqual(copiedTask.id, sourceTask.id);
    assert.equal(copiedTask.source.screenId, copiedScreen.id); assert.equal(copiedTask.source.versionId, copiedScreen.activeVersionId);
    assert.notEqual(copiedTask.elements[0].id, sourceTask.elements[0].id);
    assert.deepEqual(copiedTask.elements[0].slice, sourceTask.elements[0].slice);
    assert.deepEqual((await projects()).find((entry) => entry.id === original.id), original);
    assert.deepEqual((await api('/api/slice-tasks')).tasks.find((entry) => entry.id === sourceTask.id), sourceTask);
    await reload();
    await page.getByRole('button', { name: original.name, exact: true }).click();
    const sourceRow = page.locator('.screen-row').filter({ has: page.locator('.screen-pick[title="同名界面"]') }).first();
    await sourceRow.getByRole('button', { name: '复制界面：同名界面', exact: true }).click();
    const projectAfter = await until(async () => {
      const value = (await projects()).find((entry) => entry.id === original.id);
      return value.screens.length === 4 ? value : null;
    }, 'screen copied via App');
    const screenCopy = projectAfter.screens.find((entry) => !original.screens.some((source) => source.id === entry.id));
    assert.equal(screenCopy.name, '同名界面 副本');
    assert.equal(screenCopy.versions[1].parentVersionId, screenCopy.versions[0].id);
    assert.deepEqual(projectAfter.screens.filter((entry) => original.screens.some((source) => source.id === entry.id)), original.screens);
    const screenTask = (await api('/api/slice-tasks')).tasks.find((entry) => entry.source.screenId === screenCopy.id);
    assert.ok(screenTask); assert.equal(screenTask.source.projectId, original.id);
    assert.equal(screenTask.source.versionId, screenCopy.activeVersionId);
    await reload();
    await page.getByRole('button', { name: copied.name, exact: true }).click(); await studio();
    await page.getByLabel('版本名称', { exact: true }).fill('EDIT_COPY_ONLY');
    await page.getByRole('button', { name: '保存名称和备注', exact: true }).click();
    await until(async () => (await projects()).find((entry) => entry.id === copied.id).screens[0].versions[1].name === 'EDIT_COPY_ONLY', 'copy edit persisted');
    assert.deepEqual((await projects()).find((entry) => entry.id === original.id).screens[0], original.screens[0]);
    assert.deepEqual((await fs.readdir(path.join(process.env.GAMEUI_DATA, 'images'))).sort(), imageNames, 'metadata copy must not regenerate/duplicate images');
    assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'generateImage').length, 0);
    await persist('copy-evidence.json', { original, copied, sourceTask, copiedTask, screenCopy, screenTask });
  });

  await flow('assets-saved-preview-review-png-zip-mask-reload', async () => {
    const seeded = await seedSavedScreenProject('assets-fixture', '素材项目 E2E');
    const mask = await api('/api/upload', { image: `data:image/png;base64,${(await png(16, 8, '#ffffff')).toString('base64')}`, prefix: 'web-e2e-mask' });
    seeded.task.elements[0].maskImage = mask.fileName;
    await api('/api/slice-tasks', { task: seeded.task }, 'PUT');
    const first = providerEvents.length;
    const openSavedAssets = async () => {
      await reload();
      await page.getByRole('button', { name: seeded.project.name, exact: true }).click();
      await studio('3 · 素材');
      await imagesDecoded('.slice-preview-card img', 3);
    };
    const savedTask = async () => (await api('/api/slice-tasks')).tasks.find((entry) => entry.id === seeded.task.id);
    const verifyPng = async (bytes, erased = false) => {
      const decoded = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(decoded.info.width, 16); assert.equal(decoded.info.height, 8);
      assert.equal(decoded.data[(4 * 16 + 8) * 4 + 3], erased ? 0 : 255);
      assert.deepEqual([...decoded.data.subarray(0, 4)], [153, 119, 187, 255], 'unedited corner retains original RGBA');
    };
    const verifyZip = async (bytes, expectedLabels) => {
      const zip = await JSZip.loadAsync(bytes);
      const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
      const coords = JSON.parse(await zip.file('coords.json').async('string'));
      assert.deepEqual(manifest.map((entry) => entry.label).sort(), [...expectedLabels].sort());
      const images = Object.values(zip.files).filter((entry) => !entry.dir && entry.name.startsWith('png/'));
      assert.equal(images.length, expectedLabels.length);
      assert.equal(coords.length, expectedLabels.length);
      for (const entry of manifest) {
        assert.equal(entry.kind, 'button', 'approved text must remain excluded by the real default settings');
        assert.deepEqual(entry.source, { x: 8, y: 12, w: 16, h: 8 });
        await verifyPng(await zip.file(`png/${entry.fileName}`).async('nodebuffer'));
      }
      assert.ok(zip.file('GameUiSliceImporter.cs')); assert.ok(zip.file('README.md'));
      return manifest;
    };
    await openSavedAssets();
    await imagesDecoded('.asset-source img', 1);
    const sourceSize = await page.locator('.asset-source img').evaluate((img) => ({ width: img.naturalWidth, height: img.naturalHeight }));
    assert.deepEqual(sourceSize, { width: 96, height: 64 });
    const thumbnailSizes = await page.locator('.slice-preview-card img').evaluateAll((items) => items.map((img) => [img.naturalWidth, img.naturalHeight]));
    assert.deepEqual(thumbnailSizes, [[16, 8], [16, 8], [16, 8]]);
    await page.getByRole('button', { name: '预览 FixtureButton', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '素材修正', exact: true });
    await imagesDecoded('.slice-preview-dialog .slice-edit-viewport img', 1);
    await verifyPng(await download(dialog.getByRole('button', { name: '下载这张 PNG', exact: true }), 'asset-original.png'));
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const beforeReview = await verifyZip(await download(page.getByRole('button', { name: '导出 ZIP', exact: true }), 'assets-approved.zip'), ['FixtureButton']);
    const cards = page.locator('.slice-preview-card');
    await cards.nth(0).getByRole('checkbox').uncheck();
    await until(async () => !(await savedTask()).elements[0].approved, 'review rejection persisted');
    await cards.nth(1).getByRole('checkbox').check();
    await until(async () => (await savedTask()).elements[1].approved, 'second review approved');
    await verifyZip(await download(page.getByRole('button', { name: '导出 ZIP', exact: true }), 'assets-review-switched.zip'), ['SkippedButton']);
    await cards.nth(0).getByRole('checkbox').check();
    await until(async () => (await savedTask()).elements[0].approved, 'first review reapproved');
    const afterReview = await verifyZip(await download(page.getByRole('button', { name: '导出 ZIP', exact: true }), 'assets-two-approved.zip'), ['FixtureButton', 'SkippedButton']);
    await page.screenshot({ path: path.join(directory, 'assets-review-downloads.png'), fullPage: true });
    await page.getByRole('button', { name: '预览 FixtureButton', exact: true }).click();
    await dialog.getByRole('combobox', { name: '缩放', exact: true }).selectOption('4');
    await dialog.getByRole('button', { name: '编辑蒙版', exact: true }).click();
    const brushCanvas = dialog.locator('canvas[aria-label="素材蒙版画布"]');
    await brushCanvas.waitFor();
    const alphaAtCenter = () => brushCanvas.evaluate((element) => element.getContext('2d').getImageData(8, 4, 1, 1).data[3]);
    await until(async () => await alphaAtCenter() === 255, 'real mask canvas initialized');
    await dialog.getByRole('slider').focus(); await dialog.getByRole('slider').press('Home');
    const bounds = await brushCanvas.boundingBox(); assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down(); await page.mouse.up();
    await until(async () => await alphaAtCenter() === 0, 'real pointer stroke erased center');
    await dialog.locator('.mask-editor').getByRole('button', { name: '撤销', exact: true }).click();
    assert.equal(await alphaAtCenter(), 255);
    await dialog.locator('.mask-editor').getByRole('button', { name: '重做', exact: true }).click();
    assert.equal(await alphaAtCenter(), 0);
    const beforeMask = await savedTask();
    await dialog.getByRole('button', { name: '保存蒙版', exact: true }).click();
    const afterMask = await until(async () => {
      const value = await savedTask();
      return value.elements[0].slice.image !== beforeMask.elements[0].slice.image ? value : null;
    }, 'hand-edited slice uploaded and actual task persisted');
    assert.equal(afterMask.elements[0].extractionMethod, 'manual');
    assert.equal(afterMask.elements[0].maskImage, mask.fileName, 'original segmentation mask remains a separate immutable reference');
    const stored = await nativeFetch(`${base}/api/image?name=${encodeURIComponent(afterMask.elements[0].slice.image)}`);
    assert.ok(stored.ok); await verifyPng(Buffer.from(await stored.arrayBuffer()), true);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await openSavedAssets();
    assert.equal(await cards.nth(0).getByRole('checkbox').isChecked(), true);
    assert.equal(await cards.nth(1).getByRole('checkbox').isChecked(), true);
    await page.getByRole('button', { name: '预览 FixtureButton', exact: true }).click();
    await verifyPng(await download(dialog.getByRole('button', { name: '下载这张 PNG', exact: true }), 'asset-mask-restored.png'), true);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const restoredZip = await JSZip.loadAsync(await download(page.getByRole('button', { name: '导出 ZIP', exact: true }), 'assets-mask-restored.zip'));
    const restoredManifest = JSON.parse(await restoredZip.file('manifest.json').async('string'));
    assert.deepEqual(restoredManifest.map((entry) => entry.label).sort(), ['FixtureButton', 'SkippedButton']);
    const restoredEntry = restoredManifest.find((entry) => entry.label === 'FixtureButton');
    await verifyPng(await restoredZip.file(`png/${restoredEntry.fileName}`).async('nodebuffer'), true);
    await navigate('设置');
    await page.getByLabel('文本按图片导出', { exact: true }).check();
    await page.getByLabel('素材命名模块', { exact: true }).fill('QA_Module');
    await studio('3 · 素材');
    const textZip = await JSZip.loadAsync(await download(page.getByRole('button', { name: '导出 ZIP', exact: true }), 'assets-with-text.zip'));
    const textManifest = JSON.parse(await textZip.file('manifest.json').async('string'));
    assert.deepEqual(textManifest.map((entry) => entry.label).sort(), ['FixtureButton', 'SkippedButton', 'TextCaption']);
    const textEntry = textManifest.find((entry) => entry.label === 'TextCaption');
    assert.equal(textEntry.kind, 'text');
    assert.match(textEntry.fileName, /^T_UI_QaModule_/);
    await verifyPng(await textZip.file(`png/${textEntry.fileName}`).async('nodebuffer'));
    const pagePanel = page.getByRole('region', { name: '整页资源导出', exact: true });
    const textPages = await JSZip.loadAsync(await download(pagePanel.getByRole('button', { name: '导出整页资源 ZIP', exact: true }), 'pages-with-text.zip'));
    const pageManifest = JSON.parse(await textPages.file('manifest.json').async('string'));
    assert.equal(pageManifest.settings.includeTextAsImage, true);
    assert.deepEqual(pageManifest.pages[0].assets.map((entry) => entry.label).sort(), ['FixtureButton', 'SkippedButton', 'TextCaption']);
    await navigate('设置');
    await page.getByLabel('文本按图片导出', { exact: true }).uncheck();
    await page.getByLabel('素材命名模块', { exact: true }).fill('Common');
    assert.equal(providerEvents.slice(first).filter((entry) => entry.method === 'generateImage' || entry.method === 'waitForGeneration' || entry.body).length, 0, 'saved asset regression does not invoke SAM, vision or generation');
    assert.equal(apiEvents.filter((event) => event.url.startsWith('/api/segment')).length, 0);
    await persist('assets-evidence.json', { sourceSize, thumbnailSizes, beforeReview, afterReview, beforeMask, afterMask, restoredManifest,
      textFilter: 'Real default includeTextAsImage=false: approved text excluded. App currently exposes no text-image inclusion control; enabled branch NOT_RUN.', originalMask: mask.fileName });
  });
  if (!results.some((entry) => entry.status !== 'NOT_RUN')) throw new Error(`WEB_WORKFLOWS_GROUP matched no workflows: ${process.env.WEB_WORKFLOWS_GROUP}`);
  await context.tracing.stop({ path: path.join(directory, 'browser-trace.zip') });
} catch (error) {
  fatal = `${error.stack}\nCause: ${error.cause?.stack || 'none'}`;
  console.error(fatal);
  results.push({ name: 'harness-setup-or-execution', status: 'BLOCKED', error: fatal });
} finally {
  clearTimeout(deadline);
  control.pending = false;
  await browser?.close().catch((error) => console.error(error));
  server?.closeAllConnections();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  await vite?.close().catch((error) => console.error(error));
  globalThis.fetch = nativeFetch;
  if (previousData === undefined) delete process.env.GAMEUI_DATA; else process.env.GAMEUI_DATA = previousData;
  if (previousGateway === undefined) delete process.env.MAGPIE_GATEWAY; else process.env.MAGPIE_GATEWAY = previousGateway;
  const sourceDrift = [];
  for (const [file, frozenHash] of Object.entries(sourceHashes)) {
    if (hash(await fs.readFile(file)) !== frozenHash) sourceDrift.push(file);
  }
  await persist('results.json', results);
  await persist('provider-calls.json', providerEvents);
  await persist('api-events.json', apiEvents);
  await persist('environment.json', { base, browser: 'headless channel msedge', group: process.env.WEB_WORKFLOWS_GROUP || 'all', isolatedData: path.join(directory, 'store'), browserErrors, sourceDrift, controlledProvider: '400ms generate/wait; valid Sharp PNG at requested size; controlled failure/pending; gateway fetch only', fatal });
  console.log(JSON.stringify({ evidence: directory, results: results.map(({ name, status, error }) => ({ name, status, error: error?.split('\n')[0] })), browserErrors: browserErrors.length, sourceDrift }, null, 2));
  process.exitCode = results.some((result) => ['FAIL', 'BLOCKED'].includes(result.status)) || browserErrors.length ? 1 : 0;
  process.stdout.write = originalWrite.stdout; process.stderr.write = originalWrite.stderr;
  await logHandle.close();
}
