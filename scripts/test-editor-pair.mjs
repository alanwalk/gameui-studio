import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {chromium} from 'playwright';
const base='http://127.0.0.1:5174';
const directory=await fs.mkdtemp('./.data/editor-pair-');
const id='test-editors-'+randomUUID();const name='编辑器验证 '+id;
async function api(route,body,method='PUT') {
 const response=await fetch(base+route,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 assert.ok(response.ok,await response.clone().text());return response.json();
}
const upload=async(width,height,color)=>(await api('/api/upload',{image:'data:image/png;base64,'+(await sharp({create:{width,height,channels:4,background:color}}).png().toBuffer()).toString('base64')},'POST')).fileName;
const source=await upload(128,256,'#4499aa');const asset=await upload(80,40,'#cc3344');
for(const previous of (await api('/api/projects')).projects) {
 if(previous.id.startsWith('test-editors-') && previous.name==='编辑器验证 '+previous.id) await api('/api/projects',{id:previous.id},'DELETE');
}
const screenId=id+'-screen';const versionId=id+'-version';
await api('/api/projects',{project:{id,name,stylePrompt:'',orientation:'portrait',size:{w:128,h:256},createdAt:1,updatedAt:1,screens:[{
 id:screenId,name:'测试界面',usage:'',versions:[{id:versionId,image:source,prompt:'',createdAt:1}],activeVersionId:versionId,
 layout:[{id:'group',kind:'container',name:'Group',rect:{x:.1,y:.1,w:.8,h:.8}}, {id:'child',kind:'button',name:'Child',rect:{x:.2,y:.2,w:.2,h:.1}}],
}]}});
await api('/api/slice-tasks',{task:{schemaVersion:1,id:id+'-task',name:'fixture',source:{kind:'project',projectId:id,screenId,versionId,sourceImage:source},width:128,height:256,status:'done',createdAt:1,updatedAt:1,
 elements:[{id:'asset',kind:'button',label:'RedButton',objectName:'RedButton',state:'Normal',description:'',rect:{x:10,y:20,w:80,h:40},approved:true,needsAi:false,occluded:false,layer:1,extractionMethod:'manual',processingStatus:'done',
 slice:{image:asset,width:80,height:40,border:{bgColor:[0,0,0],sideScore:{top:1,right:1,bottom:1,left:1},dirtySides:[]}}}]}});
const browser=await chromium.launch({channel:'msedge',headless:true});let copiedId;
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.locator('.home-project-open').filter({hasText:name}).click();
 const presetImages=await page.evaluate(async()=>{
   const {renderWireframe}=await import('/src/lib/layout.ts');
   const results={};
   for(const [kind,presets] of Object.entries({container:['plain','dialog','card','list'],button:['plain','label','icon-label'],progress:['horizontal','vertical','radial'],text:['body','title']})) {
     results[kind]=presets.map(preset=>{
       const canvas=renderWireframe([{id:'node',name:'node',kind,preset,text:'Confirm',rect:{x:.1,y:.1,w:.8,h:.8}}],300,200);
       const pixel=canvas.getContext('2d').getImageData(0,0,1,1).data;
       if(pixel[0]!==255||pixel[1]!==255||pixel[2]!==255)throw Error('Wireframe background changed');
       return canvas.toDataURL();
     });
   }
   return results;
 });
 for(const images of Object.values(presetImages)) assert.equal(new Set(images).size,images.length,'presets must render distinct appearances');
 const card=page.locator('.screen-card').filter({hasText:'测试界面'});
 await card.locator('.screen-preview-frame').first().hover();await card.getByRole('button',{name:'编辑布局',exact:true}).click();
 const layout=page.getByRole('dialog',{name:'布局编辑器',exact:true});
 assert.equal(await layout.locator('.col.right').getByRole('button',{name:'AI 规划线稿',exact:true}).count(),1);
 assert.equal(await layout.locator('.col.right').getByRole('button',{name:'清空线稿',exact:true}).count(),1);
 assert.equal(await layout.locator('.col.right').getByRole('heading',{name:'添加节点',exact:true}).count(),0);
 await layout.getByLabel('添加节点',{exact:true}).click();
 assert.equal(await layout.getByRole('menuitem').count(),7);
 await layout.getByLabel('添加节点',{exact:true}).click();
 await layout.locator('.layout-tree-pick').filter({hasText:'Child'}).click();
 assert.equal(await layout.locator('.col.right').getByRole('button',{name:'AI 规划线稿',exact:true}).count(),0,'selected node shows only its properties');
 assert.equal(await layout.getByRole('treeitem').count(),2);
 assert.equal(await layout.getByRole('treeitem').first().getAttribute('aria-expanded'),'true');
 const white=await layout.locator('.wire-canvas').evaluate(canvas=>[...canvas.getContext('2d').getImageData(3,3,1,1).data]);
 assert.deepEqual(white,[255,255,255,255]);
 const before=await layout.locator('.wire-canvas').evaluate(canvas=>canvas.toDataURL());
 await layout.getByLabel('节点预设',{exact:true}).selectOption('icon-label');
 await layout.locator('.node-properties').getByLabel('文字',{exact:true}).fill('Confirm');
 await layout.locator('.node-properties').getByRole('button',{name:'右对齐',exact:true}).click();
 await layout.getByRole('button',{name:'保存关闭',exact:true}).click();
 await layout.waitFor({state:'detached'});
 const stored=(await api('/api/projects')).projects.find(project=>project.id===id);
 const child=stored.screens[0].layout.find(node=>node.id==='child');
 assert.equal(child.parentId,'group');assert.equal(child.preset,'icon-label');assert.equal(child.text,'Confirm');assert.ok(Math.abs(child.rect.x-.7)<.0001);
 await card.locator('.screen-preview-frame').first().hover();await card.getByRole('button',{name:'编辑布局',exact:true}).click();
 const after=await layout.locator('.wire-canvas').evaluate(canvas=>canvas.toDataURL());assert.notEqual(before,after);
 await layout.getByLabel('添加节点',{exact:true}).click();
 await layout.getByRole('menuitem',{name:'进度条',exact:true}).click();
 await layout.getByLabel('节点预设',{exact:true}).waitFor();
 await page.screenshot({path:directory+'/layout.png'});await layout.getByRole('button',{name:'保存关闭',exact:true}).click();
 await layout.waitFor({state:'detached'});
 const added=(await api('/api/projects')).projects.find(project=>project.id===id);
 assert.equal(added.screens[0].layout.length,3);assert.equal(added.screens[0].layout.at(-1).kind,'progress');
 const copy=await api('/api/projects/copy',{projectId:id},'POST');copiedId=copy.project.id;
 const copiedChild=copy.project.screens[0].layout.find(node=>node.name==='Child');
 assert.notEqual(copiedChild.parentId,'group');assert.ok(copy.project.screens[0].layout.some(node=>node.id===copiedChild.parentId));
 await card.locator('.screen-preview-frame').last().hover();await card.getByRole('button',{name:'编辑资源',exact:true}).click();
 const resources=page.getByRole('dialog',{name:'资源编辑器',exact:true});
 const left=resources.getByLabel('效果图画布',{exact:true});const right=resources.getByLabel('切图图集画布',{exact:true});
 await right.locator('img').evaluate(image=>image.decode());
 const leftBounds=await left.boundingBox();const rightBounds=await right.boundingBox();
 assert.ok(Math.abs(leftBounds.y-rightBounds.y)<2 && Math.abs(leftBounds.height-rightBounds.height)<2 && leftBounds.height>700,'both surfaces fill the same editor row');
 assert.equal(await resources.getByText('精准分割（MobileSAM）',{exact:true}).count(),0);
 const matrix=surface=>surface.locator('.panzoom-world').evaluate(element=>getComputedStyle(element).transform);
 const originalRight=await matrix(right);const originalLeft=await matrix(left);
 const box=await left.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.wheel(0,-200);await page.waitForTimeout(80);
 assert.notEqual(await matrix(left),originalLeft);assert.equal(await matrix(right),originalRight);
 const rightBox=await right.boundingBox();await page.mouse.move(rightBox.x+rightBox.width/2,rightBox.y+rightBox.height/2);await page.mouse.wheel(0,-150);await page.waitForTimeout(80);
 assert.notEqual(await matrix(right),originalRight);
 for(const surface of [left,right]) {
   const previous=await matrix(surface);const bounds=await surface.boundingBox();
   await page.mouse.move(bounds.x+30,bounds.y+60);
   await page.mouse.down();await page.mouse.move(bounds.x+70,bounds.y+100,{steps:6});await page.mouse.up();
   assert.notEqual(await matrix(surface),previous,'each pane independently pans');
 }
 await left.locator('.surface-fit').click();await right.locator('.surface-fit').click();
 await page.screenshot({path:directory+'/before-color.png'});
 await resources.getByRole('button',{name:'取色',exact:true}).click();
 await left.locator('img').click();assert.ok((await resources.locator('.color-readout').innerText()).includes('#4499AA'));
 await right.locator('img').click();assert.ok((await resources.locator('.color-readout').innerText()).includes('#CC3344'));
 assert.equal(await page.getByRole('dialog',{name:'素材修正',exact:true}).count(),0,'color pick must not open editor');
 await resources.getByRole('button',{name:'取色',exact:true}).click();
 await right.getByRole('button',{name:'预览 RedButton',exact:true}).click();await page.getByRole('dialog',{name:'素材修正',exact:true}).waitFor();await page.keyboard.press('Escape');
 assert.equal(await resources.count(),1,'closing sprite editor must keep resource editor open');
 await page.screenshot({path:directory+'/resources.png'});assert.deepEqual(errors,[]);
 console.log('PASS hierarchy/presets/alignment save, white canvas, copied parent IDs; independent asset zoom, atlas, both pixel pickers and sprite editor; '+directory);
}finally{
 await browser.close();await api('/api/projects',{id},'DELETE');if(copiedId)await api('/api/projects',{id:copiedId},'DELETE');
}
