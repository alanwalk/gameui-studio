import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeAlphaSheetPixels, splitAlphaSheetPixels } from '../src/lib/alphaComponents.ts';
import { keyElement, sampleBackgroundColor } from '../src/lib/key.ts';

function image(width, height, background = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, rgba) => data.set(rgba, (y * width + x) * 4);
  const fill = (x, y, w, h, rgba) => {
    for (let row = y; row < y + h; row++) {
      for (let column = x; column < x + w; column++) set(column, row, rgba);
    }
  };
  fill(0, 0, width, height, background);
  return { width, height, data, set, fill };
}

const split = (source) => splitAlphaSheetPixels(source.data, source.width, source.height);
const alphaAt = (slice, x, y) => slice.rgba[(y * slice.width + x) * 4 + 3];
const white = [250, 245, 230, 255];
const keyOptions = { tolerance: 10, softness: 30, hardEdge: false, fringeFix: true };

function assertPixelOwnership(source, slices) {
  const reconstructed = new Uint8ClampedArray(source.data.length);
  for (const slice of slices) {
    for (let y = 0; y < slice.rect.h; y++) {
      for (let x = 0; x < slice.rect.w; x++) {
        const local = (y * slice.rect.w + x) * 4;
        if (!slice.rgba[local + 3]) continue;
        const global = ((slice.rect.y + y) * source.width + slice.rect.x + x) * 4;
        assert.equal(reconstructed[global + 3], 0, 'a visible pixel belongs to only one asset');
        reconstructed.set(slice.rgba.subarray(local, local + 4), global);
      }
    }
  }
  for (let offset = 0; offset < source.data.length; offset += 4) {
    if (!source.data[offset + 3]) continue;
    assert.deepEqual(reconstructed.subarray(offset, offset + 4), source.data.subarray(offset, offset + 4),
      'all source foreground colour and alpha values survive extraction');
  }
}

test('a thin diagonal remains one complete eight-connected asset, even below 24 pixels', () => {
  const source = image(30, 30);
  for (let index = 0; index < 12; index++) source.set(4 + index, 5 + index, white);
  const slices = split(source);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].pixelCount, 12);
  assert.deepEqual(slices[0].rect, { x: 4, y: 5, w: 12, h: 12 });
  assertPixelOwnership(source, slices);
});

test('small detached highlights are retained with an unambiguous body', () => {
  const source = image(80, 50);
  source.fill(10, 10, 20, 20, white);
  source.fill(15, 7, 2, 2, [255, 200, 30, 160]);
  const slices = split(source);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].componentCount, 2);
  assert.equal(slices[0].rect.y, 7);
  assertPixelOwnership(source, slices);
});

test('small strong icons and substantial entirely soft effects remain separate assets', () => {
  const source = image(80, 50);
  source.fill(10, 10, 20, 20, white);
  source.set(60, 35, [30, 220, 255, 255]);
  source.fill(55, 10, 10, 10, [230, 220, 255, 8]);
  const slices = split(source);
  assert.equal(slices.length, 3);
  assertPixelOwnership(source, slices);
});

test('isolated low-alpha fragments are reported rather than exported as hundreds of assets', () => {
  const source = image(100, 80);
  source.fill(5, 5, 20, 20, white);
  for (let y = 40; y < 75; y += 3) {
    for (let x = 40; x < 95; x += 3) source.set(x, y, [255, 0, 255, 1]);
  }
  const { components, diagnostics } = analyzeAlphaSheetPixels(source.data, source.width, source.height);
  assert.equal(components.length, 1);
  assert.equal(diagnostics.ungroupedPixelCount, 228);
  assert.equal(diagnostics.ungroupedComponentCount, 228);
  assert.match(diagnostics.warnings[0], /未生成独立素材/);
  assert.equal(source.data[(40 * source.width + 40) * 4 + 3], 1, 'the original pixels remain recoverable');
});

test('a frame crop excludes a foreign asset inside its hollow rectangle', () => {
  const source = image(60, 60);
  source.fill(10, 10, 36, 2, white);
  source.fill(10, 44, 36, 2, white);
  source.fill(10, 10, 2, 36, white);
  source.fill(44, 10, 2, 36, white);
  source.fill(13, 24, 2, 2, [255, 0, 100, 255]);
  const slices = split(source);
  assert.equal(slices.length, 2);
  const frame = slices.find((slice) => slice.rect.w === 36);
  assert.equal(frame.rgba[((24 - frame.rect.y) * frame.rect.w + 13 - frame.rect.x) * 4 + 3], 0);
  assertPixelOwnership(source, slices);
});

test('nearby independent bodies do not merge merely because their boxes are close', () => {
  const source = image(70, 45);
  source.fill(10, 10, 20, 20, white);
  source.fill(31, 10, 20, 20, [40, 160, 255, 255]);
  const slices = split(source);
  assert.equal(slices.length, 2);
  assert.deepEqual(slices.map((slice) => slice.rect.w), [20, 20]);
  assertPixelOwnership(source, slices);
});

test('attached details cannot form a chain that attracts additional fragments', () => {
  const source = image(60, 45);
  source.fill(10, 10, 20, 20, white);
  source.set(31, 15, white);
  source.set(33, 15, [200, 20, 220, 255]);
  const slices = split(source);
  assert.equal(slices.length, 2);
  assert.equal(slices.find((slice) => slice.rect.x === 10).componentCount, 2);
  assert.equal(slices.find((slice) => slice.rect.x === 33).pixelCount, 1);
  assertPixelOwnership(source, slices);
});

test('a small component between two possible bodies remains independently reviewable', () => {
  const source = image(40, 30);
  source.fill(5, 5, 10, 10, white);
  source.fill(19, 5, 10, 10, white);
  source.set(16, 9, [255, 0, 200, 255]);
  const slices = split(source);
  assert.equal(slices.length, 3);
  assertPixelOwnership(source, slices);
});

test('native 252/253 opacity and alpha 1..8 feather pixels survive without binarization', () => {
  const source = image(30, 30);
  source.fill(7, 7, 8, 8, [200, 150, 90, 252]);
  source.fill(8, 8, 6, 6, [200, 150, 90, 253]);
  source.fill(6, 6, 1, 10, [140, 180, 200, 4]);
  source.set(5, 7, [140, 180, 200, 1]);
  const slices = split(source);
  assert.equal(slices.length, 1);
  assert.equal(slices[0].rect.x, 5);
  assertPixelOwnership(source, slices);
});

test('touching faint shadows do not join two opaque component bodies', () => {
  const source = image(40, 30);
  source.fill(5, 5, 10, 10, white);
  source.fill(20, 5, 10, 10, [40, 160, 255, 255]);
  source.fill(15, 9, 5, 1, [180, 160, 200, 1]);
  const slices = split(source);
  assert.equal(slices.length, 2);
  assertPixelOwnership(source, slices);
});

for (const bridgeAlpha of [9, 16, 32, 64]) {
  test(`an alpha-${bridgeAlpha} shadow bridge does not become an opaque body connection`, () => {
    const source = image(40, 30);
    source.fill(5, 5, 10, 10, white);
    source.fill(20, 5, 10, 10, [40, 160, 255, 255]);
    source.fill(15, 9, 5, 1, [180, 160, 200, bridgeAlpha]);
    const { components, diagnostics } = analyzeAlphaSheetPixels(source.data, source.width, source.height);
    assert.equal(components.length, 2);
    assert.ok(diagnostics.warnings.some((warning) => warning.includes('共享半透明')));
    assertPixelOwnership(source, components);
  });
}

test('a continuous 31-pixel soft tail remains complete rather than being distance-clipped', () => {
  const source = image(70, 30);
  source.fill(5, 5, 10, 10, white);
  source.fill(15, 9, 31, 1, [180, 160, 200, 4]);
  const { components, diagnostics } = analyzeAlphaSheetPixels(source.data, source.width, source.height);
  assert.equal(components.length, 1);
  assert.equal(components[0].pixelCount, 131);
  assert.equal(components[0].rect.x + components[0].rect.w, 46);
  assert.equal(diagnostics.ungroupedPixelCount, 0);
  assertPixelOwnership(source, components);
});

test('a disconnected alpha-8 asset inside a frame retains all pixels and its own ownership', () => {
  const source = image(60, 60);
  source.fill(10, 10, 36, 2, white);
  source.fill(10, 44, 36, 2, white);
  source.fill(10, 10, 2, 36, white);
  source.fill(44, 10, 2, 36, white);
  source.fill(13, 24, 8, 8, [150, 120, 220, 8]);
  const { components, diagnostics } = analyzeAlphaSheetPixels(source.data, source.width, source.height);
  assert.equal(components.length, 2);
  const softAsset = components.find((component) => component.rect.w === 8);
  assert.ok(softAsset);
  assert.equal(softAsset.pixelCount, 64);
  assert.equal(diagnostics.ungroupedPixelCount, 0);
  const frame = components.find((component) => component.rect.w === 36);
  assert.equal(frame.rgba[((24 - frame.rect.y) * frame.rect.w + 13 - frame.rect.x) * 4 + 3], 0);
  assertPixelOwnership(source, components);
});

test('an independent uniformly translucent asset uses its own peak rather than the sheet peak', () => {
  const source = image(70, 40);
  source.fill(5, 5, 20, 20, white);
  source.fill(28, 8, 16, 16, [100, 160, 230, 32]);
  const components = split(source);
  assert.equal(components.length, 2);
  assert.equal(components.find((component) => component.rect.x === 28).pixelCount, 256);
  assertPixelOwnership(source, components);
});

test('opaque checkerboards and empty sheets fail explicitly', () => {
  const opaque = image(20, 20, [30, 40, 50, 255]);
  opaque.fill(5, 5, 10, 10, white);
  assert.throws(() => split(opaque), /没有真正透明/);
  assert.throws(() => split(image(20, 20)), /没有找到透明前景/);
});

test('keying preserves native alpha and RGB when the surroundings are transparent', () => {
  const source = image(9, 9, [230, 0, 220, 0]);
  source.fill(3, 3, 3, 3, [0, 0, 0, 255]);
  source.set(2, 4, [20, 40, 60, 64]);
  const rect = { x: 1, y: 1, w: 7, h: 7 };
  const keyed = keyElement(source, rect, keyOptions);
  assert.equal(alphaAt(keyed, 1, 3), 64);
  assert.equal(alphaAt(keyed, 2, 2), 255);
  assert.equal(alphaAt(keyed, 0, 0), 0);
  assert.deepEqual([...keyed.rgba.subarray((3 * 7 + 1) * 4, (3 * 7 + 1) * 4 + 4)], [20, 40, 60, 64]);
});

test('one opaque neighbour cannot poison an otherwise transparent native exterior', () => {
  const source = image(9, 9, [255, 0, 255, 0]);
  source.fill(3, 3, 3, 3, [0, 0, 0, 255]);
  source.set(1, 4, [0, 0, 0, 255]);
  const keyed = keyElement(source, { x: 2, y: 2, w: 5, h: 5 }, keyOptions);
  let alphaSum = 0;
  for (let offset = 3; offset < keyed.rgba.length; offset += 4) alphaSum += keyed.rgba[offset];
  assert.equal(alphaSum, 9 * 255);
});

test('hidden transparent RGB does not bias the sampled key colour', () => {
  const source = image(10, 10, [255, 0, 255, 0]);
  source.set(3, 2, [25, 60, 90, 255]);
  assert.deepEqual(sampleBackgroundColor(source, { x: 3, y: 3, w: 4, h: 4 }), [25, 60, 90]);
});

test('a translucent native halo is not mistaken for an opaque painted background', () => {
  const source = image(9, 9, [255, 0, 255, 0]);
  source.fill(1, 1, 7, 7, [0, 0, 0, 48]);
  source.fill(3, 3, 3, 3, [0, 0, 0, 255]);
  const keyed = keyElement(source, { x: 2, y: 2, w: 5, h: 5 }, keyOptions);
  assert.equal(alphaAt(keyed, 0, 0), 48);
  assert.equal(alphaAt(keyed, 2, 2), 255);
});

test('source alpha is multiplied by key opacity instead of replaced by it', () => {
  const source = image(5, 5, [0, 0, 0, 255]);
  source.set(2, 2, [80, 80, 80, 128]);
  const keyed = keyElement(source, { x: 0, y: 0, w: 5, h: 5 }, { ...keyOptions, fringeFix: false });
  assert.ok(alphaAt(keyed, 2, 2) > 0);
  assert.ok(alphaAt(keyed, 2, 2) < 128, 'colour-key feathering can only reduce source alpha');
});

test('transparent pixels allow flood fill regardless of their hidden RGB', () => {
  const background = [20, 40, 60, 255];
  const source = image(7, 7, background);
  source.fill(1, 1, 5, 5, [240, 150, 30, 255]);
  source.fill(2, 2, 3, 3, background);
  source.set(3, 0, [255, 0, 255, 0]);
  source.set(3, 1, [255, 0, 255, 0]);
  const keyed = keyElement(source, { x: 0, y: 0, w: 7, h: 7 }, keyOptions);
  assert.equal(alphaAt(keyed, 3, 3), 0);
  assert.equal(alphaAt(keyed, 1, 3), 255);
});

test('fringe correction does not recolour an existing native semi-transparent foreground', () => {
  const source = image(7, 7, [0, 0, 0, 255]);
  source.set(3, 3, [255, 180, 80, 128]);
  source.set(4, 3, [80, 255, 120, 255]);
  const keyed = keyElement(source, { x: 0, y: 0, w: 7, h: 7 }, keyOptions);
  const offset = (3 * 7 + 3) * 4;
  assert.deepEqual([...keyed.rgba.subarray(offset, offset + 4)], [255, 180, 80, 128]);
});

test('fringe correction preserves native RGB even when colour-key opacity is reduced', () => {
  const source = image(7, 7, [0, 0, 0, 255]);
  source.set(3, 3, [80, 80, 80, 128]);
  source.set(4, 3, [250, 40, 40, 255]);
  const keyed = keyElement(source, { x: 0, y: 0, w: 7, h: 7 }, keyOptions);
  const offset = (3 * 7 + 3) * 4;
  assert.deepEqual([...keyed.rgba.subarray(offset, offset + 3)], [80, 80, 80]);
  assert.ok(keyed.rgba[offset + 3] > 0 && keyed.rgba[offset + 3] < 128);
});
