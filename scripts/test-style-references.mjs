import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import sharp from 'sharp';
import {chromium} from 'playwright';
const directory=await fs.mkdtemp(path.resolve('.data/style-references-'));
process.env.GAMEUI_DATA=path.join(directory,'isolated-api');
const bundle=path.join(directory,'api.mjs');
await build({entryPoints:['server/styleApi.ts'],outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external'});
const {createStyleHandler}=await import(pathToFileURL(bundle));
let analyses=0;
const handler=createStyleHandler(async()=>{analyses++;return JSON.stringify({name:'analysis-only',prompt:'fixture prompt'});});
const server=http.createServer((req,res)=>{void handler(req,res,()=>{res.statusCode=404;res.end();});});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const isolated='http://127.0.0.1:'+server.address().port;
const png=await sharp({create:{width:12,height:16,channels:4,background:'#5588aa'}}).png().toBuffer();
async function post(base,route,body,method='POST') {
 const response=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.ok(response.ok,await response.clone().text());return response.json();
}
try {
 const refs=[];
 for(let index=0;index<3;index++) refs.push((await post(isolated,'/api/style-generation/reference',{dataUrl:'data:image/png;base64,'+png.toString('base64')})).fileName);
 const result=await post(isolated,'/api/style-generation/analyze',{description:'fixture',referenceImages:refs});
 assert.equal(analyses,1);assert.equal(result.prompt,'fixture prompt');assert.deepEqual(result.drawingReferences,[]);
 await assert.rejects(fs.access(path.join(process.env.GAMEUI_DATA,'drawing')),'analysis must not create drawing records');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
const base='http://127.0.0.1:5174';const name='多参考测试 '+randomUUID();
const browser=await chromium.launch({channel:'msedge',headless:true});
let savedId;
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let imageRequests=0;
 await page.route('**/api/drawing/tasks',async route=>{imageRequests++;await route.abort();});
 await page.route('**/api/style-generation/analyze',async route=>route.fulfill({contentType:'application/json',body:JSON.stringify({name,prompt:'multi reference fixture',drawingReferences:[]})}));
 await page.goto(base);await page.getByRole('button',{name:'风格库',exact:true}).click();
 await page.getByRole('button',{name:'AI 创建 / 提取画风',exact:true}).click();
 const ai=page.getByRole('dialog',{name:'AI 创建画风',exact:true});
 await ai.locator('input[type=file]').setInputFiles([{name:'a.png',mimeType:'image/png',buffer:png},{name:'b.png',mimeType:'image/png',buffer:png}]);
 await page.waitForFunction(()=>document.querySelectorAll('.style-generator-refs figure').length===2);
 await ai.getByRole('button',{name:'AI 分析画风',exact:true}).click();
 await ai.getByRole('button',{name:'保存 AI 画风到风格库',exact:true}).click();
 const card=page.locator('.style-card').filter({has:page.getByRole('heading',{name,exact:true})});await card.waitFor();
 let styles=(await fetch(base+'/api/styles').then(response=>response.json())).styles;
 let saved=styles.find(style=>style.name===name);savedId=saved.id;
 assert.equal(saved.referenceImages.length,2);assert.equal(saved.image,saved.referenceImages[0]);assert.equal(imageRequests,0);
 await page.keyboard.press('Escape');
 await card.getByRole('button',{name:'编辑',exact:true}).click();
 const editor=page.getByRole('dialog',{name:'编辑风格',exact:true});
 assert.equal(await editor.locator('.style-edit-references figure').count(),2);
 const buttons=editor.locator('.style-form-actions button');
 const boxes=await buttons.evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return {x:box.x,w:box.width,h:box.height};}));
 assert.equal(boxes[0].h,boxes[1].h);assert.ok(boxes[1].x-boxes[0].x-boxes[0].w>=10);
 await editor.locator('.style-edit-references button').first().click();
 await editor.locator('input[type=file]').setInputFiles([{name:'c.png',mimeType:'image/png',buffer:png},{name:'d.png',mimeType:'image/png',buffer:png}]);
 await editor.getByRole('button',{name:'保存到风格库',exact:true}).click();await editor.waitFor({state:'detached'});
 styles=(await fetch(base+'/api/styles').then(response=>response.json())).styles;saved=styles.find(style=>style.id===savedId);
 assert.equal(saved.referenceImages.length,3);assert.equal(saved.image,saved.referenceImages[0]);assert.equal(imageRequests,0);
 await page.reload();await page.getByRole('button',{name:'风格库',exact:true}).click();
 await card.getByRole('button',{name:'编辑',exact:true}).click();
 assert.equal(await editor.locator('.style-edit-references figure').count(),3);
 await page.screenshot({path:directory+'/multi-reference-edit.png'});assert.deepEqual(errors,[]);
 console.log('PASS analysis creates no drawing tasks; original multi-reference save/edit/reload; equal action heights and spacing; '+directory);
}finally{await browser.close();if(savedId)await post(base,'/api/styles',{id:savedId},'DELETE');}
