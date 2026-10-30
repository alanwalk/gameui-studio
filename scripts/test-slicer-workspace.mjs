import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {build} from 'esbuild';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import sharp from 'sharp';
import JSZip from 'jszip';
import {chromium} from 'playwright';

const directory=await fs.mkdtemp(path.resolve('.data/slicer-workspace-'));
process.env.GAMEUI_DATA=path.join(directory,'store');
const apiBundle=path.join(directory,'api.mjs');
await build({entryPoints:['server/apiPlugin.ts'],outfile:apiBundle,bundle:true,platform:'node',format:'esm',packages:'external',
  plugins:[{name:'block-paid-provider',setup(builder){
    builder.onResolve({filter:/\/magpieMcp$/},()=>({path:'provider',namespace:'blocked'}));
    builder.onLoad({filter:/.*/,namespace:'blocked'},()=>({contents:`export const generateImage=()=>{throw Error('Unexpected paid request')}; export const waitForGeneration=generateImage;`,loader:'js'}));
  }}]});
const {magpieApi}=await import(pathToFileURL(apiBundle));
const server=await createServer({root:process.cwd(),configFile:false,plugins:[react(),magpieApi()],logLevel:'error',
  server:{host:'127.0.0.1',port:0,watch:{ignored:['**/.data/**','**/.venv-seg/**']}}});
await server.listen();
const base=`http://127.0.0.1:${server.httpServer.address().port}`;
async function api(route,body,method='PUT',ok=true) {
  const response=await fetch(base+route,body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
  assert.equal(response.ok,ok,await response.clone().text());return response.json();
}
const image=async(w,h,color)=>sharp({create:{width:w,height:h,channels:4,background:color}}).png().toBuffer();
const upload=async(buffer)=>(await api('/api/upload',{image:'data:image/png;base64,'+buffer.toString('base64')},'POST')).fileName;
const source=await upload(await image(128,256,'#4499aa'));
const red=await upload(await image(64,32,'#cc3344'));
const blue=await upload(await image(20,20,'#2255dd'));
const element=(id,label,file,width,height)=>({id,kind:'button',label,objectName:label,state:'Normal',description:'',
  rect:{x:16,y:24,w:width,h:height},approved:true,needsAi:false,occluded:false,layer:1,extractionMethod:'manual',processingStatus:'done',
  slice:{image:file,width,height,border:{bgColor:[0,0,0],sideScore:{top:1,right:1,bottom:1,left:1},dirtySides:[]}}});
const done={schemaVersion:1,id:randomUUID(),name:'已完成截图.png',source:{kind:'standalone',sourceImage:source},width:128,height:256,
  elements:[element('red','RedButton',red,64,32),element('blue','BlueIcon',blue,20,20)],status:'done',createdAt:Date.now()-1000,updatedAt:Date.now()};
const pendingSource=await upload(await image(128,256,'#556677'));
const interrupted={...done,id:randomUUID(),name:'待重试截图.png',source:{kind:'standalone',sourceImage:pendingSource},createdAt:done.createdAt-1000,
  status:'interrupted',elements:[{...element('retry','RetryButton',red,64,32),slice:undefined,extractionMethod:'segmentation',processingStatus:'failed'}]};
const projectTask={...done,id:randomUUID(),source:{kind:'project',projectId:'project',screenId:'screen',versionId:'version',sourceImage:source}};
await api('/api/slice-tasks',{task:done});await api('/api/slice-tasks',{task:interrupted});await api('/api/slice-tasks',{task:projectTask});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:1920,height:940}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/health',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({gateway:true,status:'测试'})}));
  await page.route('**/api/models',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({models:[]})}));
  await page.route('**/api/segment-health',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({available:true})}));
  await page.route('**/api/detect',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({content:JSON.stringify({elements:[
    {label:'NewButton',kind:'button',x:4,y:8,w:16,h:12,layer:1,description:'button',text:null}]})})}));
  await page.route('**/api/segment',async route=>{
    const body=route.request().postDataJSON();
    const response=await page.request.get(base+'/api/image?name='+encodeURIComponent(body.sourceImage));
    const pixels=await response.body();const meta=await sharp(pixels).metadata();
    const mask=await image(meta.width,meta.height,'white');
    await route.fulfill({contentType:'application/json',body:JSON.stringify({width:meta.width,height:meta.height,rgbaBase64:pixels.toString('base64'),maskBase64:mask.toString('base64')})});
  });
  await page.goto(base);await page.getByRole('button',{name:'切图工具',exact:true}).click();
  const tool=page.getByRole('main',{name:'切图工具',exact:true});
  const ready=tool.getByRole('button',{name:/已完成截图.png/});await ready.waitFor();
  await tool.getByRole('button',{name:'资源编辑',exact:true}).waitFor({state:'visible'});
  await page.waitForFunction(()=>!document.querySelector('.slicer-detail-actions button:not([aria-label])')?.disabled);
  assert.equal(await tool.locator('.slicer-task-row').count(),2,'project slices stay out of standalone task list');
  await tool.locator('.slicer-atlas-preview canvas').waitFor();
  await page.screenshot({path:directory+'/slicer-1920.png'});
  const atlasDownload=page.waitForEvent('download');await tool.getByRole('button',{name:'下载图集',exact:true}).click();
  const atlas=await atlasDownload;const atlasPath=path.join(directory,'atlas.png');await atlas.saveAs(atlasPath);
  const atlasPixels=await sharp(atlasPath).raw().ensureAlpha().toBuffer({resolveWithObject:true});
  assert.deepEqual([...atlasPixels.data.subarray(0,4)],[0,0,0,0]);
  const offset=(16*atlasPixels.info.width+16)*4;
  assert.deepEqual([...atlasPixels.data.subarray(offset,offset+4)],[204,51,68,255],'atlas keeps original pixels and alpha');
  await tool.locator('.slicer-more-actions summary').click();
  const zipDownload=page.waitForEvent('download');await tool.getByRole('button',{name:'下载素材 ZIP',exact:true}).click();
  const zip=await zipDownload;const zipPath=path.join(directory,'assets.zip');await zip.saveAs(zipPath);
  const archive=await JSZip.loadAsync(await fs.readFile(zipPath));
  assert.equal(Object.keys(archive.files).filter(name=>name.endsWith('.png')).length,2);
  await tool.locator('.slicer-more-actions summary').click();
  await tool.getByRole('button',{name:'资源编辑',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'资源编辑器',exact:true});await editor.waitFor();
  await editor.getByRole('button',{name:'预览 RedButton',exact:true}).click();
  const sprite=page.getByRole('dialog',{name:'素材修正',exact:true});
  await sprite.getByLabel('对象名',{exact:true}).fill('EditedButton');
  const saved=page.waitForResponse(response=>response.url().endsWith('/api/slice-tasks')&&response.request().method()==='PUT');
  await sprite.getByRole('button',{name:'保存名称',exact:true}).click();await saved;
  await sprite.getByRole('button',{name:'关闭',exact:true}).click();
  await editor.getByRole('button',{name:'关闭资源编辑器',exact:true}).click();
  assert.equal((await api('/api/slice-tasks')).tasks.find(task=>task.id===done.id).elements[0].objectName,'EditedButton');
  await tool.getByRole('button',{name:/待重试截图.png/}).click();
  await page.waitForFunction(()=>!document.querySelector('.slicer-detail-actions button:not([aria-label])')?.disabled);
  await tool.locator('.slicer-more-actions summary').click();await tool.getByRole('button',{name:'重试切图',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.slicer-task-row.active .slicer-status')?.textContent==='已完成');
  assert.equal((await api('/api/slice-tasks')).tasks.find(task=>task.id===interrupted.id).elements.length,1,'retry keeps existing asset IDs');
  await page.waitForFunction(()=>!document.querySelector('.slicer-create-task')?.disabled);
  const fixture=await image(32,64,'#bbaa66');
  await tool.getByLabel('上传切图图片',{exact:true}).setInputFiles({name:'新上传.png',mimeType:'image/png',buffer:fixture});
  await page.waitForFunction(()=>document.querySelector('.slicer-task-row.active strong')?.textContent==='新上传.png'&&document.querySelector('.slicer-task-row.active .slicer-status')?.textContent==='已完成');
  await page.waitForFunction(()=>!document.querySelector('.slicer-create-task')?.disabled);
  let current=(await api('/api/slice-tasks')).tasks.find(task=>task.name==='新上传.png');
  assert.equal(current.elements.length,1);assert.ok(current.elements[0].slice);
  await page.reload();await page.getByRole('button',{name:'切图工具',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.slicer-task-row.active strong')?.textContent==='新上传.png');
  await page.waitForFunction(()=>!document.querySelector('.slicer-detail-actions button:not([aria-label])')?.disabled);
  await page.getByRole('button',{name:'删除切图任务',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'删除切图任务',exact:true});
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  assert.ok((await api('/api/slice-tasks')).tasks.some(task=>task.id===current.id));
  await page.getByRole('button',{name:'删除切图任务',exact:true}).click();await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();
  await confirmation.waitFor({state:'detached'});
  assert.equal((await api('/api/slice-tasks')).tasks.some(task=>task.id===current.id),false);
  assert.equal((await fetch(base+'/api/image?name='+encodeURIComponent(current.source.sourceImage))).ok,true,'deleting task must not remove shared image bytes');
  await api('/api/slice-tasks',{id:projectTask.id},'DELETE',false);
  assert.ok((await api('/api/slice-tasks')).tasks.some(task=>task.id===projectTask.id));
  await page.getByRole('button',{name:'刷新切图任务',exact:true}).click();
  assert.equal(await tool.locator('.slicer-task-row').count(),2);
  await page.setViewportSize({width:721,height:884});await page.screenshot({path:directory+'/slicer-721.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  for(let index=0;index<2;index++) {
    await page.getByRole('button',{name:'删除切图任务',exact:true}).click();
    await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();
    await confirmation.waitFor({state:'detached'});
    await page.waitForFunction(()=>!document.querySelector('.slicer-create-task')?.disabled);
  }
  assert.equal(await tool.locator('.slicer-task-row').count(),0);
  assert.equal(await tool.getByText('选择任务查看切图结果',{exact:true}).count(),1);
  assert.equal(await tool.getByRole('button',{name:'上传图片并创建任务',exact:true}).isEnabled(),true);
  assert.deepEqual(errors,[]);
  console.log('PASS real REST task list/select/refresh/upload+automatic extraction/retry/delete+ownership guard, pixel-exact alpha atlas PNG, actual ZIP, shared full-screen resource editor persistence, reload and 721px layout; only vision/segment responses controlled; '+directory);
} finally {await browser.close();await server.close();}
