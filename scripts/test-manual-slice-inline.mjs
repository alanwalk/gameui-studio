import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { chromium } from 'playwright';

const evidenceDirectory = await fs.mkdtemp('./.data/manual-slice-inline-');
const sourcePng = await sharp({ create: { width: 120, height: 80, channels: 4, background: '#4f8a5b' } }).png().toBuffer();
const maskPng = await sharp({ create: { width: 120, height: 80, channels: 4, background: '#ffffff' } }).png().toBuffer();
const project = {
  id: 'manual-slice-project',
  name: '框选切图测试',
  size: { w: 120, h: 80 },
  orientation: 'landscape',
  stylePrompt: '',
  createdAt: 1,
  updatedAt: 1,
  screens: [{
    id: 'manual-slice-screen',
    name: '界面',
    usage: '',
    layout: [],
    activeVersionId: 'manual-slice-version',
    versions: [{ id: 'manual-slice-version', image: 'source.png', prompt: '', createdAt: 1 }],
  }],
};
let task = {
  schemaVersion: 1,
  id: 'manual-slice-task',
  name: '框选切图测试',
  source: {
    kind: 'project',
    projectId: project.id,
    screenId: project.screens[0].id,
    versionId: project.screens[0].versions[0].id,
    sourceImage: 'source.png',
  },
  width: 120,
  height: 80,
  elements: [],
  status: 'done',
  createdAt: 1,
  updatedAt: 1,
};
const segmentRequests = [];
const taskWrites = [];
let uploadCount = 0;

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', () => {
    throw new Error('直接框选不应打开原生对话框');
  });

  await page.route('**/api/projects', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ projects: [project] }) });
  });
  await page.route('**/api/styles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ styles: [] }) }));
  await page.route('**/api/project-render/tasks', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.route('**/api/slice-tasks', async (route) => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON();
      task = body.task;
      taskWrites.push(body);
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tasks: [task] }) });
  });
  await page.route('**/api/image**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: sourcePng }));
  await page.route('**/api/segment', async (route) => {
    segmentRequests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        width: 120,
        height: 80,
        rgbaBase64: sourcePng.toString('base64'),
        maskBase64: maskPng.toString('base64'),
      }),
    });
  });
  await page.route('**/api/upload', async (route) => {
    uploadCount++;
    const fileName = uploadCount === 1 ? 'manual-mask.png' : 'manual-slice.png';
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ fileName }) });
  });

  await page.goto('http://127.0.0.1:5174/');
  await page.locator('.home-project-open').filter({ hasText: project.name }).click();
  const card = page.locator('.screen-card');
  await card.waitFor();
  await card.locator('.screen-preview-frame').last().hover();
  await card.getByRole('button', { name: '编辑资源', exact: true }).click();
  const resources = page.getByRole('dialog', { name: '资源编辑器', exact: true });
  await resources.waitFor();
  await resources.getByRole('button', { name: '框选切图', exact: true }).waitFor();

  assert.equal(await resources.getByRole('button', { name: '框选切图', exact: true }).isEnabled(), true);
  await resources.getByRole('button', { name: '框选切图', exact: true }).click();
  assert.equal(await resources.getByRole('button', { name: '取消框选', exact: true }).count(), 1);
  assert.equal(await page.getByRole('dialog', { name: '素材修正', exact: true }).count(), 0, '框选切图不应打开二级弹窗');

  const image = resources.getByAltText('当前素材来源图');
  await image.waitFor();
  const bounds = await image.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0);
  await page.mouse.move(bounds.x + bounds.width * 0.25, bounds.y + bounds.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.75, { steps: 5 });
  await page.mouse.up();

  const toolbar = resources.locator('.manual-slice-toolbar');
  await toolbar.waitFor();
  assert.equal(await resources.locator('.manual-slice-selection').count(), 1);
  assert.equal(await page.getByRole('dialog', { name: '素材修正', exact: true }).count(), 0);
  await resources.getByLabel('新素材名称', { exact: true }).fill('ManualButton');
  await page.screenshot({ path: `${evidenceDirectory}/manual-slice-toolbar.png` });

  await toolbar.getByRole('button', { name: '精准分割', exact: true }).click();
  await waitFor(() => segmentRequests.length === 1, '没有收到精准分割请求');
  assert.deepEqual(segmentRequests[0].rect, { x: 30, y: 20, w: 60, h: 40 });
  await waitFor(() => taskWrites.length === 1, '框选素材没有保存');
  assert.equal(taskWrites[0].task.elements[0].objectName, 'ManualButton');
  assert.deepEqual(taskWrites[0].task.elements[0].rect, { x: 30, y: 20, w: 60, h: 40 });
  assert.equal(taskWrites[0].task.elements[0].extractionMethod, 'segmentation');
  await resources.getByRole('button', { name: '预览 ManualButton', exact: true }).waitFor();
  assert.equal(await resources.getByRole('button', { name: '框选切图', exact: true }).count(), 1);
  assert.deepEqual(pageErrors, []);

  await page.screenshot({ path: `${evidenceDirectory}/manual-slice-inline.png` });
  console.log(`PASS direct left-canvas framing, inline name/extraction controls, no secondary dialog, saved manual asset; evidence: ${evidenceDirectory}`);
} finally {
  await browser.close();
}
