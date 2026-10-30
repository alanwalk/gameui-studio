import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';

// Production hook and repaintTask, with a deterministic hook scheduler and paid-model/network stubs.
const directory = await fs.mkdtemp(path.resolve('.data/phase1-fault-'));
const entry = path.resolve('src/lib/sliceTasks.ts').replaceAll('\\', '/');
const bundle = path.join(directory, 'hook.mjs');
await build({ stdin: { contents: `export { useSliceTasks, repaintTask } from '${entry}';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: bundle,
  plugins: [{ name: 'controlled-boundaries', setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'test' }));
    builder.onResolve({ filter: /^\.\/pipeline$/ }, () => ({ path: 'pipeline', namespace: 'test' }));
    builder.onResolve({ filter: /^\.\/magpie$/ }, () => ({ path: 'magpie', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path: name }) => {
      if (name === 'react') return { contents: 'export const useState=(...a)=>globalThis.scheduler.state(...a); export const useRef=(...a)=>globalThis.scheduler.ref(...a); export const useEffect=(...a)=>globalThis.scheduler.effect(...a); export const useCallback=(callback)=>callback;' };
      if (name === 'magpie') return { contents: 'export const imageUrl=(name)=>"/api/image?name="+name;' };
      return { contents: 'export const plateOccluded=(...args)=>globalThis.paidModel(...args);' };
    });
  } }],
});
const slots = [];
let cursor = 0;
let effects = [];
const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
globalThis.scheduler = {
  state(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], (next) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
  ref(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
  effect(callback, deps) { const index = cursor++; const previous = slots[index]; if (!previous || !same(previous.deps, deps)) { previous?.cleanup?.(); slots[index] = { deps }; effects.push(() => { slots[index].cleanup = callback(); }); } },
};
const png = 'data:image/png;base64,dGVzdA==';
const canvas = () => ({ width: 1, height: 1, toDataURL: () => png, getContext: () => ({ drawImage() {} }) });
globalThis.document = { createElement: canvas };
let decodeBarrier = null;
globalThis.Image = class { async decode() { if (decodeBarrier && this.src.includes('other-source.png')) await decodeBarrier; } };
const element = { id: 'one', kind: 'icon', label: 'One', description: '', objectName: 'One', state: '', rect: { x: 0, y: 0, w: 1, h: 1 }, layer: 0, occluded: true, needsAi: true, approved: true, slice: { width: 1, height: 1, image: 'old.png', border: { bgColor: [0, 0, 0], sideScore: { top: 0, right: 0, bottom: 0, left: 0 }, dirtySides: [] } } };
const source = { kind: 'standalone', sourceImage: 'source.png' };
let activeSource = source;
let stored = { schemaVersion: 1, id: 'task', name: 'Task', source, width: 1, height: 1, elements: [element], status: 'done', createdAt: 1, updatedAt: 1 };
let paidCount = 0;
let failCompletedPut = true;
let modelBarrier = null;
let uploads = 0;
let getBarrier = null;
let failModel = false;
globalThis.paidModel = async ([input]) => {
  paidCount++;
  if (modelBarrier) await modelBarrier;
  if (failModel) return { outcomes: [{ id: input.id, ok: false, error: 'injected repaint failure' }], updated: [] };
  return { outcomes: [{ id: input.id, ok: true }], updated: [{ ...input, slice: { ...input.slice, canvas: canvas() } }] };
};
globalThis.fetch = async (url, options) => {
  if (url === '/api/upload') return Response.json({ fileName: `output-${++uploads}.png` });
  assert.equal(url, '/api/slice-tasks');
  if (!options) {
    const snapshot = structuredClone(stored);
    if (getBarrier) await getBarrier;
    return Response.json({ tasks: [snapshot] });
  }
  const task = JSON.parse(options.body).task;
  if (failCompletedPut && task.elements[0]?.repainted) return Response.json({ error: 'injected final PUT failure' }, { status: 503 });
  stored = task;
  return Response.json({ tasks: [stored] });
};
const { useSliceTasks, repaintTask } = await import(pathToFileURL(bundle).href);
let session;
function render() { cursor = 0; session = useSliceTasks(activeSource); const pendingEffects = effects; effects = []; pendingEffects.forEach((effect) => effect()); }
async function settle() { for (let i = 0; i < 12; i++) { render(); await new Promise(setImmediate); } render(); }
await settle();
assert.ok(session.source && session.elements);
const oldElements = session.elements;
await assert.rejects(repaintTask(session, session.task, oldElements, session.source, () => {}), /injected final PUT failure/);
await settle();
assert.equal(paidCount, 1);
assert.equal(session.hasUnsaved, true);
assert.equal(session.elements[0].repainted, true, 'successful output must be visible even when final PUT fails');
assert.equal(session.elements[0].processingStatus, 'done');
const generatedCanvas = session.elements[0].slice.canvas;
await assert.rejects(repaintTask(session, session.task, oldElements, session.source, () => {}), /尚未保存/);
assert.equal(paidCount, 1, 'pending final output must block a second paid request even with stale caller elements');
console.log('PASS final PUT failure preserves generated runtime/pending; stale reentry blocked; paid requests stay 1');
failCompletedPut = false;
await session.retrySave();
await settle();
assert.equal(paidCount, 1);
assert.equal(session.hasUnsaved, false);
assert.equal(session.elements[0].slice.canvas, generatedCanvas);
assert.equal(stored.elements[0].repainted, true);
assert.equal(stored.elements[0].processingStatus, 'done');
console.log('PASS retrySave persists the existing successful artifact without model call or Canvas replacement');

// Start a deliberately new operation, then attempt a duplicate while the model is in flight.
session.changeElements(session.elements.map((entry) => ({ ...entry, repainted: false })));
await settle();
let release;
modelBarrier = new Promise((resolve) => { release = resolve; });
const first = repaintTask(session, session.task, session.elements, session.source, () => {});
await settle();
assert.equal(paidCount, 2);
await assert.rejects(repaintTask(session, session.task, session.elements, session.source, () => {}), /正在补图/);
assert.equal(paidCount, 2);
release();
await first;
await settle();
assert.equal(session.hasUnsaved, false);
console.log('PASS task-level lock blocks concurrent repaint reentry while paid request is in flight');

let releaseGet;
getBarrier = new Promise((resolve) => { releaseGet = resolve; });
const reload = session.reload();
const edited = session.elements.map((item) => ({ ...item, objectName: 'LatestName' }));
session.changeElements(edited);
await settle();
releaseGet();
await reload;
getBarrier = null;
await settle();
assert.equal(session.elements[0].objectName, 'LatestName');
assert.equal(session.task.elements[0].objectName, 'LatestName');
console.log('PASS old GET resolving after a newer edit cannot replace metadata or Canvas');

const originalTask = session.task;
const otherSource = { kind: 'standalone', sourceImage: 'other-source.png' };
await session.save({ ...originalTask, id: 'other-task', source: otherSource }, []);
await settle();
let releaseDecode;
decodeBarrier = new Promise((resolve) => { releaseDecode = resolve; });
activeSource = otherSource;
await settle();
failCompletedPut = true;
const pendingElements = edited.map((item) => ({ ...item, slice: { ...item.slice, canvas: canvas() } }));
await assert.rejects(session.save(originalTask, pendingElements, true), /final PUT failure/);
await settle();
activeSource = source;
await settle();
assert.equal(session.elements[0].slice.canvas, pendingElements[0].slice.canvas, 'returning while another source decodes must restore the pending success, not the old runtime');
releaseDecode();
decodeBarrier = null;
await settle();
assert.equal(session.elements[0].slice.canvas, pendingElements[0].slice.canvas);
activeSource = null;
await settle();
assert.equal(session.elements, null);
activeSource = source;
await settle();
assert.equal(session.elements[0].slice.canvas, pendingElements[0].slice.canvas, 'closing/reopening the view must retain the unsaved successful Canvas');
failCompletedPut = false;
await session.retrySave();
await settle();
console.log('PASS quick A/B/A switch and delayed B decode restore A pending output without cross-source publication');

// A first save can fail before the new task ever appears in the server index.
const newSource = { kind: 'standalone', sourceImage: 'new-source.png' };
activeSource = newSource;
await settle();
failCompletedPut = true;
await assert.rejects(session.save({ ...originalTask, id: 'new-task', source: newSource }, pendingElements, true), /final PUT failure/);
await settle();
assert.equal(session.task?.id, 'new-task', 'an unsaved new task must remain selectable and recoverable');
assert.equal(session.elements[0].slice.canvas, pendingElements[0].slice.canvas);
failCompletedPut = false;
await session.retrySave();
await settle();
assert.equal(session.hasUnsaved, false);
assert.equal(stored.id, 'new-task');
console.log('PASS first-save failure retains the new task and its successful Canvas for save-only retry');
for (const slot of slots) slot?.cleanup?.();
slots.length = 0;
effects = [];
await settle();
assert.equal(session.task.id, 'new-task');
assert.equal(session.elements[0].objectName, 'LatestName');
assert.equal(session.elements[0].repainted, true);
assert.equal(session.hasUnsaved, false);
assert.ok(session.elements[0].slice.canvas);
console.log('PASS view close/reopen retains pending Canvas; fresh hook after saved close/reopen restores persisted artifacts');
session.changeElements(session.elements.map((item) => ({ ...item, repainted: false })));
await settle();
failModel = true;
await repaintTask(session, session.task, session.elements, session.source, () => {});
await settle();
assert.equal(stored.status, 'interrupted');
assert.equal(stored.elements[0].processingStatus, 'failed');
assert.equal(stored.elements[0].processingError, 'injected repaint failure');
failModel = false;
await repaintTask(session, session.task, session.elements, session.source, () => {});
await settle();
assert.equal(stored.status, 'done');
assert.equal(stored.elements[0].processingError, undefined, 'successful repaint retry must clear the previous failure');
console.log('PASS repaint failure persists interrupted task status; successful retry clears failure and returns to done');
console.log(`Fault evidence: ${directory}. Controlled scheduler/Image/Canvas/network; no real paid requests or project store used.`);
