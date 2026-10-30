import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';

const evidenceDirectory = await fs.mkdtemp('./.data/ai-slice-browser-');
const sourceImage = await sharp({
  create: { width: 120, height: 200, channels: 4, background: '#315b7a' },
}).png().toBuffer();
const sheetImage = await sharp({
  create: { width: 160, height: 120, channels: 4, background: { r: 24, g: 96, b: 168, alpha: 1 } },
}).png().toBuffer();
const project = {
  id: 'ai-slice-project',
  name: 'AI 拆图测试',
  size: { w: 1080, h: 1920 },
  orientation: 'portrait',
  stylePrompt: '',
  createdAt: 1,
  updatedAt: 1,
  screens: [{
    id: 'screen',
    name: '主界面',
    usage: '',
    layout: [],
    activeVersionId: 'v-source',
    versions: [{ id: 'v-source', image: 'source.png', prompt: '原始界面', createdAt: 1 }],
  }],
};
let sheetRequest;
let uploaded;
let projectWrites = 0;
let sliceTasks = [];
let uploadCount = 0;
let detectCalls = 0;
let segmentCalls = 0;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/health', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ gateway: true, status: '测试网关', visionModel: 'test-vision' }),
  }));
  await page.route('**/api/models', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ models: [] }),
  }));
  await page.route('**/api/styles', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ styles: [] }),
  }));
  await page.route('**/api/project-render/tasks', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify([]),
  }));
  await page.route('**/api/segment-health', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ available: true }),
  }));
  const assertNoVisionCalls = () => {
    assert.equal(detectCalls, 0, 'AI sheet slicing must not call the vision detector');
    assert.equal(segmentCalls, 0, 'AI sheet slicing must not call SAM segmentation');
  };
  await page.route('**/api/slice-tasks', async route => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tasks: sliceTasks }) });
      return;
    }
    sliceTasks = [route.request().postDataJSON().task];
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tasks: sliceTasks }) });
  });
  await page.route('**/api/projects', async route => {
    if (route.request().method() === 'PUT') {
      projectWrites++;
      Object.assign(project, route.request().postDataJSON().project);
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ projects: [project] }) });
  });
  await page.route('**/api/image?*', async route => {
    const name = new URL(route.request().url()).searchParams.get('name');
    const image = name === 'ai-slice-sheet.png' ? sheetImage : sourceImage;
    await route.fulfill({ contentType: 'image/png', body: image });
  });
  await page.route('**/api/ai-slice-sheet', async route => {
    sheetRequest = route.request().postDataJSON();
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ dataUrl: `data:image/png;base64,${sheetImage.toString('base64')}` }),
    });
  });
  await page.route('**/api/upload', async route => {
    uploadCount++;
    const body = route.request().postDataJSON();
    if (uploadCount === 1) uploaded = body;
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ fileName: 'ai-slice-sheet.png' }),
    });
  });

  await page.goto('http://127.0.0.1:5174/');
  await page.getByRole('main', { name: '首页', exact: true }).waitFor();
  await page.locator('.home-project-open').click();
  const card = page.locator('.screen-card');
  await card.waitFor();
  await card.locator('.screen-preview-frame').last().hover();
  await card.getByRole('button', { name: '编辑资源', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '资源编辑器', exact: true });
  await editor.waitFor();
  const aiSliceButton = editor.getByRole('button', { name: 'AI 拆图', exact: true });
  await aiSliceButton.waitFor();
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(entry => entry.textContent === 'AI 拆图');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await aiSliceButton.click();

  const dialog = page.getByRole('dialog', { name: 'AI 拆图', exact: true });
  await dialog.waitFor();
  const prompt = dialog.getByLabel('拆分要求', { exact: true });
  assert.ok((await prompt.inputValue()).includes('透明背景'));
  await prompt.fill('重点拆分按钮和图标，按类别整齐排列');
  await dialog.getByRole('button', { name: '生成拆图素材表', exact: true }).click();

  await page.waitForFunction(() => document.body.textContent?.includes('AI 拆图完成'));
  assert.equal(sheetRequest.size, '1024x1536');
  assert.ok(sheetRequest.reference.startsWith('data:image/png;base64,'));
  assert.ok(sheetRequest.prompt.includes('透明背景'));
  assert.ok(sheetRequest.prompt.includes('重点拆分按钮和图标'));
  assert.equal(uploaded.image.startsWith('data:image/png;base64,'), true);
  assert.equal(projectWrites, 0, 'AI sheet must stay intermediate and never create a new screen version');
  assert.equal(project.screens[0].versions.length, 1);
  await page.waitForFunction(() => document.querySelectorAll('.atlas-sprite').length === 1, null, { timeout: 10000 });
  for (let attempt = 0; attempt < 100 && !sliceTasks.length; attempt++) await page.waitForTimeout(50);
  assertNoVisionCalls();
  assert.ok(sliceTasks[0], 'automatic slicing must persist a slice task');
  assert.equal(sliceTasks[0].elements.length, 1);
  assert.equal(sliceTasks[0].elements[0].extractionMethod, 'ai-sheet');
  assert.equal(await editor.getByRole('button', { name: '一键切图', exact: true }).isEnabled(), true);
  await page.screenshot({ path: `${evidenceDirectory}/ai-slice-sheet-version.png` });
  assert.deepEqual(errors, []);
  console.log(`PASS AI slice sheet generation, transparent prompt, intermediate alpha-only slicing, atlas output without V2 version; ${evidenceDirectory}`);
} finally {
  await browser.close();
}
