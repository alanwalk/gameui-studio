// Bundle with esbuild --bundle --platform=node --format=esm --packages=external.
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import JSZip from 'jszip';
import { buildEntries, buildZip } from '../src/lib/export.ts';
import { toUiElements, sliceAll, plateOccluded } from '../src/lib/pipeline.ts';
import { buildFileName } from '../src/lib/naming.ts';
import { buildReskinPlan, assertSizeKept } from '../src/lib/reskin.ts';
import { rebuildSlices } from '../src/components/ReskinTool.tsx';

// Real, distinct PNG fixtures: Canvas only stubs browser I/O, JSZip is real.
const pngs = [
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
].map((base64) => `data:image/png;base64,${base64}`);

// These fixtures are 1x1, 8-bit grayscale+alpha. Decode IDAT to check actual pixels.
function fixturePixel(bytes) {
  const png = Buffer.from(bytes);
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
  assert.equal(png[24], 8);
  assert.equal(png[25], 4);
  const imageChunks = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') imageChunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const row = inflateSync(Buffer.concat(imageChunks));
  assert.equal(row[0], 1); // Sub filter, with zero left pixel on a 1x1 image.
  return [...row.subarray(1)];
}

class CanvasStub {
  width = 1;
  height = 1;
  dataUrl = pngs[0];
  getContext() {
    return {
      drawImage: (image) => { this.dataUrl = image.src; },
      putImageData: () => {},
    };
  }
  toDataURL() { return this.dataUrl; }
}

const settings = {
  module: 'Common', includeTextAsImage: false,
  tolerance: 0.1, softness: 0.1, hardEdge: false, fringeFix: false,
};
function element(id, overrides = {}) {
  const canvas = new CanvasStub();
  canvas.dataUrl = pngs[Number(id) % 2] ?? pngs[0];
  return {
    id: String(id), rect: { x: Number(id) || 0, y: 0, w: 1, h: 1 },
    kind: 'icon', label: `Icon ${id}`, description: 'Fixture',
    objectName: 'CoinIcon', state: '', layer: 0,
    occluded: true, needsAi: true, approved: true,
    slice: {
      width: 1, height: 1, canvas,
      border: { bgColor: [0, 0, 0], sideScore: {}, dirtySides: [] },
    },
    ...overrides,
  };
}

async function readPack(elements, options = settings) {
  const result = await buildZip(elements, options);
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer(), { checkCRC32: true });
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  const coords = JSON.parse(await zip.file('coords.json').async('string'));
  assert.deepEqual(manifest, JSON.parse(JSON.stringify(result.entries)));
  assert.deepEqual(coords, manifest.map((entry) => ({
    file: entry.fileName, ...entry.source, layer: entry.layer,
  })));
  assert.deepEqual(
    Object.keys(zip.files).filter((name) => name.startsWith('png/') && !zip.files[name].dir).sort(),
    manifest.map((entry) => `png/${entry.fileName}`).sort(),
  );
  assert.equal(new Set(manifest.map((entry) => entry.fileName.toLowerCase())).size, manifest.length);
  for (const entry of manifest) {
    assert.equal(entry.unityPath, `Assets/Art/Textures/UI/Common/${entry.fileName}`);
    const bytes = await zip.file(`png/${entry.fileName}`).async('uint8array');
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
  assert.match(await zip.file('GameUiSliceImporter.cs').async('string'), /UNITY_EDITOR/);
  const importer = await zip.file('GameUiSliceImporter.cs').async('string');
  assert.match(importer, /textureSettings.spriteAlignment = \(int\)SpriteAlignment.Center;/);
  assert.match(importer, /textureSettings.spritePivot = new Vector2\(0.5f, 0.5f\);/);
  assert.match(importer, /importer.ReadTextureSettings\(textureSettings\);/);
  assert.match(importer, /importer.SetTextureSettings\(textureSettings\);/);
  assert.doesNotMatch(importer, /importer.spritePivot = SpriteAlignment/);
  assert.match(await zip.file('README.md').async('string'), /includeTextAsImage/);
  return { zip, manifest };
}

let passed = 0;
async function check(name, run) {
  await run();
  console.log(`PASS ${++passed}: ${name}`);
}

await check('ZIP collisions preserve each PNG payload, including case and suffix collisions', async () => {
  const inputs = [element(0), element(1), element(2, { objectName: 'CoinIcon_02' }),
    element(3, { objectName: 'coinicon' })];
  const { zip, manifest } = await readPack(inputs);
  assert.equal(manifest.length, 4);
  for (let i = 0; i < inputs.length; i++) {
    const actual = await zip.file(`png/${manifest[i].fileName}`).async('base64');
    assert.equal(actual, inputs[i].slice.canvas.dataUrl.split(',')[1]);
  }
});

await check('pipeline uniqueness survives filename rebuilding and export', async () => {
  const detected = ['CoinIcon', 'CoinIcon', 'CoinIcon02', 'CoinIcon', 'CoinIconPressed', 'CoinIconPressed']
    .map((label, layer) => ({ label, layer, kind: 'icon', description: '', rect: { x: 0, y: 0, w: 1, h: 1 } }));
  const prepared = toUiElements(detected, settings);
  const rebuilt = prepared.map((item) => buildFileName(settings.module, item.objectName, item.state));
  assert.equal(new Set(rebuilt).size, prepared.length);
  const { manifest } = await readPack(prepared.map((item) => ({ ...item, slice: element(0).slice })));
  assert.deepEqual(manifest.map((entry) => entry.fileName), rebuilt);
});

await check('text toggle, review exclusion and missing slices agree across PNG/manifest/coords', async () => {
  const inputs = [element(0), element(1, { kind: 'text', text: 'Hello' }),
    element(2, { approved: false }), element(3, { slice: undefined }),
    element(4, { kind: 'text', approved: false })];
  assert.equal((await readPack(inputs)).manifest.length, 1);
  const enabled = await readPack(inputs, { ...settings, includeTextAsImage: true });
  assert.equal(enabled.manifest.length, 2);
  assert.equal(enabled.manifest[1].text, 'Hello');
  assert.equal(inputs[1].approved, true, 'export must not alter review state');
});

await check('empty selections and invalid canvas output fail instead of emitting an empty pack', async () => {
  for (const inputs of [[], [element(0, { approved: false })], [element(0, { slice: undefined })],
    [element(0, { kind: 'text' })]]) {
    assert.deepEqual(buildEntries(inputs, settings), []);
    await assert.rejects(buildZip(inputs, settings), /没有可导出/);
  }
  const zero = element(0);
  zero.slice.canvas.width = 0;
  await assert.rejects(buildZip([zero], settings), /尺寸无效/);
  const empty = element(0);
  empty.slice.canvas.dataUrl = 'data:,';
  await assert.rejects(buildZip([empty], settings), /有效的 PNG/);
});

await check('needsAi is never repaint evidence; optional provenance is preserved', async () => {
  const { manifest } = await readPack([
    element(0), element(1, { extractionMethod: 'color-key' }),
    element(2, { repainted: true, needsAi: false }),
    element(3, { extractionMethod: 'repaint', repainted: false }),
    element(4, { extractionMethod: 'manual' }), element(5, { extractionMethod: 'segmentation' }),
  ]);
  assert.deepEqual(manifest.map((entry) => entry.repainted), [false, false, true, true, false, false]);
  assert.equal(manifest[1].extractionMethod, 'color-key');
  assert.equal(manifest[4].extractionMethod, 'manual');
  assert.equal(manifest[5].extractionMethod, 'segmentation');
  assert.equal('extractionMethod' in manifest[0], false);
});

await check('nonfinite/fractional sizes, invalid rects and mismatched canvas are rejected', async () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -1, 1.5]) {
    for (const target of ['slice', 'canvas', 'rect']) {
      const input = element(0);
      if (target === 'slice') input.slice.width = bad;
      if (target === 'canvas') input.slice.canvas.height = bad;
      if (target === 'rect') input.rect.w = bad;
      await assert.rejects(buildZip([input], settings), /尺寸无效/);
    }
  }
  const mismatch = element(0);
  mismatch.slice.canvas.width = 2;
  await assert.rejects(buildZip([mismatch], settings), /画布与切片尺寸不一致/);
  const badPosition = element(0);
  badPosition.rect.x = NaN;
  await assert.rejects(buildZip([badPosition], settings), /尺寸无效/);
});

await check('fallback processing status/error and explicit source-to-PNG scaling survive real ZIP', async () => {
  const input = element(0, {
    rect: { x: 12, y: 23, w: 4, h: 8 }, extractionMethod: 'color-key',
    processingStatus: 'failed', processingError: 'plate decode failed; original retained',
  });
  const { manifest } = await readPack([input]);
  assert.equal(manifest[0].processingStatus, 'failed');
  assert.equal(manifest[0].processingError, input.processingError);
  assert.equal(manifest[0].repainted, false);
  assert.deepEqual(manifest[0].imageSize, { width: 1, height: 1 });
  assert.deepEqual(manifest[0].sourceMapping, {
    source: input.rect, destination: { x: 0, y: 0, w: 1, h: 1 },
  });
});

const savedGlobals = { document: globalThis.document, Image: globalThis.Image,
  ImageData: globalThis.ImageData, fetch: globalThis.fetch };
try {
  globalThis.document = { createElement: () => new CanvasStub() };
  globalThis.Image = class {
    src = '';
    async decode() { if (!pngs.includes(this.src)) throw new Error('Fixture decode failed'); }
  };
  globalThis.ImageData = class {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  };

  await check('reskin [unchecked A, B, C] with duplicate names assigns distinct PNGs by ID', async () => {
    const inputs = [element(0, { approved: false }), element(1), element(2)];
    const plan = buildReskinPlan(inputs, 'ice', settings);
    assert.deepEqual(plan.items.map((item) => item.elementId), ['1', '2']);
    assert.deepEqual(plan.items.map((item) => item.fileName), buildEntries(inputs, settings).map((entry) => entry.fileName));
    assert.notEqual(plan.items[0].fileName, plan.items[1].fileName);
    const redraws = new Map(plan.items.map((item, index) => [item.elementId, {
      elementId: item.elementId, fileName: item.fileName, dataUrl: pngs[index], w: 1, h: 1,
    }]));
    assert.deepEqual(assertSizeKept(plan, redraws), []);
    const rebuilt = await rebuildSlices(inputs, redraws);
    assert.equal(rebuilt[0], inputs[0]);
    for (let i = 1; i <= 2; i++) {
      assert.equal(rebuilt[i].slice.canvas.dataUrl, pngs[i - 1]);
      assert.equal(rebuilt[i].repainted, true);
      assert.equal(rebuilt[i].extractionMethod, 'repaint');
      assert.equal(inputs[i].repainted, undefined);
    }
    const { zip, manifest } = await readPack(rebuilt);
    assert.deepEqual(manifest.map((entry) => entry.fileName), plan.items.map((item) => item.fileName));
    for (let i = 0; i < manifest.length; i++) {
      assert.equal(await zip.file(`png/${manifest[i].fileName}`).async('base64'), pngs[i].split(',')[1]);
      const bytes = await zip.file(`png/${manifest[i].fileName}`).async('uint8array');
      assert.deepEqual(fixturePixel(bytes), i === 0 ? [255, 255] : [0, 255]);
    }
    const partial = await rebuildSlices(inputs, new Map([[plan.items[1].elementId, redraws.get('2')]]));
    assert.equal(partial[0], inputs[0]);
    assert.equal(partial[1], inputs[1]);
    assert.equal(partial[2].slice.canvas.dataUrl, pngs[1]);
  });

  await check('reskin rejects decode failure, NaN, mismatched dimensions/IDs without marking original', async () => {
    const input = element(1, { extractionMethod: 'color-key', repainted: false });
    const redraw = { elementId: input.id, fileName: 'unused.png', dataUrl: pngs[1], w: 1, h: 1 };
    for (const patch of [{ dataUrl: 'broken-image' }, { w: NaN }, { w: 2 }, { elementId: 'other' }]) {
      await assert.rejects(rebuildSlices([input], new Map([[input.id, { ...redraw, ...patch }]])));
      assert.equal(input.repainted, false);
      assert.equal(input.extractionMethod, 'color-key');
    }
    const mismatch = element(1);
    mismatch.slice.canvas.width = 2;
    await assert.rejects(rebuildSlices([mismatch], new Map([[input.id, redraw]])), /尺寸或元素 ID 不一致/);
  });

  await check('reslicing replaces old repaint provenance with color-key', async () => {
    const source = { width: 4, height: 4, data: new Uint8ClampedArray(4 * 4 * 4).fill(255) };
    const sliced = sliceAll([element(0, { repainted: true, extractionMethod: 'repaint' })], source, settings, () => {});
    assert.equal(sliced[0].extractionMethod, 'color-key');
    assert.equal(sliced[0].repainted, false);
    assert.equal((await readPack(sliced)).manifest[0].repainted, false);
  });

  await check('real plate flow marks only successful decode/fit/slice; failures retain color-key', async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      const call = calls++;
      if (call === 1) throw new Error('Fixture network failure');
      return { ok: true, json: async () => ({ dataUrl: call === 2 ? 'broken-image' : pngs[1] }) };
    };
    const inputs = [0, 1, 2, 3, 4].map((id) => element(id, { extractionMethod: 'color-key', repainted: false }));
    inputs[3].approved = false;
    inputs[4].needsAi = false;
    const progress = [];
    const { updated, outcomes } = await plateOccluded(inputs, { dataUrl: pngs[0] }, (p) => progress.push(p));
    assert.equal(calls, 3);
    assert.deepEqual(outcomes.map((outcome) => outcome.ok), [true, false, false]);
    assert.equal(progress.at(-1).done, 3);
    assert.equal(updated[0].extractionMethod, 'repaint');
    assert.equal(updated[0].repainted, true);
    assert.equal(updated[0].slice.canvas.dataUrl, pngs[1]);
    for (let i = 1; i < inputs.length; i++) assert.equal(updated[i], inputs[i]);
    assert.equal(inputs[0].repainted, false, 'plate must not mutate its input');
    const { manifest } = await readPack(updated);
    assert.deepEqual(manifest.map((entry) => entry.repainted), [true, false, false, false]);
    assert.deepEqual(manifest.map((entry) => entry.extractionMethod), ['repaint', 'color-key', 'color-key', 'color-key']);
  });
} finally {
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
}
console.log(`export-check: ${passed} checks passed`);
