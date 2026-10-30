import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';

const directory=await fs.mkdtemp('./.data/render-notifications-');
const project={id:'notice-project',name:'通知测试',size:{w:1080,h:1920},orientation:'portrait',stylePrompt:'',createdAt:1,updatedAt:1,
  screens:[{id:'notice-screen',name:'首页',usage:'',layout:[],versions:[]}]};
const failed={id:'v-11111111-1111-4111-8111-111111111111',projectId:project.id,screenId:'notice-screen',operation:'refine',
  sourceVersionId:'original',sourceImage:'source.png',prompt:'保留布局，更换按钮颜色',styleSnapshot:{prompt:'卡通'},size:'1080x1920',
  status:'interrupted',error:'生成返回图宽高比与请求画布不符',createdAt:1};
project.screens[0].versions.push({id:failed.id,prompt:failed.prompt,operation:'refine',parentVersionId:'original',styleSnapshot:failed.styleSnapshot,createdAt:1});
let tasks=[failed];
let projectWrites=0;
let retries=[];
let failNextRetry=false;
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:782,height:884}});
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('dialog',()=>{throw new Error('Retry must not depend on a native browser confirmation dialog');});
  await page.route('**/api/projects',async route=>{
    if(route.request().method()==='PUT') {
      projectWrites++;
      Object.assign(project,route.request().postDataJSON().project);
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({projects:[project]})});
  });
  await page.route('**/api/project-render/tasks',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(tasks)}));
  await page.route('**/api/project-render/tasks/*/retry',async route=>{
    const request=route.request().postDataJSON();
    retries.push(request);
    if(failNextRetry) {
      failNextRetry=false;
      await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟连接失败'})});
      return;
    }
    const reserved=project.screens[0].versions.find(version=>version.id===request.newId);
    assert.ok(reserved,'must save a version before requesting retry');
    assert.equal(reserved.prompt,failed.prompt);
    const queued={...failed,id:request.newId,status:'queued',error:undefined,createdAt:2};
    tasks=[failed,queued];
    await route.fulfill({contentType:'application/json',body:JSON.stringify(queued)});
  });
  await page.goto('http://127.0.0.1:5174/');
  const notice=page.locator('.render-task-notice');
  await notice.waitFor();
  await page.locator('.home-project-open').click();
  const failureReason=page.locator('.preview-failure-reason');
  await failureReason.waitFor();
  assert.ok((await failureReason.textContent()).includes(failed.error), 'failed preview must show the persisted task error');
  await page.getByRole('button',{name:'返回首页',exact:true}).click();
  await page.getByRole('main',{name:'首页',exact:true}).waitFor();
  assert.equal(await page.getByRole('navigation',{name:'主导航',exact:true}).count(),0);
  assert.equal(await page.locator('.home-shortcuts svg').count(),2);
  await notice.getByRole('button',{name:'关闭任务通知',exact:true}).click();
  assert.equal(await notice.count(),0);
  await page.reload();
  await page.getByRole('main',{name:'首页',exact:true}).waitFor();
  await page.waitForTimeout(1200);
  assert.equal(await notice.count(),0,'polling and refresh must not reopen a dismissed unchanged task');
  await page.evaluate(()=>sessionStorage.removeItem('gameui-dismissed-render-notices'));
  await page.reload();await notice.waitFor();
  await notice.getByRole('button',{name:'重新生成',exact:true}).click();
  const confirm=page.getByRole('dialog',{name:'确认重新生成',exact:true});
  await confirm.waitFor();
  await confirm.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(retries.length,0);assert.equal(projectWrites,0);
  await notice.getByRole('button',{name:'重新生成',exact:true}).click();
  failNextRetry=true;
  await confirm.getByRole('button',{name:'确认重新生成',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'模拟连接失败'}).waitFor();
  assert.equal(await confirm.count(),1,'failed retry retains its confirmation dialog');
  const reservedCount=project.screens[0].versions.length;
  await confirm.getByRole('button',{name:'确认重新生成',exact:true}).click();
  await confirm.waitFor({state:'detached'});
  assert.equal(retries.length,2);
  assert.equal(retries[0].newId,retries[1].newId,'repeat a failed submission with the same idempotency ID');
  assert.equal(project.screens[0].versions.length,reservedCount,'no duplicate reservation');
  assert.equal(retries[1].confirmNewCharge,true);
  assert.equal(await notice.filter({hasText:failed.error}).count(),0,'successful retry retires the old error notification');
  await page.screenshot({path:directory+'/retry.png'});
  await page.getByRole('button',{name:'画图工具',exact:true}).click();
  await page.locator('.drawing-tool').waitFor();
  await page.getByRole('button',{name:'返回首页',exact:true}).click();
  await page.getByRole('main',{name:'首页',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('PASS dismiss/poll/reload, inline retry confirmation/cancel/failure/recovery, idempotent reservation, removed nav, tool SVGs and back navigation; all project/render calls mocked; '+directory);
} finally { await browser.close(); }
