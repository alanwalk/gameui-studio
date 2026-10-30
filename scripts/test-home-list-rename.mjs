import assert from 'node:assert/strict';
import {chromium} from 'playwright';

let project={id:'home-rename-project',name:'原项目',size:{w:1080,h:1920},orientation:'portrait',stylePrompt:'原画风提示词',styleImage:'reference-a.png',createdAt:1,updatedAt:1,
  screens:[{id:'home-screen',name:'首页',usage:'主界面',layout:[],activeVersionId:'original-version',versions:[{id:'original-version',prompt:'原提示词',createdAt:1,styleSnapshot:{id:'original-style',name:'原画风',prompt:'原画风提示词'}}]}]};
const originalStyle={id:'original-style',name:'原画风',prompt:'原画风提示词',image:'reference-a.png',referenceImages:['reference-a.png','reference-b.png'],createdAt:1,updatedAt:1};
const otherStyle={id:'other-style',name:'其他画风',prompt:'其他提示词',createdAt:2};
let styles=[structuredClone(originalStyle),structuredClone(otherStyle)];
const originalProject=structuredClone(project);
let projectWrites=0;
let styleWrites=0;
let failStyleSave=false;
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:815,height:859}});
  await page.route('**/api/project-render/tasks',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/projects',async route=>{
    if(route.request().method()==='PUT'){project=route.request().postDataJSON().project;projectWrites++;}
    await route.fulfill({contentType:'application/json',body:JSON.stringify({projects:[project]})});
  });
  await page.route('**/api/styles',async route=>{
    if(route.request().method()==='PUT') {
      styleWrites++;
      if(failStyleSave){failStyleSave=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟重命名失败'})});return;}
      const saved=route.request().postDataJSON().style;
      styles=styles.map(style=>style.id===saved.id?saved:style);
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({styles})});
  });
  await page.goto('http://127.0.0.1:5174/');
  const home=page.getByRole('main',{name:'首页',exact:true});
  const projectRow=home.locator('.home-project-row').first();const projectMenu=projectRow.locator('.home-item-menu');
  await projectMenu.waitFor();assert.equal(await projectMenu.evaluate(el=>getComputedStyle(el).opacity),'0');
  await projectRow.hover();await projectMenu.locator('summary').click();
  assert.deepEqual(await projectMenu.getByRole('button').allTextContents(),['复制项目','重命名','删除项目']);
  await projectMenu.getByRole('button',{name:'重命名',exact:true}).click();
  const projectDialog=page.getByRole('dialog',{name:'重命名项目',exact:true});
  assert.equal(await projectDialog.getByLabel('项目名称',{exact:true}).inputValue(),'原项目');
  await projectDialog.getByLabel('项目名称',{exact:true}).fill('取消的名称');
  await projectDialog.getByRole('button',{name:'取消',exact:true}).click();assert.equal(projectWrites,0);
  await projectRow.hover();await projectMenu.locator('summary').click();await projectMenu.getByRole('button',{name:'重命名',exact:true}).click();
  await projectDialog.getByLabel('项目名称',{exact:true}).fill('  ');
  assert.equal(await projectDialog.getByRole('button',{name:'保存名称',exact:true}).isDisabled(),true);
  await projectDialog.getByLabel('项目名称',{exact:true}).fill('  首页改名项目  ');await projectDialog.getByLabel('项目名称',{exact:true}).press('Enter');
  await projectDialog.waitFor({state:'detached'});
  assert.equal(project.name,'首页改名项目');assert.equal(project.id,originalProject.id);assert.deepEqual(project.screens,originalProject.screens);
  await home.locator('.home-project-open').click();
  assert.equal(await page.locator('.project-identity strong').textContent(),'首页改名项目');
  await page.getByRole('button',{name:'返回首页',exact:true}).click();
  await page.getByRole('tab',{name:'我的画风',exact:true}).click();
  const styleRow=home.locator('.home-project-row').first();const styleMenu=styleRow.locator('.home-item-menu');
  await styleRow.hover();await styleMenu.locator('summary').click();
  assert.deepEqual(await styleMenu.getByRole('button').allTextContents(),['复制画风','重命名','删除画风']);
  await styleMenu.getByRole('button',{name:'重命名',exact:true}).click();
  const styleDialog=page.getByRole('dialog',{name:'重命名画风',exact:true});
  await styleDialog.getByLabel('画风名称',{exact:true}).fill('Esc取消');await page.keyboard.press('Escape');await styleDialog.waitFor({state:'detached'});
  assert.equal(styleWrites,0);
  await styleRow.hover();await styleMenu.locator('summary').click();await styleMenu.getByRole('button',{name:'重命名',exact:true}).click();
  await styleDialog.getByLabel('画风名称',{exact:true}).fill('  首页改名画风  ');failStyleSave=true;
  await styleDialog.getByRole('button',{name:'保存名称',exact:true}).click();
  await page.locator('.toast-item').filter({hasText:'模拟重命名失败'}).waitFor();
  assert.equal(await styleDialog.getByLabel('画风名称',{exact:true}).inputValue(),'  首页改名画风  ');assert.deepEqual(styles[0],originalStyle);
  await styleDialog.getByRole('button',{name:'保存名称',exact:true}).click();await styleDialog.waitFor({state:'detached'});
  assert.equal(styles[0].name,'首页改名画风');assert.equal(styles[0].id,originalStyle.id);assert.equal(styles[0].prompt,originalStyle.prompt);
  assert.deepEqual(styles[0].referenceImages,originalStyle.referenceImages);assert.equal(styles[0].createdAt,originalStyle.createdAt);
  assert.deepEqual(styles[1],otherStyle);assert.equal(projectWrites,1);assert.deepEqual(project.screens,originalProject.screens);
  await styleRow.locator('.home-style-open').click();
  await page.getByRole('main',{name:'画风详情',exact:true}).getByRole('heading',{name:'首页改名画风',exact:true}).waitFor();
  await page.reload();await home.waitFor();assert.equal(await home.locator('.home-project-open strong').textContent(),'首页改名项目');
  await page.getByRole('tab',{name:'我的画风',exact:true}).click();assert.equal(await home.locator('.home-style-open').first().textContent(),'首页改名画风');
  console.log('PASS project/style hover rename menus, matching dialog UI, cancel/Esc/blank guard, failed-save retry, trimmed persisted names, unchanged IDs/screens/versions/prompts/references and refresh; all project/style writes mocked');
} finally {await browser.close();}
