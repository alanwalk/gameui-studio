// Pure-logic smoke test: naming, occlusion and coverage need no DOM, so these run
// headless and guard the parts that silently corrupt output if they regress.
import assert from 'node:assert/strict';
import { buildFileName, dedupeName, deriveName, safeModuleName } from '../src/lib/naming.ts';
import { auditCoverage } from '../src/lib/coverage.ts';
import { markOcclusion, suggestNineSlice } from '../src/lib/geometry.ts';
import { keyElement, refineRect, scoreRect } from '../src/lib/key.ts';
import { collectContent, extractPendingId } from '../src/lib/mcpReply.ts';
import { buildReskinPlan, buildReskinPrompt, assertSizeKept } from '../src/lib/reskin.ts';
import { findMatchingStyle } from '../src/lib/styles.ts';

/** Builds a synthetic UI in the shape keyElement expects, so the keyer can run headless. */
function makeImage(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) set(x, y, [0, 0, 0]);
  }
  paint({ set, width, height });
  return { width, height, data };
}

const alphaAt = (keyed, x, y) => keyed.rgba[(y * keyed.width + x) * 4 + 3];

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
}

console.log('naming');

check('collapses synonyms to one word root', () => {
  const a = deriveName('bg panel', 'panel');
  const b = deriveName('background panel', 'panel');
  assert.equal(a.objectName, b.objectName, 'Bg and Background must map to the same root');
  assert.equal(a.objectName, 'BackgroundPanel');
});

check('splits trailing state off the object name', () => {
  const normal = deriveName('Confirm Button', 'button');
  const pressed = deriveName('Confirm Button Pressed', 'button');
  assert.equal(normal.objectName, pressed.objectName, 'object must stay stable across states');
  assert.equal(normal.state, '');
  assert.equal(pressed.state, 'Pressed');
});

check('keeps state-like words that are part of the object', () => {
  const tab = deriveName('Selected Tab', 'button');
  assert.equal(tab.objectName, 'SelectedTab', 'SelectedTab is an object, not a state');
  assert.equal(tab.state, '');
});

check('drops revision words that UI forbids', () => {
  const result = deriveName('new final button copy', 'button');
  assert.equal(result.objectName, 'Button');
});

check('falls back to kind when the label is empty', () => {
  assert.equal(deriveName('', 'icon').objectName, 'Icon');
  assert.equal(deriveName('   ', 'progress').objectName, 'Progress');
});

check('builds the UI filename shape', () => {
  assert.equal(buildFileName('Login', 'ConfirmButton', 'Pressed'), 'T_UI_Login_ConfirmButton_Pressed.png');
  assert.equal(buildFileName('Common', 'Tab', ''), 'T_UI_Common_Tab.png');
});

check('never silently overwrites a look-alike asset', () => {
  const taken = new Set(['T_UI_Common_Button.png']);
  assert.equal(dedupeName('T_UI_Common_Button.png', taken), 'T_UI_Common_Button_02.png');
});

check('sanitizes the module segment', () => {
  assert.equal(safeModuleName('login'), 'Login');
  assert.equal(safeModuleName('  '), 'Common');
  assert.equal(safeModuleName('test module'), 'Module');
});

console.log('geometry');

check('marks only the element that is actually covered', () => {
  const panel = { label: 'Panel', kind: 'panel', rect: { x: 0, y: 0, w: 400, h: 300 }, layer: 0, description: '' };
  const button = { label: 'Button', kind: 'button', rect: { x: 40, y: 40, w: 100, h: 50 }, layer: 1, description: '' };
  const icon = { label: 'Icon', kind: 'icon', rect: { x: 300, y: 250, w: 20, h: 20 }, layer: 1, description: '' };

  const result = markOcclusion([panel, button, icon]);
  const byLabel = Object.fromEntries(result.map((r) => [r.element.label, r]));

  assert.equal(byLabel.Panel.occluded, true, 'panel is under the button');
  assert.equal(byLabel.Button.occluded, false, 'button is topmost');
  assert.equal(byLabel.Icon.occluded, false, 'icon is topmost');
  // Both sit on the panel, so both bake a mark into it and both must be listed.
  assert.deepEqual(byLabel.Panel.coveredBy, ['Button', 'Icon']);
});

check('does not treat a small button on a huge panel as noise', () => {
  // A 100x50 button is only 4% of this panel, but it still leaves a real hole.
  const panel = { label: 'Panel', kind: 'panel', rect: { x: 0, y: 0, w: 1000, h: 800 }, layer: 0, description: '' };
  const button = { label: 'Button', kind: 'button', rect: { x: 10, y: 10, w: 100, h: 50 }, layer: 1, description: '' };
  const result = markOcclusion([panel, button]);
  assert.equal(result[0].occluded, true);
});

check('ignores bbox jitter below the noise floor', () => {
  const panel = { label: 'Panel', kind: 'panel', rect: { x: 0, y: 0, w: 400, h: 300 }, layer: 0, description: '' };
  // A 3px sliver is coordinate noise, not an asset sitting on top.
  const sliver = { label: 'Sliver', kind: 'icon', rect: { x: 398, y: 0, w: 5, h: 20 }, layer: 1, description: '' };
  const result = markOcclusion([panel, sliver]);
  assert.equal(result[0].occluded, false, 'a few overlapping pixels must not trigger a repaint');
});

check('ignores overlap between elements on the same layer', () => {
  const a = { label: 'A', kind: 'icon', rect: { x: 0, y: 0, w: 50, h: 50 }, layer: 2, description: '' };
  const b = { label: 'B', kind: 'icon', rect: { x: 25, y: 25, w: 50, h: 50 }, layer: 2, description: '' };
  const result = markOcclusion([a, b]);
  assert.equal(result.every((r) => !r.occluded), true, 'siblings do not occlude each other');
});

check('does not suggest nine-slice for small or square art', () => {
  const base = { id: 'a', kind: 'panel', rect: { x: 0, y: 0, w: 20, h: 20 }, objectName: 'P', state: '', layer: 0, occluded: false, needsAi: false, approved: true, label: 'P', description: '' };
  assert.equal(suggestNineSlice(base, true).suggested, false);

  const square = { ...base, rect: { x: 0, y: 0, w: 100, h: 100 } };
  assert.equal(suggestNineSlice(square, true).suggested, false, 'square art need not stretch');
});

check('suggests nine-slice for a wide clean-edged panel', () => {
  const panel = { id: 'a', kind: 'panel', rect: { x: 0, y: 0, w: 400, h: 100 }, objectName: 'P', state: '', layer: 0, occluded: false, needsAi: false, approved: true, label: 'P', description: '' };
  const nine = suggestNineSlice(panel, true);
  assert.equal(nine.suggested, true);
  assert.equal(nine.border.left, 25, '25% of the 100px short edge');
});

check('refuses nine-slice when the edge has content', () => {
  const panel = { id: 'a', kind: 'panel', rect: { x: 0, y: 0, w: 400, h: 100 }, objectName: 'P', state: '', layer: 0, occluded: false, needsAi: false, approved: true, label: 'P', description: '' };
  assert.equal(suggestNineSlice(panel, false).suggested, false, 'slicing would cut through art');
});

console.log('keying');

const BG = [32, 48, 58];
const PANEL = [216, 162, 74];
const BUTTON = [90, 200, 255];

const keyOptions = { tolerance: 12, softness: 8, hardEdge: false, fringeFix: true };

check('turns flat background fully transparent', () => {
  const image = makeImage(400, 300, ({ set, width, height }) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, BG);
    }
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 340; x++) set(x + 30, y + 30, PANEL);
    }
  });

  const keyed = keyElement(image, { x: 30, y: 30, w: 340, h: 240 }, keyOptions);
  assert.equal(alphaAt(keyed, 5, 5), 255, 'panel interior stays opaque');
  assert.equal(keyed.width, 340);
  assert.equal(keyed.height, 240);
});

check('keys out the background outside the element box', () => {
  const image = makeImage(400, 300, ({ set, width, height }) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, BG);
    }
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 340; x++) set(x + 30, y + 30, PANEL);
    }
  });

  // Box deliberately overshoots the panel so the surrounding background must be removed.
  const keyed = keyElement(image, { x: 10, y: 10, w: 380, h: 280 }, keyOptions);
  assert.equal(alphaAt(keyed, 2, 2), 0, 'background corner is transparent');
  assert.equal(alphaAt(keyed, 40, 40), 255, 'panel is kept');
});

check('keeps an interior element that matches the key colour', () => {
  const image = makeImage(400, 300, ({ set, width, height }) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, BG);
    }
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 340; x++) set(x + 30, y + 30, PANEL);
    }
    // A shape INSIDE the panel painted with the same colour as the page background.
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 40; x++) set(x + 160, y + 130, BG);
    }
  });

  const keyed = keyElement(image, { x: 30, y: 30, w: 340, h: 240 }, keyOptions);
  // Only background CONNECTED to the border is keyed out. Punching a hole through the
  // panel here would destroy real art, so an enclosed region must survive.
  assert.equal(alphaAt(keyed, 175, 145), 255, 'an enclosed region is panel art, not background');
  assert.equal(alphaAt(keyed, 5, 5), 255, 'the panel around it survives');
});

check('hard edge removes every semi-transparent pixel', () => {
  const image = makeImage(100, 100, ({ set, width, height }) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, BG);
    }
    for (let y = 0; y < 50; y++) {
      for (let x = 0; x < 50; x++) set(x + 25, y + 25, PANEL);
    }
  });

  const keyed = keyElement(image, { x: 25, y: 25, w: 50, h: 50 }, {
    ...keyOptions,
    hardEdge: true,
  });
  for (let i = 3; i < keyed.rgba.length; i += 4) {
    assert.ok(keyed.rgba[i] === 0 || keyed.rgba[i] === 255, 'no feathered pixels in hard-edge mode');
  }
});

check('clamps a box that runs off the image', () => {
  const image = makeImage(100, 100, ({ set, width, height }) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, BG);
    }
  });
  const keyed = keyElement(image, { x: 60, y: 60, w: 200, h: 200 }, keyOptions);
  assert.equal(keyed.width, 40, 'width is clamped to the image edge');
  assert.equal(keyed.height, 40);
});

console.log('scoring');

const panelImage = () =>
  makeImage(400, 300, ({ set, width, height }) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, BG);
    }
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 340; x++) set(x + 30, y + 30, PANEL);
    }
  });

check('sees all four edges as real boundaries when the box is exact', () => {
  // Box matches the panel exactly, so every edge separates panel from page background.
  const report = scoreRect(panelImage(), { x: 30, y: 30, w: 340, h: 240 }, 3);
  assert.equal(report.dirtySides.length, 0, 'all four edges sit on the panel boundary');
  assert.ok(report.sideScore.top > 0.1, 'the top edge has real contrast');
});

check('flags edges that float inside flat art instead of on a boundary', () => {
  // Box sits entirely inside the flat panel: its edges separate panel from panel,
  // so there is no boundary there and every side is reported as not-landed.
  const report = scoreRect(panelImage(), { x: 60, y: 60, w: 200, h: 100 }, 3);
  assert.equal(report.dirtySides.length, 4, 'no edge sits on real art');
});

check('flags only the overshooting sides', () => {
  // Box starts 10px too high and too far left, so top/left float on page background
  // well outside the panel, while bottom/right still land on the panel edge.
  const report = scoreRect(panelImage(), { x: 14, y: 14, w: 356, h: 256 }, 3);
  assert.ok(report.dirtySides.includes('top'), 'top overshot the panel');
  assert.ok(report.dirtySides.includes('left'), 'left overshot the panel');
  assert.ok(!report.dirtySides.includes('bottom'), 'bottom still lands on the panel edge');
  assert.ok(!report.dirtySides.includes('right'), 'right still lands on the panel edge');
});

check('refineRect pulls a sloppy box onto the real panel edge', () => {
  const image = panelImage();
  // Vision model under-shot the panel by 8px on every side.
  const sloppy = { x: 38, y: 38, w: 324, h: 224 };
  const before = scoreRect(image, sloppy, 3);
  const refined = refineRect(image, sloppy);
  const after = scoreRect(image, refined.rect, 3);

  assert.ok(
    after.dirtySides.length < before.dirtySides.length,
    `refinement must land more edges: ${before.dirtySides.length} -> ${after.dirtySides.length}`,
  );
  assert.equal(after.dirtySides.length, 0, 'the refined box matches the panel');
});

check('refineRect recovers a box that overshot the panel', () => {
  const image = panelImage();
  const overshot = { x: 14, y: 14, w: 356, h: 256 };
  const refined = refineRect(image, overshot);
  const after = scoreRect(image, refined.rect, 3);
  assert.ok(
    after.dirtySides.length <= 1,
    `overshoot should be corrected, got ${after.dirtySides.length} dirty sides`,
  );
});

check('refineRect leaves an already-correct box alone', () => {
  const image = panelImage();
  const exact = { x: 30, y: 30, w: 340, h: 240 };
  const refined = refineRect(image, exact);
  assert.ok(Math.abs(refined.rect.x - exact.x) <= 10, 'must not drift far from a good box');
  assert.ok(Math.abs(refined.rect.w - exact.w) <= 20, 'and must not wildly resize it');
});

check('refineRect grows a tight box until the edges go quiet', () => {
  const image = makeImage(400, 300, ({ set, width, height }) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) set(x, y, BG);
    }
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 340; x++) set(x + 30, y + 30, PANEL);
    }
  });
  // Model under-shot the panel by 10px on every side.
  const tight = { x: 40, y: 40, w: 320, h: 220 };
  const refined = refineRect(image, tight);
  const after = scoreRect(image, refined.rect, 3);
  const before = scoreRect(image, tight, 3);
  assert.ok(
    after.dirtySides.length <= before.dirtySides.length,
    'refinement must not make the box worse',
  );
  assert.ok(refined.rect.w >= tight.w, 'it grows rather than crops the art');
});

console.log('coverage');

const makeElement = (rect, approved = true, kind = 'button') => ({
  id: `e${Math.random()}`, rect, kind, label: 'E', objectName: 'E', state: '', layer: 0,
  occluded: false, needsAi: false, approved, description: '',
});

check('reports full coverage when boxes tile the image', () => {
  const boxes = [];
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 4; y++) {
      boxes.push(makeElement({ x: x * 100, y: y * 100, w: 100, h: 100 }));
    }
  }
  const report = auditCoverage(boxes, 400, 400);
  assert.equal(report.uncoveredRatio, 0, 'tiled boxes leave nothing uncovered');
  assert.equal(report.holes.length, 0);
});

check('flags a missing element as a large uncovered hole', () => {
  const boxes = [makeElement({ x: 0, y: 0, w: 200, h: 400 })];
  const report = auditCoverage(boxes, 400, 400);
  assert.ok(report.uncoveredRatio > 0.4, 'right half is uncovered');
  assert.ok(report.largestHole > 0, 'the hole is reported');
});

check('excludes skipped elements from coverage', () => {
  const boxes = [
    makeElement({ x: 0, y: 0, w: 200, h: 400 }, true),
    makeElement({ x: 200, y: 0, w: 200, h: 400 }, false),
  ];
  const report = auditCoverage(boxes, 400, 400);
  assert.ok(report.uncoveredRatio > 0.4, 'a skipped element still counts as uncovered');
});

check('treats decor as background that may legitimately stay uncovered', () => {
  const boxes = [
    makeElement({ x: 0, y: 0, w: 200, h: 400 }, true, 'button'),
    makeElement({ x: 200, y: 0, w: 200, h: 400 }, true, 'decor'),
  ];
  const report = auditCoverage(boxes, 400, 400);
  assert.equal(report.uncoveredRatio, 0, 'decor covers it');
  assert.ok(report.uncoveredRatioNoBg > 0.4, 'but the no-background view still flags it');
});

console.log('\nmcp replies');

check('reads the saved file out of the prose', () => {
  const asset = collectContent({
    content: [{ type: 'text', text: 'Saved the image to C:\\temp\\out\\screen.png for you.' }],
  });
  assert.equal(asset.path, 'C:\\temp\\out\\screen.png');
  assert.equal(asset.pendingId, undefined, 'a finished file is not pending work');
});

check('takes the id from the quoted "wait" answer', () => {
  const asset = collectContent({
    content: [{ type: 'text', text: 'Still working: wait for it with id "abc-123-def".' }],
  });
  assert.equal(asset.pendingId, 'abc-123-def');
  assert.equal(asset.path, undefined);
});

check('does not mistake a folder name for an id', () => {
  // The old loose matcher grabbed `generated-images` here and then polled nonsense.
  const asset = collectContent({
    content: [{ type: 'text', text: 'Not ready yet; wait, it lands in generated-images/ later.' }],
  });
  assert.equal(asset.pendingId, undefined);
});

check('prefers the id over a bare long word', () => {
  assert.equal(extractPendingId('wait for id "gen-99" please'), 'gen-99');
  assert.equal(extractPendingId('wait, id gen-99 is running'), 'gen-99');
});

check('reports the tool failure instead of hiding it', () => {
  const asset = collectContent({
    isError: true,
    content: [{ type: 'text', text: 'no image: usage cap reached' }],
  });
  assert.equal(asset.isError, true, 'a quota error must not look like pending work');
  assert.equal(asset.pendingId, undefined);
});

check('inlines base64 when the tool returns bytes directly', () => {
  const asset = collectContent({ content: [{ type: 'image', data: 'AAAA' }] });
  assert.equal(asset.base64, 'AAAA');
});

console.log('\nreskin');

/** A minimal sliced element, enough for the plan to read its size and name. */
function makeSliced(name, state, w, h) {
  return {
    id: name,
    rect: { x: 0, y: 0, w, h },
    kind: 'button',
    label: name,
    description: 'a wooden confirm button',
    objectName: name,
    state,
    layer: 0,
    occluded: false,
    needsAi: false,
    approved: true,
    slice: { width: w, height: h, canvas: null, border: null },
  };
}

check('pins every redraw to the original pixel size', () => {
  const plan = buildReskinPlan([makeSliced('ConfirmButton', '', 120, 48)], 'ice theme');
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].width, 120);
  assert.equal(plan.items[0].height, 48);
});

check('keeps the file name stable across a reskin', () => {
  // A reskin that renames anything is not drop-in, so state must round-trip.
  const withState = buildReskinPlan([makeSliced('ConfirmButton', 'Pressed', 120, 48)], 'x');
  const plain = buildReskinPlan([makeSliced('ConfirmButton', '', 120, 48)], 'x');
  assert.equal(withState.items[0].fileName, 'ConfirmButton_Pressed.png');
  assert.equal(plain.items[0].fileName, 'ConfirmButton.png');
});

check('skips assets that were never sliced', () => {
  const unsliced = { ...makeSliced('Ghost', '', 10, 10), slice: undefined };
  const plan = buildReskinPlan([unsliced], 'x');
  assert.equal(plan.items.length, 0);
});

check('the prompt carries both the subject and the new style', () => {
  const plan = buildReskinPlan([makeSliced('CoinIcon', '', 32, 32)], '冰川题材，手绘厚涂');
  const prompt = buildReskinPrompt(plan.items[0], plan.stylePrompt);
  assert.ok(prompt.includes('CoinIcon'), 'names the asset');
  assert.ok(prompt.includes('冰川题材，手绘厚涂'), 'states the target style');
  assert.ok(prompt.includes('32x32'), 'states the required box');
});

check('flags a redraw that came back a different size', () => {
  const plan = buildReskinPlan([makeSliced('CoinIcon', '', 32, 32)], 'x');
  const wrong = assertSizeKept(plan, new Map([['CoinIcon.png', { w: 64, h: 64 }]]));
  assert.equal(wrong.length, 1, 'a resized asset must be reported, not accepted');
  const right = assertSizeKept(plan, new Map([['CoinIcon.png', { w: 32, h: 32 }]]));
  assert.equal(right.length, 0);
});

console.log('\nstyles');

const styleLibrary = [
  { id: 's1', name: 'Ice', prompt: 'ice theme', image: 'ice.png', createdAt: 0, updatedAt: 0 },
  { id: 's2', name: 'Forest', prompt: 'forest theme', createdAt: 0, updatedAt: 0 },
];

check('matches an applied style by prompt and reference image', () => {
  const matched = findMatchingStyle(styleLibrary, 'ice theme', 'ice.png');
  assert.equal(matched?.id, 's1');
});

check('does not claim a project is using a style after its prompt is edited', () => {
  assert.equal(findMatchingStyle(styleLibrary, 'ice theme plus glow', 'ice.png'), undefined);
});

check('treats a missing and an empty image as the same reference', () => {
  assert.equal(findMatchingStyle(styleLibrary, 'forest theme', undefined)?.id, 's2');
});

console.log(`\n${passed} checks passed`);
