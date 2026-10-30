import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const directory=await fs.mkdtemp('./.data/drawing-resolutions-');
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let submitted;
 await page.route('**/api/drawing/tasks',async route=>{
   submitted=route.request().postDataJSON();
   await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({tasks:[],images:[]})});
 });
 await page.goto('http://127.0.0.1:5174/');
 await page.getByRole('button',{name:'画图工具',exact:true}).click();
 const styleResponse=await page.request.get('http://127.0.0.1:5174/api/styles');
 const {styles}=await styleResponse.json();
 if(styles.length) {
   const style=styles.find(entry=>entry.image) ?? styles[0];
   await page.getByRole('button',{name:'选择画图风格',exact:true}).click();
   const picker=page.getByRole('dialog',{name:'选择画图风格',exact:true});
   const choice=picker.getByRole('button',{name:`使用风格：${style.name}`,exact:true});
   if(style.image) {
     await choice.locator('img').evaluate(image=>image.decode());
     assert.ok(await choice.locator('img').evaluate(image=>image.naturalWidth>0));
   }
   await choice.click();
   assert.ok((await page.locator('#drawing-prompt').inputValue()).includes(style.prompt));
   assert.ok((await page.getByRole('button',{name:'选择画图风格',exact:true}).innerText()).includes(style.name));
   assert.equal(await picker.count(),0);
 }
 const resolution=page.getByLabel('画图分辨率',{exact:true});
 assert.equal(await resolution.locator('option').count(),13);
 await resolution.selectOption('1920x1080');
 await resolution.selectOption('custom');
 await page.getByLabel('画图宽度').fill('1600');
 await page.getByLabel('画图高度').fill('900');
 await page.locator('#drawing-prompt').fill('resolution fixture');
 await page.getByRole('button',{name:'✦ 生成图片',exact:true}).click();
 await page.waitForTimeout(100);
 assert.equal(submitted.size,'1600x900');
 assert.equal(submitted.ratio,'custom');
 await page.reload();
 await page.getByRole('button',{name:'画图工具',exact:true}).click();
 assert.equal(await page.getByLabel('画图宽度').inputValue(),'1600');
 assert.equal(await page.getByLabel('画图高度').inputValue(),'900');
 await page.screenshot({path:directory+'/custom-size.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS 12 presets, custom dimensions, exact submitted size and draft reload; no paid request; '+directory);
} finally {await browser.close();}
