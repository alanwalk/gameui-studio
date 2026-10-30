import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Production hook, batch helper AND segmentElement; controlled HTTP/Image/Canvas only.
const directory = await fs.mkdtemp(path.resolve('.data/stage3-regression-'));
const bundle = path.join(directory, 'batch.mjs');
const entry = path.resolve('src/lib/sliceTasks.ts').replaceAll('\\', '/');
let detected = [];
let detections = 0;
let keyed = 0;
globalThis.batchPipeline = {
  analyze: async () => { detections++; return detected; },
  toUiElements: (items, settings) => items.map((item) => ({ ...item, approved: item.kind !== 'text' || settings.includeTextAsImage })),
  sliceAll: (items) => { keyed++; return items.map((item) => ({ ...item, extractionMethod: 'color-key', slice: { canvas: canvas(), width: 2, height: 2, border: {} } })); },
};
await build({ stdin: { contents: `export { useSliceTasks, extractSliceTask } from '${entry}';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: bundle,
  plugins: [{ name: 'controlled-boundaries', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'test' }));
    builder.onResolve({ filter: /^\.\/pipeline$/ }, () => ({ path: 'pipeline', namespace: 'test' }));
    builder.onResolve({ filter: /^\.\/magpie$/ }, () => ({ path: 'magpie', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: name }) => {
      if (name === 'react') return { contents: 'export const useState=(...a)=>globalThis.scheduler.state(...a); export const useRef=(...a)=>globalThis.scheduler.ref(...a); export const useEffect=(...a)=>globalThis.scheduler.effect(...a); export const useCallback=(callback)=>callback;' };
      if (name === 'magpie') return { contents: 'export const imageUrl=(name)=>"/api/image?name="+name;' };
      return { contents: 'export const analyze=(...a)=>globalThis.batchPipeline.analyze(...a); export const toUiElements=(...a)=>globalThis.batchPipeline.toUiElements(...a); export const sliceAll=(...a)=>globalThis.batchPipeline.sliceAll(...a); export const plateOccluded=()=>{throw Error("unexpected repaint")};' };
    });
  } }],
});
let slots = [];
let cursor = 0;
let effects = [];
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
globalThis.scheduler = {
  state(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
  ref(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
  effect(callback, deps) { const i = cursor++; const previous = slots[i]; if (!previous || !same(previous.deps, deps)) { previous?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = callback(); }); } },
};
function canvas() {
  return { width: 8, height: 8, toDataURL: () => 'data:image/png;base64,dGVzdA==', getContext: () => ({
    drawImage() {}, putImageData() {}, getImageData: (_x, _y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }),
  }) };
}
globalThis.document = { createElement: canvas };
globalThis.Image = class { naturalWidth = 8; naturalHeight = 8; async decode() {} };
const element = (id, kind = 'icon') => ({ id, kind, label: id, description: '', objectName: id, state: '', rect: { x: 1, y: 1, w: 2, h: 2 }, layer: 0, occluded: false, needsAi: false, approved: kind !== 'text' });
const owner = { kind: 'standalone', sourceImage: 'original.png' };
let activeSource = owner;
let stored = { schemaVersion: 1, id: 'task', name: 'Task', source: owner, width: 8, height: 8, elements: [], status: 'idle', createdAt: 1, updatedAt: 1 };
let requests = [];
let saves = [];
let healthCalls = 0;
let healthy = true;
let failId = null;
let failSave = false;
let releaseModel = null;
let modelBarrier = null;
globalThis.fetch = async (url, options) => {
  if (url === '/api/segment-health') { healthCalls++; return Response.json({ available: healthy, status: 'injected missing runtime' }, { status: healthy ? 200 : 503 }); }
  if (url === '/api/segment') {
    const input = JSON.parse(options.body);
    requests.push(input);
    if (modelBarrier) await modelBarrier;
    if (input.rect.x === failId) return Response.json({ error: 'injected model failure' }, { status: 502 });
    return Response.json({ width: 8, height: 8, rgbaBase64: 'test', maskBase64: 'test' });
  }
  if (url === '/api/upload') return Response.json({ fileName: 'saved.png' });
  assert.equal(url, '/api/slice-tasks');
  if (!options) return Response.json({ tasks: [stored] });
  const target = JSON.parse(options.body).task;
  if (failSave) return Response.json({ error: 'injected save failure' }, { status: 503 });
  stored = target;
  saves.push(structuredClone(target));
  return Response.json({ tasks: [stored] });
};
const { useSliceTasks, extractSliceTask } = await import(pathToFileURL(bundle).href);
let session;
function render() { cursor = 0; session = useSliceTasks(activeSource); const pending = effects; effects = []; pending.forEach((effect) => effect()); }
async function settle() { for (let i = 0; i < 12; i++) { render(); await new Promise(setImmediate); } render(); }
const settings = { includeTextAsImage: true };
const progress = [];
const run = (method, redetect = false) => extractSliceTask(session, session.task, session.elements, session.source, settings, (message) => progress.push(message), method, redetect);
await settle();
detected = [element('one'), { ...element('two'), rect: { x: 3, y: 1, w: 2, h: 2 } }, element('text', 'text')];
failId = 3;
await run();
await settle();
assert.equal(healthCalls, 1);
assert.equal(requests.length, 2);
assert.equal(keyed, 0);
assert.equal(detections, 1);
assert.ok(requests.every((request) => request.sourceImage === 'original.png'));
assert.deepEqual(requests[0].rect, detected[0].rect);
assert.equal(stored.elements[0].extractionMethod, 'segmentation');
assert.equal(stored.elements[1].processingStatus, 'failed');
assert.equal(stored.status, 'interrupted', 'partial failure must not persist a successful task status');
assert.equal(stored.elements[2].approved, false);
assert.equal(stored.elements[2].slice, undefined);
assert.ok(saves[0].elements[0].slice);
console.log('PASS default real segmentElement HTTP path; original rect/source; once-per-run health; text not exported; partial result persisted; no color-key fallback');

// A fresh hook instance represents reload: decode stored PNG, retry only the failed item.
slots = []; effects = [];
await settle();
failId = null;
await run();
await settle();
assert.equal(requests.length, 3);
assert.equal(detections, 1);
assert.equal(stored.elements[1].processingStatus, 'done');
console.log('PASS reload restores successful PNG; retry processes only failed item');

healthy = false;
const beforeUnavailable = JSON.stringify(stored);
await assert.rejects(run(), /runtime/);
assert.equal(JSON.stringify(stored), beforeUnavailable);
assert.equal(keyed, 0);
healthy = true;
await run('color-key');
await settle();
assert.equal(keyed, 2);
assert.equal(requests.length, 3);
console.log('PASS unavailable health is explicit and non-destructive; explicit color-key selects sliceAll');

failSave = true;
await assert.rejects(run(), /save failure/);
await settle();
assert.equal(requests.length, 4);
assert.equal(session.hasUnsaved, true);
const successfulCanvas = session.elements[0].slice.canvas;
await assert.rejects(run(), /尚未保存/);
assert.equal(requests.length, 4);
failSave = false;
await session.retrySave();
await settle();
assert.equal(session.elements[0].slice.canvas, successfulCanvas);
await run();
await settle();
assert.equal(requests.length, 5);
assert.equal(session.hasUnsaved, false);
console.log('PASS final-save failure preserves successful Canvas/pending; stale reentry blocked; retrySave makes no model call; resume skips saved success');

const edited = { ...session.elements[0], objectName: 'UserName', approved: false };
session.changeElements([edited, ...session.elements.slice(1)]);
await settle();
detected = [element('one'), { ...element('new'), rect: { x: 5, y: 1, w: 2, h: 2 } }];
failId = 5;
await run(undefined, true);
await settle();
assert.equal(stored.elements[0].objectName, 'UserName');
assert.equal(stored.elements[0].approved, false);
assert.ok(stored.elements[0].slice);
assert.ok(stored.elements.find((item) => item.id === 'two').slice);
assert.equal(stored.elements.find((item) => item.id === 'new').processingStatus, 'failed');
console.log('PASS re-detection first-item failure retains old owner, user metadata, approval, unmatched elements and successful artifacts');

failId = null;
modelBarrier = new Promise((resolve) => { releaseModel = resolve; });
const staleSession = session;
const background = run();
await settle();
await assert.rejects(run(), /正在提取/);
activeSource = { kind: 'standalone', sourceImage: 'different.png' };
await settle();
const progressBeforeSwitch = progress.length;
releaseModel();
await background;
await settle();
assert.equal(stored.source.sourceImage, 'original.png');
assert.equal(session.elements, null);
assert.equal(staleSession.isCurrent(owner), false);
assert.equal(progress.length, progressBeforeSwitch);
console.log('PASS concurrent run guarded; background save uses captured owner after source switch; stale result/progress never publishes to new source');

modelBarrier = null;
activeSource = owner;
await settle();
const previousElements = session.elements;
const requestCount = requests.length;
// Model labels/order can change: IDs are not stable element identities.
detected = previousElements.filter((item) => item.kind !== 'text').map((item, index) => ({ ...item, id: `renamed-${index}`, label: `Renamed ${index}` }));
await run(undefined, true);
await settle();
assert.equal(stored.elements.length, previousElements.length, 'same regions with new IDs must not duplicate existing artifacts');
assert.equal(requests.length, requestCount, 'redetection must skip already successful regions');
assert.equal(stored.elements[0].objectName, 'UserName');
// Conversely, an old detector ID at a different location is a new element.
detected = [{ ...element(previousElements[0].id), rect: { x: 0, y: 5, w: 2, h: 2 } }];
await run(undefined, true);
await settle();
assert.equal(stored.elements.length, previousElements.length + 1);
assert.equal(new Set(stored.elements.map((item) => item.id)).size, stored.elements.length);
assert.ok(stored.elements.find((item) => item.rect.y === 5)?.slice);
console.log('PASS redetection matches regions despite changed IDs and gives reused IDs at new regions independent identity');

const protectedElements = session.elements.map((item, index) => {
  if (index === 0) return { ...item, extractionMethod: 'manual', processingStatus: 'failed' };
  if (index === 1) return { ...item, extractionMethod: 'repaint', repainted: true, processingStatus: 'interrupted' };
  return item;
});
session.changeElements(protectedElements);
await settle();
const protectedCanvases = session.elements.slice(0, 2).map((item) => item.slice.canvas);
const beforeKeyed = keyed;
await run('color-key');
await settle();
assert.equal(keyed - beforeKeyed, protectedElements.filter((item, index) => index > 1 && item.slice).length);
assert.deepEqual(session.elements.slice(0, 2).map((item) => item.slice.canvas), protectedCanvases);
assert.equal(stored.status, 'interrupted');
console.log('PASS method switch preserves manual/repaint artifacts even with failed/interrupted status');
console.log(`Evidence: ${directory}. Controlled HTTP/Image/Canvas and detector; NOT real MobileSAM inference or browser acceptance.`);
