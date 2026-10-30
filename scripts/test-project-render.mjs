import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { createServer } from 'vite';
import sharp from 'sharp';

const directory = await fs.mkdtemp(path.resolve('.data/test-project-render-'));
process.env.GAMEUI_DATA = directory;
const apiFile = path.join(directory, 'api.mjs');
const clientFile = path.join(directory, 'client.mjs');
await build({ entryPoints: ['server/apiPlugin.ts'], outfile: apiFile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
  plugins: [{ name: 'external-provider-only', setup(builder) {
    builder.onResolve({ filter: /\/magpieMcp$/ }, () => ({ path: 'provider', namespace: 'controlled' }));
    builder.onLoad({ filter: /.*/, namespace: 'controlled' }, () => ({ contents: `
      export const generateImage = (...args) => globalThis.renderProvider.generateImage(...args);
      export const waitForGeneration = (...args) => globalThis.renderProvider.waitForGeneration(...args);
    `, loader: 'js' }));
  } }],
});
await build({ entryPoints: ['src/lib/projectRender.ts'], outfile: clientFile, bundle: true, platform: 'node', format: 'esm' });
const { magpieApi } = await import(pathToFileURL(apiFile));
const { reserveProjectRender, applyProjectRender } = await import(pathToFileURL(clientFile));
const fixture = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#b79e35' } }).png().toBuffer();
const jpeg = await sharp(fixture).resize(24, 16).jpeg().toBuffer();
const nearRatio = await sharp(fixture).resize(241, 160).png().toBuffer();
const wrongRatio = await sharp(fixture).resize(8, 12).png().toBuffer();
let mode = 'hold';
let submissions = 0;
let waits = 0;
let release;
let waitFails = false;
globalThis.renderProvider = {
  async generateImage(args) {
    submissions++;
    assert.equal(args.n, 1);
    assert.equal(args.size, '12x8');
    assert.equal((await sharp(args.referenceImages[0]).metadata()).width, 12);
    if (mode === 'hold') return new Promise((resolve) => { release = () => resolve({ base64: fixture.toString('base64'), text: '', isError: false }); });
    if (mode === 'pending') return { pendingId: 'existing-paid-request', text: '', isError: false };
    if (mode === 'unknown') throw new Error('response lost after paid submission');
    let bytes;
    if (mode === 'jpeg') bytes = jpeg;
    else if (mode === 'near-ratio') bytes = nearRatio;
    else if (mode === 'wrong-ratio') bytes = wrongRatio;
    else bytes = fixture.subarray(0, 48);
    return { base64: bytes.toString('base64'), text: '', isError: false };
  },
  async waitForGeneration(args) {
    waits++;
    assert.ok(args.pendingId || args.watchPath);
    if (waitFails) throw new Error('temporary provider disconnect');
    return { base64: fixture.toString('base64'), text: '', isError: false };
  },
};
let vite;
let server;
let base;
const checks = [];
async function start() {
  vite = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, watch: null }, plugins: [magpieApi()] });
  await vite.listen();
  server = vite.httpServer;
  base = `http://127.0.0.1:${server.address().port}`;
}
async function stop() {
  server.closeAllConnections();
  await vite.close();
}
async function request(route, body, method = body === undefined ? 'GET' : 'POST', expected = true) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.ok, expected, `${route}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
const tasks = () => request('/api/project-render/tasks');
async function until(predicate) {
  for (let attempt = 0; attempt < 150; attempt++) {
    const value = await predicate();
    if (value) return value;
    await delay(20);
  }
  throw new Error('Timed out waiting for persisted task');
}
async function done(id, status = 'done') {
  return until(async () => (await tasks()).find((task) => task.id === id && task.status === status));
}
const save = (project) => request('/api/projects', { project }, 'PUT');
const load = async () => (await request('/api/projects')).projects[0];
function input(operation = 'generate') {
  const value = { id: `v-${randomUUID()}`, projectId: 'project', screenId: 'screen', operation, prompt: 'snapshot prompt',
    styleSnapshot: { id: 'style', name: 'Original style', prompt: 'original style' }, size: '12x8' };
  if (operation === 'generate') value.wireframe = `data:image/png;base64,${fixture.toString('base64')}`;
  else { value.sourceVersionId = 'source'; value.sourceImage = sourceImage; }
  return value;
}
async function submit(value) {
  await save(reserveProjectRender(await load(), value));
  return request('/api/project-render/tasks', value);
}
let sourceImage;
try {
  await start();
  sourceImage = (await request('/api/upload', { image: `data:image/png;base64,${fixture.toString('base64')}`, prefix: 'source' })).fileName;
  for (const [format, bytes] of [['jpeg', jpeg], ['webp', await sharp(fixture).webp().toBuffer()]]) {
    const uploaded = await request('/api/upload', { image: `data:image/${format};base64,${bytes.toString('base64')}` });
    const metadata = await sharp(await fs.readFile(path.join(directory, 'images', uploaded.fileName))).metadata();
    assert.equal(metadata.format, 'png');
  }
  await request('/api/upload', undefined, 'GET', false);
  for (const image of [`data:image/png;base64,${jpeg.toString('base64')}`, `data:image/png;base64,${fixture.subarray(0, 48).toString('base64')}`, 'data:image/png;base64,abc']) {
    await request('/api/upload', { image }, 'POST', false);
  }
  checks.push('upload accepts and normalizes real JPEG/WebP; rejects wrong methods, MIME mismatch, truncation and invalid base64');
  await save({ id: 'project', name: 'Original', stylePrompt: '', orientation: 'landscape', size: { w: 12, h: 8 }, createdAt: 1, updatedAt: 1,
    screens: [{ id: 'screen', name: 'Screen', usage: '', layout: [], activeVersionId: 'source', versions: [{ id: 'source', image: sourceImage, prompt: '', createdAt: 1 }] },
      { id: 'other-screen', name: 'Other', usage: '', layout: [], versions: [] }] });

  // Browser disappears after POST; provider finishes independently of that HTTP connection.
  const first = input();
  await submit(first);
  await until(() => release);
  await request('/api/project-render/tasks', first);
  assert.equal(submissions, 1, 'idempotent POST must not pay twice');
  let project = await load();
  project.name = 'User edited project';
  project.screens[0].name = 'User edited screen';
  project.screens[0].activeVersionId = 'source';
  const reserved = project.screens[0].versions.find((version) => version.id === first.id);
  reserved.name = 'User edited name'; reserved.note = 'User edited note';
  await save(project);
  release();
  const result = await done(first.id);
  assert.equal(result.pendingId, undefined); assert.equal(result.watchPath, undefined);
  assert.equal(result.references, undefined);
  assert.equal(applyProjectRender(undefined, result), undefined);
  const removedScreen = await load(); removedScreen.screens = [];
  assert.equal(applyProjectRender(removedScreen, result), undefined);
  const editedPrompt = await load(); editedPrompt.screens[0].versions.at(-1).prompt = 'new user prompt';
  assert.equal(applyProjectRender(editedPrompt, result), undefined);
  const replacedImage = await load(); replacedImage.screens[0].versions.at(-1).image = sourceImage;
  assert.equal(applyProjectRender(replacedImage, result), undefined);
  await request(`/api/project-render/tasks/${first.id}/ack`, {}, 'POST', false);
  project = applyProjectRender(await load(), result);
  assert.equal(project.name, 'User edited project');
  assert.equal(project.screens[0].name, 'User edited screen');
  assert.equal(project.screens[0].activeVersionId, 'source');
  assert.equal(project.screens[0].versions.at(-1).note, 'User edited note');
  // No successful project save: result remains recoverable and ack is refused.
  await request(`/api/project-render/tasks/${first.id}/ack`, {}, 'POST', false);
  assert.equal((await done(first.id)).result, result.result);
  await save(project);
  assert.equal(applyProjectRender(await load(), result), undefined, 'recovery deduplicates stable version ID');
  await request(`/api/project-render/tasks/${first.id}/ack`, {});
  checks.push('generate refresh, idempotent POST, latest edits/selection, save-before-ack, dedup');
  checks.push('deleted targets and changed version prompt/image are never overwritten');

  mode = 'hold'; release = undefined;
  const cancelled = input();
  await submit(cancelled);
  await until(() => release);
  await request(`/api/project-render/tasks/${cancelled.id}/cancel`, {});
  const cancelledTask = await done(cancelled.id, 'discarded');
  assert.equal(cancelledTask.error, '已停止生成');
  const submissionsBeforeRelease = submissions;
  release();
  await delay(150);
  assert.equal((await tasks()).find((task) => task.id === cancelled.id).status, 'discarded');
  assert.equal(submissions, submissionsBeforeRelease);
  project = await load();
  assert.equal(project.screens[0].versions.find((version) => version.id === cancelled.id)?.image, undefined);
  project.screens[0].versions = project.screens[0].versions.filter((version) => version.id !== cancelled.id);
  await save(project);
  checks.push('cancel running generation keeps late provider output from overwriting the task or version');

  mode = 'jpeg';
  const refine = input('refine');
  await submit(refine);
  const refined = await done(refine.id);
  const normalized = await sharp(await fs.readFile(path.join(directory, 'images', refined.result))).metadata();
  assert.equal(normalized.format, 'png'); assert.equal(normalized.width, 12); assert.equal(normalized.height, 8);
  await save(applyProjectRender(await load(), refined));
  await request(`/api/project-render/tasks/${refine.id}/ack`, {});
  checks.push('refine refresh, source binding, full JPEG decode and requested PNG canvas');

  mode = 'near-ratio';
  const nearRatioTask = input();
  await submit(nearRatioTask);
  const normalizedNearRatio = await done(nearRatioTask.id);
  const nearRatioMetadata = await sharp(await fs.readFile(path.join(directory, 'images', normalizedNearRatio.result))).metadata();
  assert.equal(nearRatioMetadata.width, 12);
  assert.equal(nearRatioMetadata.height, 8);
  await save(applyProjectRender(await load(), normalizedNearRatio));
  await request(`/api/project-render/tasks/${nearRatioTask.id}/ack`, {});
  checks.push('near provider aspect ratio is accepted and normalized to the requested canvas');

  mode = 'hold'; release = undefined;
  const deleted = input();
  await submit(deleted); await until(() => release);
  project = await load();
  project.screens[0].versions = project.screens[0].versions.filter((version) => version.id !== deleted.id);
  await save(project); release();
  const deletedResult = await done(deleted.id);
  assert.equal(applyProjectRender(await load(), deletedResult), undefined);
  await request(`/api/project-render/tasks/${deleted.id}/discard`, {});
  assert.ok(!(await load()).screens[0].versions.some((version) => version.id === deleted.id));
  checks.push('deleted reservation never resurrected');

  for (const invalidMode of ['wrong-ratio', 'truncated']) {
    mode = invalidMode;
    const invalid = input();
    const before = (await fs.readdir(path.join(directory, 'images'))).length;
    await submit(invalid);
    const interrupted = await done(invalid.id, 'interrupted');
    assert.ok(interrupted.error); assert.equal(interrupted.result, undefined);
    assert.equal((await fs.readdir(path.join(directory, 'images'))).length, before);
  }
  checks.push('wrong aspect and truncated provider output rejected before result persistence');

  mode = 'pending'; waitFails = true;
  const pending = input(); await submit(pending); await done(pending.id, 'interrupted');
  const beforeRestart = submissions;
  await stop();
  // Simulate the disk state after a process dies while already-submitted work is running.
  const index = path.join(directory, 'project-render', 'tasks.json');
  let records = JSON.parse(await fs.readFile(index, 'utf8'));
  records.find((task) => task.id === pending.id).status = 'running';
  await fs.writeFile(index, JSON.stringify(records));
  waitFails = false; await start();
  await done(pending.id);
  assert.equal(submissions, beforeRestart);
  checks.push('server restart resumes known pending request without new payment');

  mode = 'unknown'; waitFails = true;
  const unknown = input(); await submit(unknown); await done(unknown.id, 'interrupted');
  const beforeResume = submissions;
  waitFails = false;
  await request(`/api/project-render/tasks/${unknown.id}/resume`, {});
  await done(unknown.id);
  assert.equal(submissions, beforeResume, 'watchPath recovery never resubmits');
  records = JSON.parse(await fs.readFile(index, 'utf8'));
  const unknownRecord = records.find((task) => task.id === unknown.id);
  unknownRecord.status = 'interrupted'; delete unknownRecord.pendingId; delete unknownRecord.watchPath;
  await fs.writeFile(index, JSON.stringify(records));
  const refused = await request(`/api/project-render/tasks/${unknown.id}/resume`, {}, 'POST', false);
  assert.match(refused.error, /明确确认/);
  assert.equal(submissions, beforeResume);
  checks.push('watchPath-only resume and unknown submission refusal never pay again');

  mode = 'jpeg';
  const retryInput = { ...unknown, id: `v-${randomUUID()}` };
  await save(reserveProjectRender(await load(), retryInput));
  await request(`/api/project-render/tasks/${unknown.id}/retry`, { newId: retryInput.id }, 'POST', false);
  assert.equal(submissions, beforeResume);
  await request(`/api/project-render/tasks/${unknown.id}/retry`, { newId: retryInput.id, confirmNewCharge: true });
  await done(retryInput.id);
  await request(`/api/project-render/tasks/${unknown.id}/retry`, { newId: retryInput.id, confirmNewCharge: true });
  assert.equal(submissions, beforeResume + 1);
  checks.push('explicitly confirmed regeneration reuses original immutable references; duplicate retry cannot pay twice');

  mode = 'pending';
  const invalidInput = input();
  await save(reserveProjectRender(await load(), invalidInput));
  invalidInput.wireframe = `data:image/png;base64,${fixture.subarray(0, 48).toString('base64')}`;
  const beforeInvalid = submissions;
  await request('/api/project-render/tasks', invalidInput, 'POST', false);
  assert.equal(submissions, beforeInvalid);
  checks.push('invalid source fails full decode before payment');
  await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify({ checks, submissions, waits, tasks: await tasks() }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, evidence: directory }, null, 2));
} finally {
  await stop();
}
