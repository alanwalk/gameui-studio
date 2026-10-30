import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// Bundle the actual module so Node does not depend on platform-specific extension resolution.
const moduleBuild = await build({ entryPoints: ['src/lib/magpie.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { detectElements } = await import(`data:text/javascript;base64,${Buffer.from(moduleBuild.outputFiles[0].contents).toString('base64')}`);

const request = { dataUrl: 'data:image/png;base64,mock', width: 800, height: 600, model: 'mock' };
const button = { label: 'ConfirmButton', kind: 'button', x: 20, y: 30, w: 40, h: 50, layer: 1 };

async function detect(t, elements, dimensions = {}) {
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, '/api/detect');
    assert.equal(init.method, 'POST');
    assert.equal(JSON.parse(init.body).model, 'mock');
    return Response.json({ content: JSON.stringify({ elements }) });
  });
  return detectElements({ ...request, ...dimensions });
}

test('missing dimensions must reject instead of growing a 780x570 edge box', async (t) => {
  const { w, h, ...missingSize } = button;
  await assert.rejects(detect(t, [missingSize]), /坐标.*w.*有限数字/);
});

const invalidCases = [
  ['missing x', { x: undefined }, /坐标.*x.*有限数字/],
  ['missing y', { y: undefined }, /坐标.*y.*有限数字/],
  ['missing height', { h: undefined }, /坐标.*h.*有限数字/],
  ['zero width', { w: 0 }, /宽高必须大于 0/],
  ['negative height', { h: -5 }, /宽高必须大于 0/],
  ['null x', { x: null }, /坐标.*x.*有限数字/],
  ['boolean x', { x: true }, /坐标.*x.*有限数字/],
  ['empty x', { x: '' }, /坐标.*x.*有限数字/],
  ['blank width', { w: '  ' }, /坐标.*w.*有限数字/],
  ['array coordinate', { y: [] }, /坐标.*y.*有限数字/],
  ['nonnumeric coordinate', { y: 'unknown' }, /坐标.*y.*有限数字/],
  ['NaN string', { w: 'NaN' }, /坐标.*w.*有限数字/],
  ['infinity string', { h: 'Infinity' }, /坐标.*h.*有限数字/],
  ['overflow number', { x: '1e309' }, /坐标.*x.*有限数字/],
  ['overflow right edge', { x: 1e308, w: 1e308 }, /坐标边界必须是有限数字/],
  ['wholly outside image', { x: 801 }, /原图内没有有效像素/],
  ['starts at right edge', { x: 800 }, /原图内没有有效像素/],
  ['wholly left of image', { x: -60 }, /原图内没有有效像素/],
  ['empty after rounding', { x: 20.1, w: 0.1 }, /原图内没有有效像素/],
  ['short bbox', { bbox: [1, 2, 3] }, /bbox.*4/],
  ['non-array bbox', { bbox: '1,2,3,4' }, /bbox.*4/],
  ['null bbox', { bbox: null }, /bbox.*4/],
  ['invalid bbox coordinate', { bbox: [10, 20, null, 40] }, /坐标.*bbox\[2\].*有限数字/],
  ['infinite bbox coordinate', { bbox: [10, 20, 'Infinity', 40] }, /坐标.*bbox\[2\].*有限数字/],
  ['zero-area bbox', { bbox: [10, 20, 10, 40] }, /宽高必须大于 0/],
  ['invalid primary width cannot hide behind alias', { w: null, width: 40 }, /坐标.*w.*有限数字/],
];
for (const [name, changes, message] of invalidCases) {
  test(`reject ${name}`, async (t) => {
    await assert.rejects(detect(t, [{ ...button, ...changes }]), message);
  });
}

const validCases = [
  ['integer rectangle', button, { x: 20, y: 30, w: 40, h: 50 }],
  ['numeric strings', { ...button, x: '20', y: '30', w: '40', h: '50' }, { x: 20, y: 30, w: 40, h: 50 }],
  ['width/height aliases', { label: 'Panel', kind: 'panel', x: 20, y: 30, width: '40', height: '50' }, { x: 20, y: 30, w: 40, h: 50 }],
  ['reversed numeric-string bbox', { ...button, bbox: ['60', '80', '20', '30'] }, { x: 20, y: 30, w: 40, h: 50 }],
  ['bbox takes precedence', { ...button, x: null, bbox: [20, 30, 60, 80] }, { x: 20, y: 30, w: 40, h: 50 }],
  ['round endpoints in original pixels', { ...button, x: 20.4, y: 30.6, w: 40.4, h: 50.2 }, { x: 20, y: 31, w: 41, h: 50 }],
  ['clip partial left/top overlap', { ...button, x: -10, y: -20 }, { x: 0, y: 0, w: 30, h: 30 }],
  ['clip partial right/bottom overlap', { ...button, x: 780, y: 580 }, { x: 780, y: 580, w: 20, h: 20 }],
  ['clip bbox to original image', { ...button, bbox: [820, 620, 780, 580] }, { x: 780, y: 580, w: 20, h: 20 }],
  ['explicit full-image art is valid', { ...button, x: 0, y: 0, w: 800, h: 600 }, { x: 0, y: 0, w: 800, h: 600 }],
];
for (const [name, element, expected] of validCases) {
  test(`preserve ${name}`, async (t) => {
    const [result] = await detect(t, [element]);
    assert.deepEqual(result.rect, expected);
  });
}

test('one invalid element rejects the batch rather than returning partial detections', async (t) => {
  await assert.rejects(detect(t, [button, { ...button, label: 'BrokenPanel', h: 0 }]), /BrokenPanel.*宽高必须大于 0/);
});

test('preserve deduplication, layer order, text, kind fallback and name alias', async (t) => {
  const elements = await detect(t, [
    { ...button, label: 'Caption', kind: 'text', text: '开始', layer: '3' },
    button,
    { ...button, label: 'confirmbutton', x: 99 },
    { ...button, label: undefined, name: 'Artwork', kind: 'unknown', layer: 0 },
  ]);
  assert.deepEqual(elements.map(e => [e.label, e.kind, e.layer, e.text]), [
    ['Artwork', 'decor', 0, undefined],
    ['ConfirmButton', 'button', 1, undefined],
    ['Caption', 'text', 3, '开始'],
  ]);
  assert.equal(elements[1].rect.x, 20);
});

test('invalid JSON stays an error without guessing character replacements', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ content: '{"elements":[{"label":"Broken","x":1,"y"]=245}]}' }));
  await assert.rejects(detectElements(request), SyntaxError);
});

test('non-finite JSON number is rejected rather than replaced with a fallback', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ content: '{"elements":[{"label":"Infinite","x":1e309,"y":0,"w":20,"h":20}]}' }));
  await assert.rejects(detectElements(request), /坐标.*x.*有限数字/);
});

for (const dimensions of [{ width: 0 }, { height: Infinity }, { width: 800.5 }, { height: -1 }]) {
  test(`reject invalid original image dimensions ${JSON.stringify(dimensions)} before requesting`, async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not request'); });
    await assert.rejects(detectElements({ ...request, ...dimensions }), /原图宽高必须是正整数/);
    assert.equal(fetch.mock.callCount(), 0);
  });
}
