import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {chromium} from 'playwright';
const base='http://127.0.0.1:5174';
const directory=await fs.mkdtemp('./.data/style-actions-');
const id='test-style-'+randomUUID();const name='风格验证 '+id;
const png=await sharp({create:{width:8,height:6,channels:4,background:'#b85533'}}).png().toBuffer();
async function api(route,body,method='PUT') {
 const response=await fetch(base+route,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 assert.ok(response.ok);return response.json();
}
const styles=async()=>(await api('/api/styles')).styles;
const browser=await chromium.launch({channel:'msedge',headless:true});
let copiedId;
try {
 await api('/api/styles',{style:{id,name,prompt:'original prompt',createdAt:Date.now(),updatedAt:Date.now()}});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.getByRole('button',{name:'我的风格库',exact:true}).click();
 const card=page.locator('.style-card').filter({has:page.getByRole('heading',{name,exact:true})});
 await card.waitFor();
 assert.deepEqual(await card.locator('.style-card-actions button').allTextContents(),['编辑','复制','删除']);
 assert.equal(await card.locator('input[type=file]').count(),0);
 await card.getByRole('button',{name:'编辑',exact:true}).click();
 const dialog=page.getByRole('main',{name:'编辑风格',exact:true});
 await dialog.locator('input[type=file]').setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:png});
 assert.equal((await styles()).find(style=>style.id===id).image,undefined,'choosing a file does not save immediately');
 await dialog.getByRole('button',{name:'取消编辑',exact:true}).click();
 assert.equal((await styles()).find(style=>style.id===id).image,undefined,'cancel leaves saved style untouched');
 await card.getByRole('button',{name:'编辑',exact:true}).click();
 await dialog.locator('input[type=file]').setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:png});
 await dialog.getByLabel('风格提示词',{exact:true}).fill('updated prompt');
 await dialog.getByRole('button',{name:'保存到风格库',exact:true}).click();
 await dialog.waitFor({state:'detached'});
 const saved=(await styles()).find(style=>style.id===id);
 assert.ok(saved.image);assert.equal(saved.prompt,'updated prompt');
 await card.getByRole('button',{name:'复制',exact:true}).click();
 const copyCard=page.locator('.style-card').filter({has:page.getByRole('heading',{name:name+' 副本',exact:true})});
 await copyCard.waitFor();
 const copy=(await styles()).find(style=>style.name===name+' 副本');copiedId=copy.id;
 assert.notEqual(copy.id,id);assert.equal(copy.image,saved.image);assert.equal(copy.prompt,saved.prompt);
 assert.deepEqual((await styles()).find(style=>style.id===id),saved);
 await page.screenshot({path:directory+'/actions.png'});
 page.once('dialog',dialog=>dialog.accept());
 await copyCard.getByRole('button',{name:'删除',exact:true}).click();
 await copyCard.waitFor({state:'detached'});
 assert.equal((await styles()).some(style=>style.id===copiedId),false);
 assert.deepEqual(errors,[]);
 console.log('PASS edit/copy/delete actions, staged image replacement, cancel, combined save and source isolation; '+directory);
} finally {
 await browser.close();
 await api('/api/styles',{id},'DELETE');
 if(copiedId && (await styles()).some(style=>style.id===copiedId)) await api('/api/styles',{id:copiedId},'DELETE');
}
