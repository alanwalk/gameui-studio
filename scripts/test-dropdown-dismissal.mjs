import assert from 'node:assert/strict';
import sharp from 'sharp';
import {chromium} from 'playwright';

const source=await sharp({create:{width:64,height:96,channels:4,background:'#4499aa'}}).png().toBuffer();
const asset=await sharp({create:{width:12,height:8,channels:4,background:'#cc3344'}}).png().toBuffer();
const makeScreen=(id,name)=>({id,name,usage:'',layout:[],versions:[{id:'version-'+id,image:'source.png',prompt:'',createdAt:1}],activeVersionId:'version-'+id});
const projects=[{id:'project-one',name:'项目一',size:{w:1080,h:1920},orientation:'portrait',stylePrompt:'',createdAt:1,updatedAt:1,screens:[makeScreen('screen-one','首页'),makeScreen('screen-two','背包')]},
  {id:'project-two',name:'项目二',size:{w:1080,h:1920},orientation:'portrait',stylePrompt:'',createdAt:1,updatedAt:1,screens:[makeScreen('screen-three','首页')]}];
const styles=[{id:'style',name:'测试画风',prompt:'测试提示词',image:'source.png',referenceImages:['source.png'],createdAt:1}];
const element={id:'asset',kind:'button',label:'RedButton',objectName:'RedButton',state:'Normal',description:'',rect:{x:8,y:12,w:12,h:8},approved:true,needsAi:false,occluded:false,layer:1,processingStatus:'done',extractionMethod:'manual',
  slice:{image:'asset.png',width:12,height:8,border:{bgColor:[0,0,0],sideScore:{top:1,right:1,bottom:1,left:1},dirtySides:[]}}};
const task={schemaVersion:1,id:'project-task',name:'项目素材',source:{kind:'project',projectId:'project-one',screenId:'screen-one',versionId:'version-screen-one',sourceImage:'source.png'},width:64,height:96,elements:[element],status:'done',createdAt:1,updatedAt:1};
const tasks=[task,{...task,id:'standalone-task',name:'独立切图.png',source:{kind:'standalone',sourceImage:'source.png'}}];
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:940}});
  const writes=[];const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(request.url().includes('/api/')&&request.method()!=='GET')writes.push(request.url());});
  await page.route('**/api/projects',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({projects})}));
  await page.route('**/api/styles',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({styles})}));
  await page.route('**/api/project-render/tasks',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/slice-tasks',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({tasks})}));
  await page.route('**/api/image?*',route=>route.fulfill({contentType:'image/png',body:new URL(route.request().url()).searchParams.get('name')==='asset.png'?asset:source}));
  await page.route('**/api/health',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({gateway:true,status:'测试'})}));
  await page.route('**/api/models',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({models:[]})}));

  const open=async menu=>{
    await menu.locator('..').hover();
    await menu.locator('summary').first().click();
    assert.equal(await menu.evaluate(element=>element.open),true);
    assert.equal(await menu.getAttribute('data-dropdown-menu'),'true');
  };
  const closed=async menu=>assert.equal(await menu.evaluate(element=>element.open),false);
  await page.goto('http://127.0.0.1:5174/');
  const home=page.getByRole('main',{name:'首页',exact:true});
  const projectMenus=home.locator('.home-item-menu');await projectMenus.first().waitFor();
  await open(projectMenus.first());
  await home.locator('.home-creation').click({position:{x:12,y:12}});await closed(projectMenus.first());
  await open(projectMenus.first());await page.keyboard.press('Escape');await closed(projectMenus.first());
  await open(projectMenus.first());await open(projectMenus.nth(1));await closed(projectMenus.first());
  await projectMenus.nth(1).locator('summary').click();await closed(projectMenus.nth(1));
  await projectMenus.first().locator('summary').focus();await page.keyboard.press('Enter');
  assert.equal(await projectMenus.first().evaluate(element=>element.open),true);
  await home.locator('.home-creation').click({position:{x:12,y:12}});await closed(projectMenus.first());

  await home.getByRole('tab',{name:'我的画风',exact:true}).click();
  const styleMenu=home.locator('.home-item-menu').first();await open(styleMenu);
  await home.locator('.home-creation').click({position:{x:12,y:12}});await closed(styleMenu);
  await open(styleMenu);await page.keyboard.press('Escape');await closed(styleMenu);
  await open(styleMenu);await styleMenu.getByRole('button',{name:'重命名',exact:true}).click();
  const renameStyle=page.getByRole('dialog',{name:'重命名画风',exact:true});await renameStyle.waitFor();
  await page.keyboard.press('Escape');await renameStyle.waitFor({state:'detached'});
  await home.getByRole('tab',{name:'我的项目',exact:true}).click();await home.locator('.home-project-open').first().click();

  const screenMenu=page.locator('.screen-actions-menu').first();await open(screenMenu);
  await page.getByLabel('无限画布',{exact:true}).click({position:{x:10,y:10}});await closed(screenMenu);
  await open(screenMenu);await page.keyboard.press('Escape');await closed(screenMenu);
  await open(screenMenu);await screenMenu.getByRole('button',{name:'重命名',exact:true}).click();
  const renameScreen=page.getByRole('dialog',{name:'重命名界面',exact:true});await renameScreen.waitFor();
  await renameScreen.getByRole('button',{name:'取消',exact:true}).click();
  const card=page.locator('.screen-card').first();await card.locator('.screen-preview-frame').last().hover();
  await card.getByRole('button',{name:'编辑资源',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'资源编辑器',exact:true});await editor.waitFor();
  const assetMenu=editor.locator('.asset-options');await open(assetMenu);
  await assetMenu.locator('.asset-export-settings > summary').click();
  await assetMenu.getByLabel('素材命名模块',{exact:true}).click();
  assert.equal(await assetMenu.evaluate(element=>element.open),true,'clicks within settings must not close the outer menu');
  await page.keyboard.press('Escape');await closed(assetMenu);
  assert.equal(await editor.count(),1,'Esc closes the menu without closing its editor');
  assert.equal(await assetMenu.locator('summary').first().evaluate(element=>element===document.activeElement),true,'Esc restores menu trigger focus');
  await open(assetMenu);await editor.getByRole('heading',{name:'资源编辑器',exact:true}).click();await closed(assetMenu);
  await open(assetMenu);await editor.getByLabel('效果图画布',{exact:true}).click({position:{x:8,y:8}});await closed(assetMenu);
  await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});
  await page.getByRole('button',{name:'返回首页',exact:true}).click();

  await page.getByRole('button',{name:'切图工具',exact:true}).click();
  const slicer=page.getByRole('main',{name:'切图工具',exact:true});
  const slicerMenu=slicer.locator('.slicer-more-actions');await slicerMenu.waitFor();await open(slicerMenu);
  await slicer.locator('.slicer-task-heading h1').click();await closed(slicerMenu);
  await open(slicerMenu);await page.keyboard.press('Escape');await closed(slicerMenu);
  await open(slicerMenu);await slicer.getByRole('button',{name:'资源编辑',exact:true}).click();await closed(slicerMenu);
  await editor.waitFor();const standaloneMenu=editor.locator('.asset-options');await open(standaloneMenu);
  await page.keyboard.press('Escape');await closed(standaloneMenu);assert.equal(await editor.count(),1);
  await open(standaloneMenu);
  await editor.getByRole('heading',{name:'资源编辑器',exact:true}).click();await closed(standaloneMenu);
  await editor.getByRole('button',{name:'关闭资源编辑器',exact:true}).click();
  assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
  console.log('PASS outside-click and Esc dismissal for every ellipsis menu, trigger focus restored, editor stays open on first Esc, normal dialog Esc preserved, menu switching and inner actions; APIs mocked, no writes');
} finally {await browser.close();}
