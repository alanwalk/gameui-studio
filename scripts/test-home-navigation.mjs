import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({channel: 'msedge', headless: true});
try {
  const page = await browser.newPage({viewport: {width: 1920, height: 940}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:5174/');
  const home = page.getByRole('main', {name: '首页', exact: true});
  await home.waitFor();
  await home.locator('.home-project-open').first().waitFor();
  await home.getByRole('button', {name: '我的风格库', exact: true}).click();
  await page.getByRole('button', {name: '手动新增风格', exact: true}).click();
  const editor = page.getByRole('main', {name: '手动新增风格', exact: true});
  await editor.waitFor();
  await editor.getByRole('button', {name: '取消编辑', exact: true}).click();
  await editor.waitFor({state: 'detached'});
  await page.getByRole('button', {name: '返回首页', exact: true}).click();
  await home.waitFor();
  const projectCount = await home.locator('.home-project-open').count();
  const name = await home.locator('.home-project-open strong').first().textContent();
  await home.locator('.home-project-open').first().click();
  await page.getByRole('main', {name: '项目总览'}).waitFor();
  assert.equal(await page.locator('.proj.open .proj-name').textContent().then(value => value.trim()), name);
  assert.equal(await page.locator('.sidebar .proj').count(), 1);
  assert.equal(await page.locator('.sidebar').getByText('其他项目',{exact:true}).count(), 0);
  if (projectCount > 1) {
    await page.getByRole('button', {name: '返回首页', exact: true}).click();
    await home.waitFor();
    await home.locator('.home-project-open').nth(1).click();
    await page.getByRole('main', {name: '项目总览'}).waitFor();
    assert.equal(await page.locator('.sidebar .proj').count(), 1);
    assert.notEqual(await page.locator('.proj.open .proj-name').textContent().then(value => value.trim()), name);
  }
  await page.getByRole('button', {name: '返回首页', exact: true}).click();
  await home.waitFor();
  assert.equal(await home.locator('.home-project-open').count(), projectCount);
  await page.screenshot({path: './.data/home-navigation.png'});
  assert.deepEqual(errors, []);
  console.log('PASS home, style editor, current-project-only sidebar, switch projects through home, return home; no data changes or model calls');
} finally {
  await browser.close();
}
