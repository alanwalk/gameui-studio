import assert from 'node:assert/strict';
import {chromium} from 'playwright';

let project={id:'delete-confirmation',name:'确认删除测试',size:{w:1080,h:1920},orientation:'portrait',stylePrompt:'',createdAt:1,updatedAt:1,
  screens:['首页','背包','设置'].map((name,index)=>({id:`screen-${index}`,name,usage:'',layout:[],versions:[]}))};
const writes=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:815,height:859}});
  await page.route('**/api/project-render/tasks',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/projects',async route=>{
    if(route.request().method()==='PUT') {
      project=route.request().postDataJSON().project;
      writes.push(structuredClone(project));
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({projects:[project]})});
  });
  await page.goto('http://127.0.0.1:5174/');await page.locator('.home-project-open').click();
  const add=page.locator('.sidebar-add-screen');await add.waitFor();
  assert.deepEqual(await add.evaluate(el=>[getComputedStyle(el).marginTop,getComputedStyle(el).marginBottom]),['16px','16px']);
  const bounds=await add.boundingBox();
  const sidebar=await page.locator('.sidebar').boundingBox();
  const body=await page.locator('.sidebar-body').boundingBox();
  assert.ok(Math.abs((bounds.y-sidebar.y)-(body.y-bounds.y-bounds.height))<1);
  const settings=page.locator('.screen-row').filter({has:page.locator('.screen-name').filter({hasText:'设置'})});
  const openDelete=async(row,name)=>{
    await row.hover();await row.locator('summary').click();await row.getByRole('button',{name:`删除界面：${name}`,exact:true}).click();
  };
  await openDelete(settings,'设置');
  const confirmation=page.getByRole('dialog',{name:'删除界面',exact:true});await confirmation.waitFor();
  assert.equal(writes.length,0,'clicking delete only opens confirmation');
  assert.ok((await confirmation.textContent()).includes('设置'));
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(writes.length,0);assert.equal(await page.locator('.screen-row').count(),3);
  await openDelete(settings,'设置');
  await page.keyboard.press('Escape');await confirmation.waitFor({state:'detached'});
  assert.equal(writes.length,0);
  await openDelete(settings,'设置');
  await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();await confirmation.waitFor({state:'detached'});
  assert.equal(writes.length,1);assert.deepEqual(project.screens.map(screen=>screen.name),['首页','背包']);
  assert.equal(await page.locator('.screen-row.active .screen-name').textContent(),'首页');
  const inventory=page.locator('.screen-row').filter({has:page.locator('.screen-name').filter({hasText:'背包'})});
  await inventory.locator('.screen-pick').click();
  await openDelete(inventory,'背包');
  await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();await confirmation.waitFor({state:'detached'});
  assert.equal(await page.locator('.screen-row.active .screen-name').textContent(),'首页');
  const remaining=page.locator('.screen-row');await remaining.hover();await remaining.locator('summary').click();
  assert.equal(await page.getByRole('button',{name:'删除界面：首页',exact:true}).isDisabled(),true);
  await page.reload();await page.locator('.home-project-open').click();
  assert.equal(await page.locator('.screen-row').count(),1);
  console.log('PASS delete confirmation/cancel/Escape/no early write, confirmed deletion, active-screen fallback, keep last screen, reload and equal button margins; project API mocked');
} finally {await browser.close();}
