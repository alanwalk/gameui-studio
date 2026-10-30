import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {chromium} from 'playwright';
const directory=await fs.mkdtemp('./.data/drawing-history-');
const longPrompt=Array.from({length:100},(_,index)=>`第${index+1}行：完整提示词应可滚动阅读，不能编辑。`).join('\n');
const tasks=[{id:'11111111-1111-4111-8111-111111111111',prompt:longPrompt,references:[],ratio:'1:1',size:'1024x1024',status:'failed',createdAt:2,updatedAt:2},
 {id:'22222222-2222-4222-8222-222222222222',prompt:'第二条记录\n另一段完整提示词',references:[],ratio:'1:1',size:'1024x1024',status:'failed',createdAt:1,updatedAt:1}];
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1920,height:940}});
 await page.route('**/api/drawing/state',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({tasks,images:[]})}));
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:5174/');await page.getByRole('button',{name:'画图工具',exact:true}).click();
 const prompt=page.getByLabel('选中记录的完整提示词',{exact:true});await prompt.waitFor();
 assert.equal(await prompt.inputValue(),longPrompt);assert.equal(await prompt.getAttribute('readonly'),'');
 const geometry=await page.locator('.drawing-history').evaluate(element=>({w:element.clientWidth,scroll:element.scrollWidth,rows:[...element.children].map(child=>{const box=child.getBoundingClientRect();return {x:box.x,y:box.y,w:box.width,h:box.height};})}));
 assert.ok(geometry.scroll<=geometry.w+1,'no horizontal overflow');
 assert.equal(geometry.rows[0].x,geometry.rows[1].x);assert.ok(geometry.rows[1].y>=geometry.rows[0].y+geometry.rows[0].h);
 assert.ok(await prompt.evaluate(element=>element.clientHeight<=200&&element.scrollHeight>element.clientHeight));
 await prompt.evaluate(element=>{element.scrollTop=200;});
 assert.ok(await prompt.evaluate(element=>element.scrollTop>0));
 await page.locator('.drawing-history>button').nth(1).click();
 assert.equal(await prompt.inputValue(),tasks[1].prompt);assert.equal(await prompt.evaluate(element=>element.scrollTop),0);
 assert.equal(await page.locator('.drawing-history>button').nth(1).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:directory+'/history.png'});assert.deepEqual(errors,[]);
 console.log('PASS vertical history, brief summaries/no horizontal overflow, complete read-only scrollable prompt and selection reset; '+directory);
}finally{await browser.close();}
