import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';

let project={id:'rename-project',name:'界面操作测试',size:{w:1080,h:1920},orientation:'portrait',stylePrompt:'',createdAt:1,updatedAt:1,
  screens:['首页','背包','设置'].map((name,index)=>({id:`screen-${index}`,name,usage:'',layout:[],versions:[{id:`version-${index}`,prompt:'原提示词',createdAt:1}],activeVersionId:`version-${index}`}))};
const versions=structuredClone(project.screens.map(screen=>screen.versions));
let writes=0;
const copyRequests=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:940}});
  await page.route('**/api/project-render/tasks',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/projects',async route=>{
    if(route.request().method()==='PUT'){project=route.request().postDataJSON().project;writes++;}
    await route.fulfill({contentType:'application/json',body:JSON.stringify({projects:[project]})});
  });
  await page.route('**/api/screens/copy',async route=>{
    const request=route.request().postDataJSON();copyRequests.push(request);
    const source=project.screens.find(screen=>screen.id===request.screenId);
    const copy={...structuredClone(source),id:randomUUID(),name:source.name+' 副本'};
    project={...project,screens:[...project.screens,copy]};
    await route.fulfill({contentType:'application/json',body:JSON.stringify({project,tasks:[],screenId:copy.id})});
  });
  await page.goto('http://127.0.0.1:5174/');await page.locator('.home-project-open').click();
  const sidebar=page.locator('.sidebar');
  const inventory=sidebar.locator('.screen-row').nth(1);const menu=inventory.locator('.screen-actions-menu');
  await menu.waitFor();assert.equal(await menu.evaluate(el=>getComputedStyle(el).opacity),'0');
  await inventory.hover();assert.equal(await menu.evaluate(el=>getComputedStyle(el).opacity),'1');
  await menu.locator('summary').click();
  assert.equal(await menu.getByRole('button').count(),3);
  await menu.getByRole('button',{name:'重命名',exact:true}).click();
  const rename=page.getByRole('dialog',{name:'重命名界面',exact:true});
  await rename.getByLabel('界面名称',{exact:true}).fill('取消的名字');
  await rename.getByRole('button',{name:'取消',exact:true}).click();assert.equal(writes,0);
  await inventory.hover();await menu.locator('summary').click();await menu.getByRole('button',{name:'重命名',exact:true}).click();
  await rename.getByLabel('界面名称',{exact:true}).fill('   ');
  assert.equal(await rename.getByRole('button',{name:'保存名称',exact:true}).isDisabled(),true);
  await rename.getByLabel('界面名称',{exact:true}).fill('  侧栏名称  ');
  await rename.getByRole('button',{name:'保存名称',exact:true}).click();await rename.waitFor({state:'detached'});
  assert.equal(project.screens[1].name,'侧栏名称');
  assert.equal(await sidebar.locator('.screen-row.active .screen-name').textContent(),'首页','renaming another screen must not select it');
  assert.equal(await page.locator('.screen-card').nth(1).locator('.card-screen-name').textContent(),'侧栏名称');
  const card=page.locator('.screen-card').first();
  const heading=card.locator('.screen-card-heading');
  const before=await heading.boundingBox();
  await card.locator('.card-screen-name').click();
  const input=card.getByLabel('界面名称',{exact:true});await input.waitFor();
  assert.equal((await heading.boundingBox()).height,before.height,'editing must not change card header height');
  const initialWrites=writes;
  await input.fill('Escape不保存');await input.press('Escape');
  assert.equal(await input.count(),0);assert.equal(writes,initialWrites);
  await card.locator('.card-screen-name').click();await input.fill('   ');await input.press('Enter');
  await page.locator('.toast-item').filter({hasText:'界面名称不能为空'}).waitFor();assert.equal(writes,initialWrites);
  await input.press('Escape');
  await card.locator('.card-screen-name').click();await input.fill('  卡片新名称  ');await input.press('Enter');
  await input.waitFor({state:'detached'});assert.equal(writes,initialWrites+1);
  assert.equal(project.screens[0].name,'卡片新名称');
  assert.equal(await sidebar.locator('.screen-name').first().textContent(),'卡片新名称');
  await card.locator('.card-screen-name').click();await input.fill('卡片失焦保存');await heading.locator('small').click();
  await input.waitFor({state:'detached'});assert.equal(project.screens[0].name,'卡片失焦保存');
  assert.deepEqual(project.screens.map(screen=>screen.versions),versions);
  await inventory.hover();await menu.locator('summary').click();
  await menu.getByRole('button',{name:'复制界面：侧栏名称',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.screen-row').length===4);
  assert.deepEqual(copyRequests,[{projectId:project.id,screenId:'screen-1'}]);
  const copied=sidebar.locator('.screen-row').last();await copied.hover();await copied.locator('summary').click();
  await copied.getByRole('button',{name:'删除界面：侧栏名称 副本',exact:true}).click();
  const deletion=page.getByRole('dialog',{name:'删除界面',exact:true});await deletion.waitFor();
  assert.equal(project.screens.length,4);await deletion.getByRole('button',{name:'取消',exact:true}).click();
  await copied.hover();await copied.locator('summary').click();await copied.getByRole('button',{name:'删除界面：侧栏名称 副本',exact:true}).click();
  await deletion.getByRole('button',{name:'确认删除',exact:true}).click();await deletion.waitFor({state:'detached'});
  await page.reload();await page.locator('.home-project-open').click();
  assert.deepEqual(await sidebar.locator('.screen-name').allTextContents(),['卡片失焦保存','侧栏名称','设置']);
  assert.deepEqual(project.screens.map(screen=>screen.versions),versions);
  console.log('PASS hover menu/copy/delete confirmation, sidebar rename/cancel/blank guard, inline title Enter/blur/Esc, stable header size, synchronized names and persisted versions; project APIs mocked');
} finally {await browser.close();}
