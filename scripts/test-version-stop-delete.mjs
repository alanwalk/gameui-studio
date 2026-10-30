import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const evidenceDirectory = await fs.mkdtemp('./.data/version-stop-delete-');
const project = {
  id: 'version-actions',
  name: '版本操作测试',
  size: { w: 1080, h: 1920 },
  orientation: 'portrait',
  stylePrompt: '',
  createdAt: 1,
  updatedAt: 1,
  screens: [{
    id: 'screen',
    name: '首页',
    usage: '',
    layout: [],
    activeVersionId: 'v-22222222-2222-4222-8222-222222222222',
    versions: [
      { id: 'v-11111111-1111-4111-8111-111111111111', image: 'existing.png', prompt: '已有结果', createdAt: 1 },
      { id: 'v-22222222-2222-4222-8222-222222222222', operation: 'generate', prompt: '生成新结果', createdAt: 2 },
    ],
  }],
};
let tasks = [{
  id: 'v-22222222-2222-4222-8222-222222222222',
  projectId: project.id,
  screenId: 'screen',
  operation: 'generate',
  prompt: '生成新结果',
  size: '1080x1920',
  status: 'running',
  createdAt: 2,
}];
let projectWrites = 0;
let cancelRequests = 0;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', () => {
    throw new Error('版本停止和删除应使用页面内确认，不应弹出原生对话框');
  });

  await page.route('**/api/projects', async (route) => {
    if (route.request().method() === 'PUT') {
      projectWrites++;
      Object.assign(project, route.request().postDataJSON().project);
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ projects: [project] }) });
  });
  await page.route('**/api/styles', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ styles: [] }) }));
  await page.route('**/api/project-render/tasks', (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(tasks) }));
  await page.route('**/api/project-render/tasks/*/cancel', async (route) => {
    cancelRequests++;
    const id = decodeURIComponent(route.request().url().split('/').at(-2));
    tasks = tasks.map((task) => task.id === id ? { ...task, status: 'discarded', error: '已停止生成' } : task);
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(tasks.find((task) => task.id === id)),
    });
  });

  await page.goto('http://127.0.0.1:5174/');
  await page.getByRole('main', { name: '首页', exact: true }).waitFor();
  assert.equal(await page.locator('.home-footer').count(), 0, '首页底部文案已移除');

  await page.locator('.home-project-open').click();
  const card = page.locator('.screen-card');
  await card.waitFor();
  assert.equal(await card.getByRole('button', { name: '停止生成', exact: true }).count(), 1);
  assert.equal(await card.getByRole('button', { name: '删除版本：V2', exact: true }).count(), 1);
  const resultPreview = card.locator('.screen-preview').nth(1);
  await resultPreview.locator('.screen-preview-frame').hover();
  assert.equal(await resultPreview.getByRole('button', { name: '微调结果', exact: true }).count(), 0,
    '生成中不应显示常规结果菜单');
  assert.equal(await resultPreview.getByRole('button', { name: '编辑资源', exact: true }).count(), 0,
    '生成中不应显示常规资源菜单');
  await page.screenshot({ path: `${evidenceDirectory}/version-actions-running.png` });

  await card.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ver-dot').length === 1);
  assert.equal(cancelRequests, 1);
  assert.equal(project.screens[0].versions.length, 1);
  assert.equal(project.screens[0].versions[0].id, 'v-11111111-1111-4111-8111-111111111111');
  assert.equal(await card.getByRole('button', { name: '停止生成', exact: true }).count(), 0);
  await resultPreview.locator('.screen-preview-frame').hover();
  assert.equal(await resultPreview.getByRole('button', { name: '微调结果', exact: true }).count(), 1,
    '停止生成后应恢复常规结果菜单');
  assert.equal(await resultPreview.getByRole('button', { name: '编辑资源', exact: true }).count(), 1,
    '停止生成后应恢复常规资源菜单');

  const writesBeforeDelete = projectWrites;
  await card.getByRole('button', { name: '删除版本：V1', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '删除版本', exact: true });
  await confirmation.waitFor();
  assert.equal(projectWrites, writesBeforeDelete, '打开删除确认不应立即写入项目');
  await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await confirmation.waitFor({ state: 'detached' });
  assert.equal(projectWrites, writesBeforeDelete);
  assert.equal(project.screens[0].versions.length, 1);

  await card.getByRole('button', { name: '删除版本：V1', exact: true }).click();
  await confirmation.getByRole('button', { name: '确认删除', exact: true }).click();
  await confirmation.waitFor({ state: 'detached' });
  assert.equal(projectWrites, writesBeforeDelete + 1);
  assert.equal(project.screens[0].versions.length, 0);
  assert.equal(await card.getByRole('button', { name: /删除版本/ }).count(), 0);
  assert.ok((await card.textContent()).includes('尚未生成'));
  assert.deepEqual(pageErrors, []);

  await page.screenshot({ path: `${evidenceDirectory}/version-actions.png` });
  console.log(`PASS remove home footer, stop running generation, in-page delete confirmation/cancel/confirm; evidence: ${evidenceDirectory}`);
} finally {
  await browser.close();
}
