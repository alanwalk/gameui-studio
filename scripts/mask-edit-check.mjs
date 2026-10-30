import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { browserLaunchOptions } from './browser-options.mjs';

const built = await build({ entryPoints: ['src/lib/maskEdit.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { MaskHistory } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const original = { width: 8, height: 6, data: new Uint8ClampedArray(8 * 6 * 4) };
for (let index = 0; index < original.data.length; index += 4) original.data.set([91, 137, 203, 128], index);
const alpha = (pixels, x, y) => pixels[(y * 8 + x) * 4 + 3];
const point = { x: 2.5, y: 2.5 };
const stroke = (history, from, to = from, mode = 'erase', radius = 0.6) => {
  history.beginStroke(); history.paint(from, to, radius, mode); history.endStroke();
};
check('erase alters alpha only and leaves original and pre-stroke snapshot untouched', () => {
  const pixels = original.data.slice();
  const history = new MaskHistory(original);
  const before = history.current;
  stroke(history, point);
  assert.equal(alpha(history.current, 2, 2), 0);
  assert.equal(alpha(history.current, 1, 2), 128);
  assert.deepEqual(history.current.slice((2 * 8 + 2) * 4, (2 * 8 + 2) * 4 + 3), new Uint8ClampedArray([91, 137, 203]));
  assert.deepEqual(original.data, pixels);
  assert.deepEqual(before, pixels);
  assert.equal(history.canUndo, true);
});
check('one continuous stroke has no gaps, is one undo, and redo is exact', () => {
  const history = new MaskHistory(original);
  stroke(history, { x: 0.5, y: 3.5 }, { x: 7.5, y: 3.5 });
  for (let x = 0; x < 8; x++) assert.equal(alpha(history.current, x, 3), 0);
  const erased = history.current.slice();
  history.undo(); assert.deepEqual(history.current, original.data); assert.equal(history.canUndo, false);
  history.redo(); assert.deepEqual(history.current, erased);
});
check('restore recovers the original semi-transparent RGBA and supports undo/redo', () => {
  const history = new MaskHistory(original);
  stroke(history, point);
  const erased = history.current.slice();
  stroke(history, point, point, 'restore');
  assert.deepEqual(history.current, original.data);
  history.undo(); assert.deepEqual(history.current, erased);
  history.redo(); assert.deepEqual(history.current, original.data);
});
check('editing after undo drops redo without changing a retained snapshot', () => {
  const history = new MaskHistory(original);
  stroke(history, point);
  history.undo();
  const retained = history.current;
  stroke(history, { x: 5.5, y: 1.5 });
  assert.equal(history.canRedo, false);
  assert.deepEqual(retained, original.data);
  assert.equal(alpha(history.current, 2, 2), 128);
  assert.equal(alpha(history.current, 5, 1), 0);
});
check('out-of-bounds and invalid brushes create no history; image edges are clipped', () => {
  const history = new MaskHistory(original);
  stroke(history, { x: -20, y: -20 });
  history.paint(point, point, NaN, 'erase'); history.endStroke();
  assert.equal(history.canUndo, false);
  stroke(history, { x: 0, y: 0 }, { x: 0, y: 0 }, 'erase', 1);
  assert.equal(alpha(history.current, 0, 0), 0);
  assert.equal(alpha(history.current, 7, 5), 128);
});
check('restore never manufactures opacity in originally transparent pixels', () => {
  const transparent = new MaskHistory({ width: 1, height: 1, data: new Uint8ClampedArray([12, 34, 56, 0]) });
  stroke(transparent, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 'restore', 1);
  assert.deepEqual(transparent.current, new Uint8ClampedArray([12, 34, 56, 0]));
  assert.equal(transparent.canUndo, false);
});
check('ImageData-style prototype dimensions are retained when copying pixels', () => {
  const image = Object.create({ get width() { return 8; }, get height() { return 6; } });
  image.data = original.data.slice();
  const history = new MaskHistory(image);
  stroke(history, point);
  assert.equal(history.original.width, 8);
  assert.equal(history.original.height, 6);
  assert.equal(alpha(history.current, 2, 2), 0);
  history.undo(); assert.deepEqual(history.current, original.data);
});
console.log(`${passed} pixel/history behavior checks passed`);

if (process.argv.includes('--browser')) {
  const moduleName = process.env.MASK_EDIT_PLAYWRIGHT;
  const playwright = await import(moduleName ? pathToFileURL(moduleName).href : 'playwright');
  const browser = await playwright.chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://localhost/**', (route) => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
    await page.goto('http://localhost/');
    await page.addStyleTag({ content: await readFile('src/styles.css', 'utf8') });
    const fixture = await build({
      stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { SlicePreview } from './src/components/SlicePreview';
        const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 12;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(91,137,203,0.5)'; ctx.fillRect(0,0,16,12);
        const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = 32; sourceCanvas.height = 32;
        const sourceCtx = sourceCanvas.getContext('2d'); sourceCtx.fillStyle = '#000'; sourceCtx.fillRect(0,0,32,32);
        sourceCtx.fillStyle = '#ff0000'; sourceCtx.fillRect(8,8,16,16);
        const source = { dataUrl: sourceCanvas.toDataURL(), width: 32, height: 32 };
        const settings = { module: 'Common', tolerance: 0.1, softness: 0, hardEdge: true, fringeFix: false };
        const element = { id: 'first', label: 'First', objectName: 'First', state: '', kind: 'icon', rect: {x:0,y:0,w:16,h:12}, description: '', layer: 0, occluded: false, needsAi: false, approved: true, slice: {width:16,height:12,canvas,border:{dirtySides:[],bgColor:[0,0,0],sideScore:{top:0,right:0,bottom:0,left:0}}} };
        window.originalCanvas = canvas; window.snapshots = []; window.latestElements = [element];
        function Fixture() {
          const [elements, setElements] = useState([element]); const [busy,setBusy] = useState(false); const [withSource,setWithSource] = useState(false);
          window.setBusy = setBusy; window.setWithSource = setWithSource;
          const onChangeElements = (next) => {
            window.latestElements = next; window.snapshots.push(next);
            setTimeout(() => setElements(next), 30);
          };
          return <SlicePreview elements={elements} busy={busy} onToggle={() => {}} onChangeElements={onChangeElements} source={withSource ? source : undefined} settings={settings} />;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);
      ` }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' },
    });
    await page.addScriptTag({ content: fixture.outputFiles[0].text });
    await page.getByRole('button', { name: '预览 First', exact: true }).click();
    await page.getByRole('button', { name: '编辑蒙版', exact: true }).click();
    await page.getByLabel('缩放', { exact: true }).selectOption('4');
    await page.getByRole('slider').fill('1');
    const brush = async (x, y) => {
      const bounds = await page.locator('.mask-edit-canvas').boundingBox();
      await page.mouse.move(bounds.x + x * bounds.width / 16, bounds.y + y * bounds.height / 12);
      await page.mouse.down(); await page.mouse.up();
    };
    const savedAlpha = (x, y) => page.evaluate(({ x, y }) => window.latestElements[0].slice.canvas.getContext('2d').getImageData(x,y,1,1).data[3], { x, y });
    await brush(3.5, 3.5);
    await page.getByRole('button', { name: '保存蒙版', exact: true }).click();
    await page.waitForFunction(() => window.snapshots.length === 1);
    assert.equal(await savedAlpha(3,3), 0);
    assert.equal(await page.evaluate(() => window.originalCanvas.getContext('2d').getImageData(3,3,1,1).data[3]), 128);
    assert.equal(await page.evaluate(() => window.originalCanvas !== window.latestElements[0].slice.canvas), true);
    await brush(9.5, 7.5);
    await page.getByRole('button', { name: '保存蒙版', exact: true }).click();
    await page.waitForFunction(() => window.snapshots.length === 2);
    // Let both asynchronous parent echoes arrive before exercising retained history.
    await page.waitForFunction(() => document.querySelector('.slice-preview-image img').src === window.latestElements[0].slice.canvas.toDataURL());
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByRole('button', { name: '保存蒙版', exact: true }).click();
    assert.equal(await savedAlpha(9,7), 128); assert.equal(await savedAlpha(3,3), 0);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await page.getByRole('button', { name: '保存蒙版', exact: true }).click();
    assert.equal(await savedAlpha(9,7), 0);
    assert.equal(await page.evaluate(() => new Set(window.snapshots.map((list) => list[0].slice.canvas)).size === window.snapshots.length), true);
    console.log('PASS browser: immutable canvas saves, original intact, undo/redo survive async parent echoes');
    await page.getByLabel('笔刷', { exact: true }).selectOption('restore');
    await brush(3.5, 3.5);
    await page.getByRole('button', { name: '保存蒙版', exact: true }).click();
    assert.equal(await savedAlpha(3,3), 128);
    await page.evaluate(() => window.setBusy(true));
    await page.waitForFunction(() => document.querySelector('.mask-editor fieldset').disabled);
    assert.equal(await page.getByRole('button', { name: '保存蒙版', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: '预览 First', exact: true }).evaluate((button) => document.activeElement === button), true);
    console.log('PASS browser: restore semi-transparent pixels, busy disables mutations, Escape restores focus without source');
    await page.evaluate(() => { window.setBusy(false); window.setWithSource(true); });
    await page.getByRole('button', { name: '新增矩形素材', exact: true }).click();
    const fields = page.locator('.slice-edit-fields').last();
    const sourceBounds = await page.locator('.slice-source-box').boundingBox();
    await page.getByLabel('原图交互', { exact: true }).selectOption('keep');
    await page.mouse.click(sourceBounds.x + sourceBounds.width / 4, sourceBounds.y + sourceBounds.height / 4);
    await page.getByLabel('原图交互', { exact: true }).selectOption('exclude');
    await page.mouse.click(sourceBounds.x + sourceBounds.width * 3 / 4, sourceBounds.y + sourceBounds.height * 3 / 4);
    const markers = page.locator('.slice-source-box svg circle');
    assert.equal(await markers.count(), 2);
    assert.equal(await markers.nth(0).getAttribute('cx'), '8');
    assert.equal(await markers.nth(1).getAttribute('cy'), '24');
    assert.deepEqual(await page.locator('.slice-source-box svg text').allTextContents(), ['+', '−']);
    await page.getByRole('button', { name: '清除提示点', exact: true }).click();
    assert.equal(await markers.count(), 0);
    await page.getByLabel('原图交互', { exact: true }).selectOption('box');
    console.log('PASS browser: original-pixel positive/negative prompt overlays and clear');
    await page.mouse.move(sourceBounds.x + sourceBounds.width / 4, sourceBounds.y + sourceBounds.height / 4);
    await page.mouse.down();
    await page.mouse.move(sourceBounds.x + sourceBounds.width * 3 / 4, sourceBounds.y + sourceBounds.height * 3 / 4);
    await page.mouse.up();
    assert.equal(await fields.getByLabel('x', { exact: true }).inputValue(), '8');
    assert.equal(await fields.getByLabel('w', { exact: true }).inputValue(), '16');
    for (const [field, value] of Object.entries({ x: '8', y: '8', w: '16', h: '16' })) await fields.getByLabel(field, { exact: true }).fill(value);
    await page.getByRole('button', { name: '按此框从原图色键提取', exact: true }).click();
    await page.waitForFunction(() => window.latestElements.length === 2);
    assert.equal(await page.evaluate(() => window.latestElements[1].extractionMethod), 'color-key');
    assert.equal(await page.evaluate(() => window.latestElements[1].approved), false, 'new extraction requires human review');
    assert.deepEqual(await page.evaluate(() => window.latestElements[1].rect), {x:8,y:8,w:16,h:16});
    assert.equal(await page.evaluate(() => window.latestElements[1].slice.canvas.getContext('2d').getImageData(8,8,1,1).data[3]), 255);
    console.log('PASS browser: pointer-drawn rectangle extracts actual source pixels with color-key provenance');
    await page.getByRole('button', { name: '保存名称', exact: true }).waitFor();
    await page.getByLabel('对象名', { exact: true }).fill('ManualRenamed');
    await page.getByRole('button', { name: '保存名称', exact: true }).click();
    await page.waitForFunction(() => window.latestElements[1].objectName === 'ManualRenamed' && document.querySelectorAll('.slice-preview-card label')[1].textContent.includes('ManualRenamed'));
    // Controlled props echo asynchronously in this fixture; assert after that echo.
    assert.equal(await page.getByLabel('审核通过', { exact: true }).isChecked(), false);
    await page.getByLabel('审核通过', { exact: true }).click();
    await page.waitForFunction(() => window.latestElements[1].approved === true && document.querySelectorAll('.slice-preview-card input')[1].checked);
    await page.getByLabel('审核通过', { exact: true }).click();
    await page.waitForFunction(() => window.latestElements[1].approved === false && !document.querySelectorAll('.slice-preview-card input')[1].checked);
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: '下载这张 PNG', exact: true }).click();
    assert.equal((await downloadEvent).suggestedFilename(), 'T_UI_Common_ManualRenamed.png');
    await page.getByText('坐标与重切', { exact: true }).click();
    await fields.getByLabel('w', { exact: true }).fill('100');
    const saveCount = await page.evaluate(() => window.snapshots.length);
    await page.getByRole('button', { name: '按此框从原图色键提取', exact: true }).click();
    assert.match(await page.getByRole('alert').textContent(), /原图范围/);
    assert.equal(await page.evaluate(() => window.snapshots.length), saveCount);
    await fields.getByLabel('w', { exact: true }).fill('8');
    await page.getByRole('button', { name: '按此框从原图色键提取', exact: true }).click();
    await page.waitForFunction(() => window.latestElements[1].slice.width === 8);
    assert.equal(await page.evaluate(() => window.snapshots.at(-1)[1].slice.canvas !== window.snapshots.at(-2)[1].slice.canvas), true);
    assert.equal(await page.evaluate(() => window.latestElements[1].extractionMethod), 'color-key');
    await page.getByRole('button', { name: '删除素材', exact: true }).click();
    await page.waitForFunction(() => window.latestElements.length === 1);
    console.log('PASS browser: rename, approval, PNG filename, invalid-rect rejection, immutable single recut and deletion');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
