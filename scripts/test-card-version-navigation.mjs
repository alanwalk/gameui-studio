import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const versions=Array.from({length:16},(_,index)=>({id:`version-${index}`,image:`version-${index}.png`,prompt:'',createdAt:index+1}));
let project={id:'version-navigation',name:'版本切换测试',size:{w:1080,h:1920},orientation:'portrait',stylePrompt:'',createdAt:1,updatedAt:1,
  screens:[{id:'screen',name:'首页',usage:'',layout:[],versions,activeVersionId:versions[1].id}]};
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1440,height:940}});
  await page.route('**/api/project-render/tasks',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/projects',async route=>{
    if(route.request().method()==='PUT') project=route.request().postDataJSON().project;
    await route.fulfill({contentType:'application/json',body:JSON.stringify({projects:[project]})});
  });
  await page.goto('http://127.0.0.1:5174/');
  await page.locator('.home-project-open').click();
  const card=page.locator('.screen-card');
  assert.equal(await card.getByRole('button',{name:'版本与详情',exact:true}).count(),0);
  assert.equal(await page.getByRole('dialog',{name:'版本与详情',exact:true}).count(),0);
  const previous=card.getByRole('button',{name:'上一个版本',exact:true});
  const next=card.getByRole('button',{name:'下一个版本',exact:true});
  await previous.click();
  await page.waitForFunction(()=>document.querySelector('.ver-dot.active')?.textContent==='V1');
  assert.equal(await previous.isDisabled(),false);
  assert.equal(await next.isDisabled(),false);
  await previous.click();
  await page.waitForFunction(()=>document.querySelector('.ver-dot.active')?.textContent==='V16');
  await next.click();
  await page.waitForFunction(()=>document.querySelector('.ver-dot.active')?.textContent==='V1');
  await next.click();
  await page.waitForFunction(()=>document.querySelector('.ver-dot.active')?.textContent==='V2');
  assert.ok((await card.locator('.screen-preview-frame > img').getAttribute('src')).includes(versions[1].image));
  await card.locator('.ver-dot').last().click();
  await page.waitForFunction(()=>document.querySelector('.ver-dot.active')?.textContent==='V16');
  assert.equal(await next.isDisabled(),false);
  assert.equal(await previous.isDisabled(),false);
  await previous.click();
  await page.waitForFunction(()=>document.querySelector('.ver-dot.active')?.textContent==='V15');
  const tabs=card.locator('.card-version-tabs');
  assert.ok(await tabs.evaluate(el=>el.scrollLeft>0));
  const selected=await card.locator('.ver-dot.active').boundingBox();
  const list=await tabs.boundingBox();
  assert.ok(selected.x>=list.x-1 && selected.x+selected.width<=list.x+list.width+1);
  assert.ok(await previous.evaluate(el=>{
    const box=el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(box.x+box.width/2,box.y+box.height/2));
  }));
  await page.waitForFunction(()=>!document.body.textContent.includes('正在保存项目修改'));
  await page.reload();await page.locator('.home-project-open').click();
  await page.waitForFunction(()=>document.querySelector('.ver-dot.active')?.textContent==='V15');
  console.log('PASS circular previous/next versions across both boundaries, result changes, scrolling tabs keep active visible, fixed arrows and refresh; project API mocked');
} finally {await browser.close();}
