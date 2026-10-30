import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Real App -> useSliceTasks -> SlicePanel/SlicerTool -> SlicePreview/MaskEditor.
// Only HTTP and Image.decode timing are controlled; no copied caller implementation.
const evidence = await fs.mkdtemp(path.resolve('.data/restoring-entry-'));
const argument = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const baseline = argument('--baseline');
const testCase = argument('--case') ?? 'all';
const playwrightPath = process.env.RESTORING_PLAYWRIGHT;
const playwright = await import(playwrightPath ? pathToFileURL(playwrightPath).href : 'playwright');
const built = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import App from './src/App';
    const root = createRoot(document.getElementById('root'));
    let epoch = 0;
    window.remount = () => root.render(<App key={epoch++} />);
    window.remount();
  ` },
  bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: baseline ? [{ name: 'baseline-callers', setup(builder) {
    builder.onLoad({ filter: /(?:App|SlicerTool|SlicePanel|SlicePreview|StudioStages)\.tsx$/ }, async ({ path: file }) => ({
      contents: await fs.readFile(path.join(baseline, `${path.basename(file)}.before`), 'utf8'), loader: 'tsx',
    }));
  } }] : [],
});
await fs.writeFile(path.join(evidence, 'app.js'), built.outputFiles[0].text);
const browser = await playwright.chromium.launch({ channel: 'msedge', headless: true });
let passed = 0;
try {
  for (const entry of ['project', 'standalone']) {
    for (const scenario of testCase === 'restore' ? ['restore'] : testCase === 'retry' ? ['retry'] : testCase === 'clear' ? ['clear'] : ['restore', 'retry']) {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(8000);
      const source = entry === 'project'
        ? { kind: 'project', projectId: 'project', screenId: 'screen', versionId: 'version', sourceImage: 'source.png' }
        : { kind: 'standalone', sourceImage: 'source.png' };
      const border = { bgColor: [0, 0, 0], sideScore: { top: 0, right: 0, bottom: 0, left: 0 }, dirtySides: [] };
      const element = {
        id: 'kept', label: 'Kept', objectName: 'UserName', state: 'Selected', kind: 'icon',
        rect: { x: 4, y: 4, w: 16, h: 16 }, description: 'user edited', layer: 1,
        approved: true, occluded: false, needsAi: true, extractionMethod: 'manual',
        processingStatus: 'failed', processingError: 'old failure',
        slice: { width: 16, height: 16, image: 'saved.png', border },
      };
      let stored = { schemaVersion: 1, id: 'task', name: 'Saved task', source, width: 32, height: 32,
        elements: [element], status: 'interrupted', createdAt: 1, updatedAt: 1 };
      const originalStored = structuredClone(stored);
      const project = { id: 'project', name: 'Project', stylePrompt: '', orientation: 'portrait', size: { w: 32, h: 32 },
        screens: [{ id: 'screen', name: 'Screen', usage: '', layout: [], activeVersionId: 'version',
          versions: [{ id: 'version', image: 'source.png', createdAt: 1 }] }], createdAt: 1, updatedAt: 1 };
      let png;
      let segmentFailure = false;
      let holdSave = false;
      let failSave = false;
      let releaseSave;
      const calls = { detect: 0, segment: 0, plate: 0, put: 0, upload: 0 };
      await page.route('http://caller.test/**', async (route) => {
        const url = new URL(route.request().url());
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        switch (url.pathname) {
          case '/': return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
          case '/api/projects': return json({ projects: [project] });
          case '/api/styles': return json({ styles: [] });
          case '/api/models': return json({ models: [] });
          case '/api/health': return json({ status: 'test', available: true });
          case '/api/segment-health': return json({ available: true });
          case '/api/image': return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
          case '/api/upload': calls.upload++; return json({ fileName: `output-${calls.upload}.png` });
          case '/api/segment':
            calls.segment++;
            if (segmentFailure) return json({ error: 'injected segmentation failure' }, 502);
            return json({ width: 32, height: 32, rgbaBase64: png, maskBase64: png });
          case '/api/detect': calls.detect++; return json({ error: 'unexpected paid detection' }, 502);
          case '/api/plate': calls.plate++; return json({ error: 'unexpected paid repaint' }, 502);
          case '/api/slice-tasks':
            if (route.request().method() === 'GET') return json({ tasks: [stored] });
            calls.put++;
            if (holdSave) await new Promise((resolve) => { releaseSave = resolve; });
            if (failSave) return json({ error: 'injected save failure' }, 503);
            stored = route.request().postDataJSON().task;
            return json({ tasks: [stored] });
          default: throw Error(`Unexpected HTTP: ${url.pathname}`);
        }
      });
      await page.goto('http://caller.test/');
      png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 32, 32);
        ctx.fillStyle = '#f00'; ctx.fillRect(4, 4, 16, 16);
        return canvas.toDataURL().split(',')[1];
      });
      if (scenario === 'restore') await page.evaluate(() => {
        const decode = HTMLImageElement.prototype.decode;
        window.decodeWaiters = [];
        window.releaseDecode = (name) => window.decodeWaiters.filter((item) => item.name === name).forEach((item) => item.resolve());
        HTMLImageElement.prototype.decode = async function () {
          const name = new URL(this.src).searchParams.get('name');
          if (name === 'source.png' || name === 'saved.png') {
            await new Promise((resolve) => window.decodeWaiters.push({ name, resolve }));
          }
          return decode.call(this);
        };
      });
      await page.addStyleTag({ content: await fs.readFile('src/styles.css', 'utf8') });
      await page.addScriptTag({ content: built.outputFiles[0].text });
      if (entry === 'project') await page.getByRole('button', { name: '3 · 素材', exact: true }).click();
      else {
        await page.getByRole('button', { name: '切图工具', exact: true }).click();
        await page.getByLabel('恢复独立任务').selectOption('task');
      }
      const analyze = page.getByRole('button', { name: entry === 'project' ? '分析' : '分析 / 重试未完成项', exact: true });
      const redetect = page.getByRole('button', { name: entry === 'project' ? '重新识别（保留已有素材）' : '重新识别', exact: true });
      const plate = page.getByRole('button', { name: '补图', exact: true });
      const send = page.getByRole('button', { name: '选此任务换肤', exact: true });
      // Exercise actual callback guards as well as disabled presentation.
      const invoke = async (locator) => locator.evaluate((node) => {
        const props = node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))];
        props.onClick({ target: node, currentTarget: node });
      });
      if (scenario === 'restore') {
        await page.waitForFunction(() => window.decodeWaiters.length === 2);
        for (const button of [analyze, redetect, plate, send]) assert.equal(await button.isDisabled(), true, `${entry}: block while both decodes pending`);
        assert.ok(await page.getByRole('status').filter({ hasText: '恢复中' }).count());
        await invoke(analyze); await invoke(redetect); await invoke(plate); await invoke(send);
        assert.deepEqual(calls, { detect: 0, segment: 0, plate: 0, put: 0, upload: 0 });
        await page.evaluate(() => window.releaseDecode('source.png'));
        assert.equal(await analyze.isDisabled(), true, 'source ready but elements still decoding');
        await page.evaluate(() => window.releaseDecode('saved.png'));
        await page.getByRole('button', { name: '预览 Kept', exact: true }).waitFor();
        assert.equal(await analyze.isDisabled(), false);
        await analyze.click();
        await page.waitForFunction(() => !document.querySelector('.slice-actions .primary').disabled);
        assert.equal(calls.detect, 0, 'restored successful manual artifact must not be detected again');
        assert.equal(calls.segment, 0);
        assert.deepEqual(stored.elements, originalStored.elements);
        console.log(`PASS ${entry}: actual slow source/elements decode, entry/callback guards, restore resumes without overwriting user artifact`);
        passed++;
      } else {
        await page.getByRole('button', { name: '预览 Kept', exact: true }).click();
        const crop = page.getByRole('button', { name: '精准分割此素材', exact: true });
        const oldPng = await page.locator('.slice-preview-card img').getAttribute('src');
        segmentFailure = true;
        await crop.click();
        await page.getByRole('alert').filter({ hasText: 'injected segmentation failure' }).waitFor();
        assert.equal(await page.locator('.slice-preview-card img').getAttribute('src'), oldPng);
        assert.equal(calls.put, 0, 'failed crop must preserve original and avoid persisting a replacement');
        assert.deepEqual(stored, originalStored);
        if (scenario === 'clear') {
          segmentFailure = false;
          const saved = page.waitForResponse((response) => response.url().endsWith('/api/slice-tasks') && response.request().method() === 'PUT');
          await crop.click(); await saved;
          assert.equal(stored.elements[0].processingStatus, 'done', 'successful precise retry clears old failed status');
          assert.equal(stored.elements[0].processingError, undefined, 'successful precise retry clears old error');
          passed++;
          console.log(`PASS ${entry}: failed then successful precise retry clears old status/error`);
          await page.close();
          continue;
        }
        segmentFailure = false; holdSave = true;
        await crop.click();
        await page.waitForFunction(() => document.querySelector('.slice-edit-fields').disabled);
        while (!releaseSave) await new Promise(setImmediate);
        for (const button of [crop, page.getByRole('button', { name: '按此框从原图色键提取', exact: true })]) assert.equal(await button.isDisabled(), true);
        const beforePending = { ...calls };
        await invoke(crop); await invoke(analyze); await invoke(redetect); await invoke(plate); await invoke(send);
        assert.deepEqual(calls, beforePending, 'pending save blocks new crop, detection and paid repaint');
        failSave = true; holdSave = false; releaseSave(); releaseSave = null;
        await page.getByRole('alert').filter({ hasText: 'injected save failure' }).waitFor();
        assert.equal(await crop.isDisabled(), true, 'failed save keeps pending lock and current local artifact');
        assert.equal(await page.locator('.slice-preview-card img').getAttribute('src') === oldPng, false);
        failSave = false;
        await invoke(page.getByRole('button', { name: '重试保存', exact: true }));
        await page.waitForFunction(() => !document.querySelector('.slice-edit-fields').disabled);
        assert.equal(stored.elements[0].processingStatus, 'done', `${entry}: precise retry must clear failed state`);
        assert.equal(stored.elements[0].processingError, undefined);
        assert.equal(stored.elements[0].extractionMethod, 'segmentation');
        assert.equal(calls.segment, 2, 'save retry must not repeat inference');
        // Mount the real App again from a persisted failure before EACH success method.
        const reopenFailedItem = async () => {
          stored.elements[0].processingStatus = 'interrupted';
          stored.elements[0].processingError = 'old failure';
          stored.status = 'interrupted';
          await page.evaluate(() => window.remount());
          if (entry === 'project') await page.getByRole('button', { name: '3 · 素材', exact: true }).click();
          else {
            await page.getByRole('button', { name: '切图工具', exact: true }).click();
            await page.getByLabel('恢复独立任务').selectOption('task');
          }
          await page.getByRole('status').filter({ hasText: '分析重试未完成分割，补图仅重绘遮挡项' }).waitFor();
          await page.getByRole('alert').filter({ hasText: 'old failure' }).waitFor();
          await page.getByRole('button', { name: '预览 Kept', exact: true }).click();
        };
        await reopenFailedItem();
        const colorSave = page.waitForResponse((response) => response.url().endsWith('/api/slice-tasks') && response.request().method() === 'PUT');
        await page.getByRole('button', { name: '按此框从原图色键提取', exact: true }).click();
        await colorSave;
        await page.waitForFunction(() => !document.querySelector('.slice-edit-fields').disabled);
        assert.equal(stored.elements[0].extractionMethod, 'color-key');
        assert.equal(stored.elements[0].processingStatus, 'done');
        assert.equal(stored.elements[0].processingError, undefined);
        await reopenFailedItem();
        segmentFailure = true;
        await crop.click();
        await page.getByRole('alert').filter({ hasText: 'injected segmentation failure' }).waitFor();
        await page.getByRole('button', { name: '编辑蒙版', exact: true }).click();
        await page.getByRole('slider').fill('1');
        const mask = page.locator('.mask-edit-canvas');
        const bounds = await mask.boundingBox();
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const painted = await mask.evaluate((node) => Array.from(node.getContext('2d').getImageData(0, 0, node.width, node.height).data));
        holdSave = true;
        await page.getByRole('button', { name: '保存蒙版', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('.mask-editor fieldset').disabled);
        while (!releaseSave) await new Promise(setImmediate);
        const beforeManualPending = { ...calls };
        await invoke(page.getByRole('button', { name: '保存蒙版', exact: true }));
        await invoke(page.getByRole('button', { name: '保存名称', exact: true }));
        assert.deepEqual(calls, beforeManualPending, 'pending lock also protects manual/metadata callbacks');
        assert.equal(await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'injected segmentation failure' }).count(), 0, 'manual success clears local extraction error');
        assert.deepEqual(await mask.evaluate((node) => Array.from(node.getContext('2d').getImageData(0, 0, node.width, node.height).data)), painted, 'pending lock must preserve manual strokes');
        holdSave = false; releaseSave(); releaseSave = null;
        await page.waitForFunction(() => !document.querySelector('.mask-editor fieldset').disabled);
        assert.equal(stored.elements[0].extractionMethod, 'manual');
        assert.equal(stored.elements[0].processingStatus, 'done');
        assert.equal(stored.elements[0].processingError, undefined);
        assert.equal(await page.getByRole('button', { name: '撤销', exact: true }).isDisabled(), false, 'manual history survives save echo');
        console.log(`PASS ${entry}: actual precise/color-key/manual callbacks clear errors; failure keeps PNG; pending/failed save blocks new processing; retry saves without inference; manual history retained`);
        passed++;
      }
      assert.deepEqual(errors, [], 'no React/browser runtime errors');
      await page.screenshot({ path: path.join(evidence, `${entry}-${scenario}.png`) });
      await page.close();
    }
  }
  console.log(`${passed} real browser caller regressions passed. Evidence: ${evidence}`);
  console.log('Controlled HTTP fixtures; real React, Image/Canvas and production callers/hook. NOT real model inference, production API or whole-repository build.');
} finally { await browser.close(); }
