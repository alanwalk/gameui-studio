import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const base='http://127.0.0.1:5174';const id='test-draft-'+randomUUID();const name='草稿测试 '+id;
const directory=await fs.mkdtemp('./.data/layout-draft-');
async function api(body,method='PUT'){
 const response=await fetch(base+'/api/projects',body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 assert.ok(response.ok);return response.json();
}
const original=[{id:'node',name:'Original',kind:'button',parentId:null,rect:{x:.2,y:.2,w:.3,h:.1}}];
await api({project:{id,name,orientation:'portrait',size:{w:800,h:1200},stylePrompt:'',createdAt:1,updatedAt:1,screens:[{id:id+'-screen',name:'界面',usage:'',layout:original,versions:[]}]}});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let writes=0;page.on('request',request=>{if(request.url().endsWith('/api/projects')&&request.method()==='PUT')writes++;});
 const stored=async()=>(await api()).projects.find(project=>project.id===id).screens[0];
 await page.goto(base);await page.locator('.home-project-open').filter({hasText:name}).click();
 const card=page.locator('.screen-card').first();
 const open=async()=>{await card.locator('.screen-preview-frame').first().hover();await card.getByRole('button',{name:'编辑布局',exact:true}).click();};
 await open();
 const editor=page.getByRole('dialog',{name:'布局编辑器',exact:true});
 assert.equal(await editor.getByRole('button',{name:'导出资源',exact:true}).count(),0);
 assert.equal(await editor.getByRole('button',{name:'使用布局',exact:true}).count(),0);
 assert.equal(await editor.locator('.stage-toolbar').count(),0);
 await editor.locator('.layout-tree-pick').filter({hasText:'Original'}).click();
 await editor.locator('.node-properties').getByLabel('名称',{exact:true}).fill('Discard me');
 assert.deepEqual((await stored()).layout,original);assert.equal(writes,0);
 await editor.locator('.studio-dialog-header').getByRole('button',{name:'撤销',exact:true}).click();
 assert.equal(await editor.locator('.node-properties').getByLabel('名称',{exact:true}).inputValue(),'Original');
 await editor.locator('.studio-dialog-header').getByRole('button',{name:'重做',exact:true}).click();
 assert.equal(await editor.locator('.node-properties').getByLabel('名称',{exact:true}).inputValue(),'Discard me');
 page.once('dialog',dialog=>dialog.dismiss());await editor.getByRole('button',{name:'不保存关闭'}).click();assert.equal(await editor.count(),1);
 page.once('dialog',dialog=>dialog.accept());await editor.getByRole('button',{name:'不保存关闭'}).click();await editor.waitFor({state:'detached'});
 assert.deepEqual((await stored()).layout,original);assert.equal(writes,0);
 await open();await editor.locator('.layout-tree-pick').filter({hasText:'Original'}).click();
 await editor.locator('.node-properties').getByLabel('名称',{exact:true}).fill('Saved');
 assert.equal(writes,0);
 let failNextSave=true;
 await page.route('**/api/projects',async route=>{
   if(route.request().method()==='PUT' && failNextSave) {failNextSave=false;await route.abort();}
   else await route.continue();
 });
 await editor.getByRole('button',{name:'保存关闭',exact:true}).click();
 await page.getByText('保存线稿失败：',{exact:false}).first().waitFor();
 assert.deepEqual((await stored()).layout,original,'failed apply must not publish draft');
 page.once('dialog',dialog=>dialog.accept());await editor.getByRole('button',{name:'不保存关闭'}).click();await editor.waitFor({state:'detached'});
 await open();await editor.locator('.layout-tree-pick').filter({hasText:'Original'}).click();
 await editor.locator('.node-properties').getByLabel('名称',{exact:true}).fill('Saved');
 await editor.getByRole('button',{name:'保存关闭',exact:true}).click();await editor.waitFor({state:'detached'});
 assert.equal((await stored()).layout[0].name,'Saved');assert.equal(writes,2);
 await page.reload();await page.locator('.home-project-open').filter({hasText:name}).click();await open();
 await editor.locator('.layout-tree-pick').filter({hasText:'Saved'}).waitFor();
 await page.screenshot({path:directory+'/header.png'});assert.deepEqual(errors,[]);
 page.once('dialog',dialog=>dialog.accept());await page.keyboard.press('Escape');await editor.waitFor({state:'detached'});
 console.log('PASS no export/extra row, local-only editing, draft undo/redo, discard confirmation/dismiss/Escape, single save and reload; '+directory);
}finally{await browser.close();await api({id},'DELETE');}
