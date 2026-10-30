import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {chromium} from 'playwright';
const directory=await fs.mkdtemp('./.data/project-settings-');
const browser=await chromium.launch({channel:'msedge',headless:true});
const base='http://127.0.0.1:5174';
const id='test-settings-'+randomUUID();
const name='设置验证 '+id;
const styleA={id:'test-style-'+randomUUID(),name:'童趣森林 '+id.slice(-4),prompt:'明亮、饱满、亲切的卡通奇幻世界。',createdAt:Date.now(),updatedAt:Date.now()};
const styleB={id:'test-style-'+randomUUID(),name:'冷色科幻 '+id.slice(-4),prompt:'冷蓝金属材质与高对比霓虹光。',createdAt:Date.now(),updatedAt:Date.now()};
async function save(body,method='PUT') {
 const response=await fetch(base+'/api/projects',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.ok(response.ok);return response.json();
}
async function saveStyle(style) {
 const response=await fetch(base+'/api/styles',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({style})});
 assert.ok(response.ok);return response.json();
}
async function deleteStyle(styleId) {
 const response=await fetch(base+'/api/styles',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:styleId})});
 assert.ok(response.ok);return response.json();
}
async function uploadStyleImage(color) {
 const png=await sharp({create:{width:96,height:96,channels:4,background:color}}).png().toBuffer();
 const response=await fetch(base+'/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({image:`data:image/png;base64,${png.toString('base64')}`,prefix:'style-test'})});
 assert.ok(response.ok);const payload=await response.json();assert.ok(payload.fileName);return payload.fileName;
}
try {
 styleA.image=await uploadStyleImage('#5f8d57');styleA.referenceImages=[styleA.image];
 styleB.image=await uploadStyleImage('#315d89');styleB.referenceImages=[styleB.image];
 await saveStyle(styleA);await saveStyle(styleB);
 await save({project:{id,name,orientation:'portrait',size:{w:1080,h:1920},stylePrompt:'',screens:[{id:id+'-screen',name:'界面',usage:'',layout:[],versions:[]}],createdAt:Date.now(),updatedAt:Date.now()}});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);
 await page.locator('.home-project-open').filter({hasText:name}).click();
 assert.equal(await page.getByLabel('画布宽度').count(),0,'resolution is read-only outside settings');
 assert.equal(await page.getByLabel('项目名称').count(),0,'name is read-only outside settings');
 await page.getByRole('button',{name:'项目设置',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'项目设置',exact:true});
 await dialog.getByLabel('项目名称',{exact:true}).fill(name+' 已修改');
 await dialog.getByLabel('画布宽度').fill('800');
 await dialog.getByLabel('画布高度').fill('600');
 await dialog.getByRole('button',{name:'设置分辨率',exact:true}).click();
 assert.ok(await dialog.locator('.project-style-card').count()>=2);
 assert.equal(await dialog.locator('textarea').count(),0);
 const styleCard=dialog.getByRole('button',{name:styleA.name,exact:true});
 assert.equal(await styleCard.locator('img').count(),1);
 assert.equal((await styleCard.innerText()).trim(),styleA.name);
 await styleCard.click();
 await page.waitForFunction(styleName=>document.querySelector('.project-style-card[aria-pressed=true] .project-style-title')?.textContent===styleName,styleA.name);
 await page.waitForFunction(styleName=>document.body.textContent.includes(`已应用风格「${styleName}」`),styleA.name);
 await dialog.getByRole('button',{name:'关闭项目设置'}).click();
 await page.reload();
 await page.locator('.home-project-open').filter({hasText:name+' 已修改'}).click();
 assert.ok((await page.locator('.proj-title').innerText()).includes('800 × 600'));
 assert.ok((await page.locator('.proj-title').innerText()).includes(styleA.name));
 await page.getByRole('button',{name:'项目设置',exact:true}).click();
 assert.equal(await dialog.getByLabel('项目名称',{exact:true}).inputValue(),name+' 已修改');
 assert.equal(await dialog.getByLabel('画布宽度').inputValue(),'800');
 assert.equal(await dialog.getByRole('button',{name:styleA.name,exact:true}).getAttribute('aria-pressed'),'true');
 await page.screenshot({path:directory+'/settings.png'});
 assert.deepEqual(errors,[]);
 console.log('PASS read-only summary, unified dialog, name/resolution, two-column image/title style gallery and reload; '+directory);
} finally {
 await browser.close();
 await save({id},'DELETE');
 await deleteStyle(styleA.id);
 await deleteStyle(styleB.id);
}
