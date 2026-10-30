import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { createServer as createPortProbe } from 'node:net';
import sharp from 'sharp';

if (!process.env.SLICE_TEST_WORKER) {
  const directory = await fs.mkdtemp(path.resolve('.data/phase1-test-'));
  const bundle = path.join(directory, 'test.mjs');
  await build({ entryPoints: [process.argv[1]], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });
  const result = spawnSync(process.execPath, [bundle], {
    env: { ...process.env, SLICE_TEST_WORKER: '1', GAMEUI_DATA: path.join(directory, 'store') }, encoding: 'utf8',
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  console.log(`Evidence and temporary GAMEUI_DATA: ${directory}`);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  await runTests();
}

async function unusedPort() {
  const probe = createPortProbe();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function runTests() {
  const store = await import('../server/store.ts');
  const { magpieApi } = await import('../server/apiPlugin.ts');
  const { createServer } = await import('vite');
  const codec = await import('../src/lib/sliceTasks.ts');
  const root = process.env.GAMEUI_DATA;
  assert.ok(root && root.includes('phase1-test-'));
  const pngBytes = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const png = `data:image/png;base64,${pngBytes.toString('base64')}`;
  const sourceImage = await store.saveImage(png, 'test');
  assert.equal(await store.readImage(sourceImage), png);
  assert.deepEqual(await store.listProjects(), []);
  assert.deepEqual(await store.listSliceTasks(), []);
  const project = (id) => ({ id, name: id, stylePrompt: '', orientation: 'portrait', size: { w: 1, h: 1 }, screens: [], createdAt: 1, updatedAt: 1 });
  const task = (id) => ({ schemaVersion: 1, id, name: id, source: { kind: 'project', projectId: id, screenId: 'screen', versionId: 'version', sourceImage }, width: 1, height: 1, elements: [], status: 'done', createdAt: 1, updatedAt: 1 });
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.upsertProject(project(`p${i}`))));
  assert.equal((await store.listProjects()).length, 30);
  await Promise.all(Array.from({ length: 30 }, (_, i) => store.upsertSliceTask(task(`t${i}`))));
  assert.equal((await store.listSliceTasks()).length, 30);
  await Promise.all([store.deleteProject('p0'), store.upsertProject(project('new')), store.upsertSliceTask(task('new'))]);
  assert.equal((await store.listProjects()).length, 30);
  assert.equal((await store.listSliceTasks()).length, 31);
  console.log('PASS concurrent project/task upserts and delete do not lose unrelated records; legacy project without task fields loads');
  await assert.rejects(store.upsertSliceTask({ ...task('t0'), id: 'duplicate' }), /已有素材任务/);
  await assert.rejects(store.upsertSliceTask({ ...task('t0'), source: task('t1').source }), /已有素材任务|不可修改/);
  console.log('PASS one task per source and immutable task ownership');

  // A disk read error must prevent writes; the original bad bytes must stay intact.
  for (const file of ['projects.json', 'slice-tasks.json', 'styles.json']) {
    const target = path.join(root, file);
    const original = await fs.readFile(target, 'utf8').catch(() => '[]');
    for (const damaged of ['{broken', '{}', '[{}]']) {
      await fs.writeFile(target, damaged);
      if (file === 'projects.json') {
        await assert.rejects(store.listProjects());
        await assert.rejects(store.upsertProject(project('blocked')));
      } else if (file === 'slice-tasks.json') {
        await assert.rejects(store.listSliceTasks());
        await assert.rejects(store.upsertSliceTask(task('blocked')));
      } else {
        await assert.rejects(store.listStyles());
        await assert.rejects(store.upsertStyle({ id: 'blocked', name: '', prompt: '', createdAt: 1, updatedAt: 1 }));
      }
      assert.equal(await fs.readFile(target, 'utf8'), damaged);
    }
    await fs.writeFile(target, original);
  }
  await store.upsertSliceTask(task('after-error'));
  assert.equal((await fs.readdir(root)).filter((name) => name.endsWith('.tmp')).length, 0);
  console.log('PASS corrupt JSON and invalid indexes remain untouched; queue recovers after failure; no leftover atomic temporary files');

  const firstPort = await unusedPort();
  let secondPort = await unusedPort();
  while (secondPort === firstPort) secondPort = await unusedPort();
  console.log(`REST lifecycle ports: first=${firstPort}, restarted=${secondPort} (strictPort; no fetch retries)`);
  const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [magpieApi()], server: { host: '127.0.0.1', port: firstPort, strictPort: true, watch: { ignored: ['**/.data/**', '**/.venv-seg/**'] } }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => nativeFetch(String(url).startsWith('/') ? base + url : url, options);
  try {
    let uploads = 0;
    const canvas = () => ({ width: 1, height: 1, toDataURL() { uploads++; return png; }, getContext() { return { drawImage() {} }; } });
    globalThis.document = { createElement: () => canvas() };
    globalThis.Image = class { async decode() {} };
    const diagnostics = {
      promptBounds: [0, 0, 1, 1], inferenceBounds: [0, 0, 1, 1], maskBounds: [0, 0, 1, 1], outputBounds: [0, 0, 1, 1],
      quality: { status: 'review', issues: [], removedComponents: 0, removedPixels: 0, retainedComponents: 1 },
      refinement: { method: 'source-alpha', status: 'preserved', softAlphaPixels: 0, changedRgbPixels: 0, trimapRadius: 0 },
    };
    const element = { id: 'element', label: 'Icon', kind: 'icon', rect: { x: 0, y: 0, w: 1, h: 1 }, description: '', objectName: 'Icon', state: 'Normal', layer: 2, occluded: false, needsAi: false, approved: false, extractionMethod: 'manual', repainted: true, processingStatus: 'running', maskImage: sourceImage, textPolicy: 'preserve', coordinateSpace: 'source', qualityWarnings: ['Check the soft edge'], segmentationDiagnostics: diagnostics, slice: { width: 1, height: 1, canvas: canvas(), border: { bgColor: [0, 0, 0], sideScore: { top: 0, right: 0, bottom: 0, left: 0 }, dirtySides: [] } } };
    const standalone = { ...task('standalone'), source: { kind: 'standalone', sourceImage } };
    const saved = await codec.persistSliceTask(standalone, [element]);
    assert.ok(saved.elements[0].slice.image);
    assert.ok(!JSON.stringify(saved).includes('canvas'));
    assert.ok(!JSON.stringify(saved).includes('data:image'));
    assert.equal(saved.elements[0].extractionMethod, 'manual');
    assert.equal(saved.elements[0].repainted, true);
    assert.equal(saved.elements[0].maskImage, sourceImage);
    assert.deepEqual(saved.elements[0].segmentationDiagnostics, diagnostics);
    assert.equal(saved.elements[0].textPolicy, 'preserve');
    const invalidTasks = [
      { ...saved, width: 1.5 }, { ...saved, height: 0 }, { ...saved, width: Infinity },
      { ...saved, source: { ...saved.source, sourceImage: null } },
      { ...saved, source: { kind: 'project', sourceImage, projectId: 42, screenId: 's', versionId: 'v' } },
      { ...saved, elements: [{ ...saved.elements[0], approved: 'yes' }] },
      { ...saved, elements: [{ ...saved.elements[0], objectName: null }] },
      { ...saved, elements: [{ ...saved.elements[0], segmentationDiagnostics: {} }] },
      { ...saved, elements: [{ ...saved.elements[0], segmentationDiagnostics: { ...diagnostics, outputBounds: [0, 0, 2, 1] } }] },
      { ...saved, elements: [{ ...saved.elements[0], textPolicy: 'unknown' }] },
      { ...saved, elements: [{ ...saved.elements[0], coordinateSpace: 'unknown' }] },
      { ...saved, elements: [{ ...saved.elements[0], sourceSheetImage: '../outside.png' }] },
      { ...saved, elements: [{ ...saved.elements[0], qualityWarnings: [42] }] },
      { ...saved, elements: [{ ...saved.elements[0], rect: { x: 0, y: 0, w: -1, h: 1 } }] },
      { ...saved, elements: [{ ...saved.elements[0], slice: null }] },
      { ...saved, elements: [{ ...saved.elements[0], slice: { ...saved.elements[0].slice, border: undefined } }] },
      { ...saved, elements: [{ ...saved.elements[0], slice: { ...saved.elements[0].slice, width: 0.5 } }] },
      { ...saved, elements: [{ ...saved.elements[0], slice: { ...saved.elements[0].slice, border: { bgColor: [0, 0, 0], sideScore: {}, dirtySides: [] } } }] },
      { ...saved, elements: [{ ...saved.elements[0], slice: { ...saved.elements[0].slice, border: { bgColor: [0, 0, 0], sideScore: { top: 0, right: 0, bottom: 0, left: 0 }, dirtySides: ['diagonal'] } } }] },
    ];
    const indexPath = path.join(root, 'slice-tasks.json');
    const goodIndex = await fs.readFile(indexPath, 'utf8');
    for (const invalid of invalidTasks) {
      assert.throws(() => store.validateSliceTask(invalid));
      const response = await fetch('/api/slice-tasks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: invalid }) });
      assert.equal(response.status, 500);
      assert.equal(await fs.readFile(indexPath, 'utf8'), goodIndex);
      const badHistory = JSON.stringify([invalid]);
      await fs.writeFile(indexPath, badHistory);
      await assert.rejects(store.listSliceTasks());
      const readResponse = await fetch('/api/slice-tasks');
      assert.equal(readResponse.status, 500, 'invalid historic task must not be returned as success');
      await assert.rejects(store.upsertSliceTask(task('blocked-by-bad-history')));
      assert.equal(await fs.readFile(indexPath, 'utf8'), badHistory);
      await fs.writeFile(indexPath, goodIndex);
    }
    console.log(`PASS ${invalidTasks.length} invalid task cases rejected by validator and REST; invalid history is visible and never overwritten`);
    const restored = await codec.decodeElements(saved.elements);
    assert.equal(restored[0].processingStatus, 'interrupted');
    assert.equal(restored[0].approved, false);
    assert.deepEqual(restored[0].segmentationDiagnostics, diagnostics);
    assert.ok(restored[0].slice.canvas);
    await codec.persistSliceTask(standalone, [{ ...element, approved: true }]);
    assert.equal(uploads, 1, 'metadata edit must reuse immutable canvas file');
    await codec.persistSliceTask(standalone, [{ ...element, slice: { ...element.slice, canvas: canvas() } }]);
    assert.equal(uploads, 2, 'cloned edited canvas must upload a fresh file');
    await Promise.all([codec.persistSliceTask(standalone, [{ ...element, label: 'older' }]), codec.persistSliceTask(standalone, [{ ...element, label: 'latest' }])]);
    const latest = (await store.listSliceTasks()).find((entry) => entry.id === standalone.id);
    assert.equal(latest.elements[0].label, 'latest');
    const imageResponse = await fetch(`/api/image?name=${encodeURIComponent(saved.elements[0].slice.image)}`);
    assert.equal(imageResponse.status, 200);
    assert.ok((await imageResponse.arrayBuffer()).byteLength > 0);
    const rejected = await fetch('/api/slice-tasks', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: { ...standalone, elements: [element] } }) });
    assert.equal(rejected.status, 500);
    const list = await fetch('/api/slice-tasks').then((response) => response.json());
    assert.ok(list.tasks.some((entry) => entry.id === standalone.id));
    console.log('PASS actual REST upload/image/task roundtrip, no JSON Canvas, metadata and mask references, interrupted recovery, cloned canvas upload, ordered saves');

    const watchedDirectories = Object.keys(server.watcher.getWatched()).map((directory) => directory.replaceAll('\\', '/'));
    assert.ok(watchedDirectories.every((directory) => !/\/(?:\.data|\.venv-seg)(?:\/|$)/.test(directory)), 'runtime data and Python environment must not be watched');
    console.log('PASS Vite watcher excludes .data and .venv-seg directories');

    // Simulate a restart with a fresh server and the exact same temporary GAMEUI_DATA.
    await server.close();
    assert.equal(server.httpServer.listening, false, 'first server must fully close before restart');
    const second = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [magpieApi()], server: { host: '127.0.0.1', port: secondPort, strictPort: true, watch: { ignored: ['**/.data/**', '**/.venv-seg/**'] } }, logLevel: 'error' });
    await second.listen();
    try {
      const response = await nativeFetch(`http://127.0.0.1:${second.httpServer.address().port}/api/slice-tasks`).then((entry) => entry.json());
      assert.equal(response.tasks.find((entry) => entry.id === standalone.id).elements[0].label, 'latest');
    } finally { await second.close(); }
    console.log('PASS new development server instance restores persisted tasks');
  } finally { globalThis.fetch = nativeFetch; await server.close(); }
  console.log('All phase 1 store/REST/codec checks passed. DOM and Canvas here are controlled stubs; browser rendering is a separate acceptance.');
}
