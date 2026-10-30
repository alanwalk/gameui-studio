import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTemplateLayout, LAYOUT_TEMPLATES } from '../src/lib/layoutTemplates.ts';
import { analyzeLayoutReference, decodeLayoutReference, referenceElementsToLayout } from '../src/lib/layoutReference.ts';

test('three templates create independent, bounded nodes on every application', () => {
  assert.equal(LAYOUT_TEMPLATES.length, 3);
  const ids = new Set();
  for (const template of LAYOUT_TEMPLATES) {
    for (const node of [...createTemplateLayout(template.id), ...createTemplateLayout(template.id)]) {
      assert.ok(!ids.has(node.id));
      ids.add(node.id);
      const { x, y, w, h } = node.rect;
      assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 1 && y + h <= 1);
    }
    const layout = createTemplateLayout(template.id);
    layout[0].rect.w = .3;
    assert.equal(createTemplateLayout(template.id)[0].rect.w, 1);
  }
  assert.throws(() => createTemplateLayout('missing'), /未知/);
});

const element = (rect, kind = 'button', layer = 1) => ({ label: 'Confirm', kind, rect, layer, description: '' });
test('reference conversion clips pixel edges and preserves order, kind and text', () => {
  const nodes = referenceElementsToLayout([
    { ...element({ x: -20, y: 90, w: 70, h: 40 }, 'text', 3), text: '确定' },
    element({ x: 40, y: 10, w: 90, h: 30 }, 'frame', 0),
    element({ x: 10, y: 10, w: 20, h: 20 }, 'decor', 2),
  ], 100, 100);
  assert.equal(nodes[0].kind, 'panel');
  assert.equal(nodes[1].kind, 'image');
  assert.equal(nodes[2].text, '确定');
  assert.deepEqual(nodes[2].rect, { x: 0, y: .9, w: .5, h: .1 });
  assert.deepEqual(nodes[0].rect, { x: .4, y: .1, w: .6, h: .3 });
  for (const rect of [{ x: NaN, y: 0, w: 10, h: 10 }, { x: 200, y: 0, w: 10, h: 10 }]) {
    assert.throws(() => referenceElementsToLayout([element(rect)], 100, 100));
  }
  assert.throws(() => referenceElementsToLayout([], 100, 100), /未识别/);
  assert.throws(() => referenceElementsToLayout([], 0, 100), /尺寸/);
});

const detection = { label: 'Confirm', kind: 'button', x: 10, y: 20, w: 30, h: 40, layer: 1 };
test('controlled model uses original image and persists only a server file reference', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(url);
    assert.equal(body.image, 'data:image/png;base64,original');
    if (url === '/api/detect') {
      assert.equal(body.model, 'controlled-vision');
      assert.equal(body.width, 100);
      return Response.json({ content: JSON.stringify({ elements: [detection] }) });
    }
    assert.equal(url, '/api/upload');
    return Response.json({ fileName: 'reference.png' });
  });
  const preview = await analyzeLayoutReference('data:image/png;base64,original', 100, 100, 'controlled-vision', () => true);
  assert.deepEqual(calls, ['/api/detect', '/api/upload']);
  assert.equal(preview.sourceImage, 'reference.png');
  assert.deepEqual(preview.nodes[0].rect, { x: .1, y: .2, w: .3, h: .4 });
  assert.ok(!JSON.stringify(preview).includes('base64'));
});

test('failed analysis never uploads or changes the existing layout', async (t) => {
  const original = createTemplateLayout('home');
  const snapshot = structuredClone(original);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(url);
    return Response.json({ error: 'controlled model failure' }, { status: 503 });
  });
  await assert.rejects(analyzeLayoutReference('original', 100, 100, 'controlled', () => true), /controlled model failure/);
  assert.deepEqual(calls, ['/api/detect']);
  assert.deepEqual(original, snapshot);
});

for (const expireAt of ['/api/detect', '/api/upload']) {
  test(`owner invalidation during ${expireAt} discards results`, async (t) => {
    let generation = 1;
    let complete;
    const gate = new Promise((resolve) => { complete = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      calls.push(url);
      if (url === expireAt) { entered(); await gate; }
      if (url === '/api/detect') return Response.json({ content: JSON.stringify({ elements: [detection] }) });
      return Response.json({ fileName: 'reference.png' });
    });
    const pending = analyzeLayoutReference('original', 100, 100, 'controlled', () => generation === 1);
    await started;
    // Switching away and back or unmounting invalidates the request permanently.
    generation += 2;
    complete();
    assert.equal(await pending, null);
    if (expireAt === '/api/detect') assert.deepEqual(calls, ['/api/detect']);
  });
}

test('upload failures reject without a partial layout result', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === '/api/detect') return Response.json({ content: JSON.stringify({ elements: [detection] }) });
    return Response.json({ error: 'disk full' }, { status: 500 });
  });
  await assert.rejects(analyzeLayoutReference('original', 100, 100, 'controlled', () => true), /disk full/);
});

test('an inactive owner does not start analysis', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not request'); });
  assert.equal(await analyzeLayoutReference('original', 100, 100, 'controlled', () => false), null);
  assert.equal(fetch.mock.callCount(), 0);
});

test('local reference is decoded at original dimensions; decode failure stops the flow', async (t) => {
  const originalReader = globalThis.FileReader;
  const originalImage = globalThis.Image;
  t.after(() => {
    globalThis.FileReader = originalReader;
    globalThis.Image = originalImage;
  });
  let rejectDecode = false;
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:image/png;base64,original'; this.onload(); }
  };
  globalThis.Image = class {
    naturalWidth = 1920;
    naturalHeight = 1080;
    async decode() {
      assert.equal(this.src, 'data:image/png;base64,original');
      if (rejectDecode) throw new Error('invalid image');
    }
  };
  assert.deepEqual(await decodeLayoutReference({}), {
    dataUrl: 'data:image/png;base64,original', width: 1920, height: 1080,
  });
  rejectDecode = true;
  await assert.rejects(decodeLayoutReference({}), /invalid image/);
});
