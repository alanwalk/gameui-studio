import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn, fork } from 'node:child_process';
import { build } from 'esbuild';
import sharp from 'sharp';

if (process.env.STYLE_TEST_CHILD) {
  const directory = process.env.GAMEUI_DATA;
  let release = false;
  let invalid = false;
  let failDrawing = false;
  let calls = 0;
  const events = [];
  const png = await sharp({create:{width:32,height:32,channels:3,background:'#7150c0'}}).png().toBuffer();
  const gateway = http.createServer(async (req,res) => {
    const chunks=[]; for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks));
    events.push({kind:'vision',body});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:invalid ? '```json\n{"name":"bad"}\n```' : JSON.stringify({name:'受控测试画风',prompt:'紫色手绘、细线描边、柔和光照、统一圆角材质'})}}]}));
  });
  await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));
  process.env.MAGPIE_GATEWAY=`http://127.0.0.1:${gateway.address().port}/v1`;
  const {createStyleHandler,styleContactSheet,parseStyleOutput}=await import('../server/styleApi.ts');
  const {createDrawingHandler}=await import('../server/drawingApi.ts');
  const {saveImage,readImage,upsertStyle,listStyles}=await import('../server/store.ts');
  const {readDrawingImage}=await import('../server/drawingStore.ts');
  const refs=[];
  for(let i=0;i<12;i++) {
    const buffer=await sharp({create:{width:12,height:9,channels:3,background:{r:15+i*18,g:30,b:70}}}).png().toBuffer();
    refs.push(await saveImage('data:image/png;base64,'+buffer.toString('base64'),'fixture-'+i));
  }
  // Every source appears in its own cell; no cropping or truncation at the five-ref Drawing boundary.
  const buffers=[];for(const ref of refs) buffers.push(Buffer.from((await readImage(ref)).split(',')[1],'base64'));
  const sheet=await styleContactSheet(buffers);
  const raw=await sharp(sheet).removeAlpha().raw().toBuffer({resolveWithObject:true});
  assert.equal(raw.info.width,1536);assert.equal(raw.info.height,1152);
  for(let i=0;i<12;i++) assert.equal(raw.data[((Math.floor(i/4)*384+192)*1536+(i%4*384+192))*3],15+i*18);
  for(const value of ['{}','[]','null','{"name":"a","prompt":"b","extra":1}','text {"name":"a","prompt":"b"}']) assert.throws(()=>parseStyleOutput(value));
  const style=createStyleHandler();
  const drawing=createDrawingHandler({
    async generateImage(args) {
      calls++;events.push({kind:'drawing',args});
      if(failDrawing) return {base64:png.toString('base64'),text:'controlled image provider failed',isError:true};
      return {pendingId:'controlled-style-pending',text:'controlled pending',isError:false};
    },
    async waitForGeneration() {
      while(!release) await new Promise(resolve=>setTimeout(resolve,20));
      return {base64:png.toString('base64'),text:'controlled fixture, NOT real model',isError:false};
    },
  });
  const browserJs=await fs.readFile(path.join(directory,'browser.js'));
  const server=http.createServer(async(req,res)=>{
    try {
      if(req.url==='/test/fixtures') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({refs,calls,events}));return;}
      if(req.url==='/test/release') {release=true;res.end('ok');return;}
      if(req.url==='/test/invalid') {invalid=!invalid;res.end('ok');return;}
      if(req.url==='/test/fail-drawing') {failDrawing=!failDrawing;res.end('ok');return;}
      if(req.url==='/test/styles') {
        if(req.method==='POST') {const chunks=[];for await(const chunk of req)chunks.push(chunk);await upsertStyle(JSON.parse(Buffer.concat(chunks)));}
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await listStyles()));return;
      }
      if(req.url==='/test/result') {const chunks=[];for await(const chunk of req)chunks.push(chunk);const result=JSON.parse(Buffer.concat(chunks));await fs.writeFile(path.join(directory,'browser-result.json'),JSON.stringify(result,null,2));process.send({result});res.end('ok');return;}
      if(req.url==='/browser.js') {res.setHeader('Content-Type','application/javascript');res.end(browserJs);return;}
      if(req.url.startsWith('/api/images/') || req.url.startsWith('/api/image?')) {const file=new URL(req.url,'http://localhost').searchParams.get('name')??decodeURIComponent(req.url.split('/').pop());const data=await readImage(file);res.setHeader('Content-Type','image/png');res.end(Buffer.from(data.split(',')[1],'base64'));return;}
      await style(req,res,()=>{void drawing.handle(req,res,()=>{
        res.setHeader('Content-Type','text/html');res.end(`<body><script type="module">try{await import('/browser.js')}catch(error){await fetch('/test/result',{method:'POST',body:JSON.stringify({ok:false,error:error?.stack??String(error)})})}</script>`);
      });});
    } catch(error) {res.statusCode=500;res.end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  process.send({port:server.address().port,refs});
} else {
  const directory=await fs.mkdtemp(path.resolve('.data/style-generation-test-'));
  const entry=String.raw`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {StyleLibrary} from './src/components/StyleLibrary';
import {STYLE_DRAFT_KEY} from './src/lib/styleGeneration';
const assert=(value,message)=>{if(!value)throw Error(message)};
const until=async(fn,message)=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,20))}throw Error(message)};
const fixtures=await(await fetch('/test/fixtures')).json();
const post=async(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const stage=sessionStorage.getItem('style-stage');
const host=document.createElement('div');document.body.append(host);let root=createRoot(host);
let styles=await(await fetch('/test/styles')).json();
const render=(source)=>root.render(React.createElement(StyleLibrary,{styles,busy:false,visionModel:'codex/gpt-6.1-terra',initialReferenceImage:source,onBusyChange:()=>{},onCreate:async(style)=>{styles=await(await post('/test/styles',style)).json();render(source)},onUpdate:async()=>{},onDelete:async()=>{},onReplaceImage:async()=>{}}));
const button=text=>Array.from(document.querySelectorAll('button')).find(b=>b.textContent===text);
if(!stage){
 localStorage.removeItem(STYLE_DRAFT_KEY);
 render(fixtures.refs[0]);await until(()=>document.querySelector('.style-generator-refs img'),'initial source');
 assert(document.querySelector('.style-generator-refs img').getAttribute('src').includes(fixtures.refs[0]),'source filename');
 render(fixtures.refs[1]);await until(()=>document.querySelector('.style-generator-refs img')?.getAttribute('src').includes(fixtures.refs[1]),'async source updates');
 // Upload twelve real files through React, FileReader and the HTTP decoder.
 render(undefined);await until(()=>document.querySelector('.style-generator-refs img')===null,'source cleared');
 const dt=new DataTransfer();const bytes=await(await fetch('/api/images/'+fixtures.refs[0])).blob();
 for(let i=0;i<12;i++)dt.items.add(new File([bytes],'ref-'+i+'.png',{type:'image/png'}));
 const input=document.querySelector('.style-generator input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
 await until(()=>document.querySelectorAll('.style-generator-refs figure').length===12,'twelve uploads');
 const generateButton=button('AI 生成画风与预览');generateButton.click();generateButton.click();
 await until(()=>JSON.parse(localStorage.getItem(STYLE_DRAFT_KEY)).pendingDrawingID,'pending persisted');
 assert((await(await fetch('/test/styles')).json()).length===0,'no automatic save');
 const draft=JSON.parse(localStorage.getItem(STYLE_DRAFT_KEY));
 assert(!JSON.stringify(draft).includes('base64'),'only small references in storage');
 sessionStorage.setItem('style-stage','pending');location.reload();
}else{
 render();await until(()=>button('AI 创建 / 提取画风'),'style library ready');button('AI 创建 / 提取画风').click();await until(()=>document.body.textContent.includes('预览任务已提交'),'refresh restores pending');
 await fetch('/test/release');await until(()=>document.querySelector('.style-generator-result > img'),'generated image arrives');
 const preview=document.querySelector('.style-generator-result > img');await preview.decode();
 assert(preview.naturalWidth===32,'actual fixture output, not 1536px contact sheet');
 const draft=JSON.parse(localStorage.getItem(STYLE_DRAFT_KEY));assert(draft.image.endsWith('.png')&&!/^[a-f0-9-]{36}$/.test(draft.image),'global image filename');
 button('保存 AI 画风到风格库').click();button('保存 AI 画风到风格库').click();
 await until(()=>document.querySelector('.style-card h3'),'explicit save visible');
 const saved=await(await fetch('/test/styles')).json();assert(saved.length===1&&saved[0].referenceImages.length===12,'save once with refs');
 assert(button('编辑')&&document.body.textContent.includes('手动新增风格'),'manual editing preserved');button('编辑').click();
 await until(()=>document.querySelector('#style-name')?.value==='受控测试画风','existing style editing preserved');
 const info=await(await fetch('/test/fixtures')).json();assert(info.calls===1,'double click and reload did not duplicate image request');
 assert(info.events.find(e=>e.kind==='drawing').args.referenceImages.length===1,'one sheet passed into Drawing worker');
 const vision=info.events.find(e=>e.kind==='vision').body;assert(vision.reasoning_effort==='medium','medium retained');
 render(fixtures.refs[2]);await until(()=>document.querySelector('.style-generator-refs img')?.getAttribute('src').includes(fixtures.refs[2]),'new source');
 await fetch('/test/invalid');button('AI 生成画风与预览').click();await until(()=>document.querySelector('.style-generator [role=alert]')?.textContent.includes('JSON'),'invalid JSON visibly fails');
 assert(!document.querySelector('.style-generator-result'),'invalid model result is not success');await fetch('/test/invalid');
 // Hold an actual HTTP response while the source changes; the old draft must not receive it.
 const originalFetch=window.fetch.bind(window);let releaseResponse;let received=false;
 window.fetch=async(url,options)=>{const response=await originalFetch(url,options);if(url==='/api/style-generation/analyze'){received=true;await new Promise(resolve=>{releaseResponse=resolve})}return response};
 button('AI 生成画风与预览').click();await until(()=>received,'analysis response held');
 render(fixtures.refs[3]);await until(()=>document.querySelector('.style-generator-refs img')?.getAttribute('src').includes(fixtures.refs[3]),'source changes during analysis');
 releaseResponse();window.fetch=originalFetch;await new Promise(r=>setTimeout(r,80));
 assert(!document.querySelector('.style-generator-result'),'late analysis cannot overwrite new source');
 assert((await(await fetch('/test/fixtures')).json()).calls===1,'stale analysis did not enqueue drawing');
 // A request completing after unmount cannot overwrite the draft restored by the new mount.
 received=false;
 window.fetch=async(url,options)=>{const response=await originalFetch(url,options);if(url==='/api/style-generation/analyze'){received=true;await new Promise(resolve=>{releaseResponse=resolve})}return response};
 button('AI 生成画风与预览').click();await until(()=>received,'second held analysis');
 root.unmount();root=createRoot(host);render(fixtures.refs[4]);await until(()=>document.querySelector('.style-generator-refs img')?.getAttribute('src').includes(fixtures.refs[4]),'remount source');
 releaseResponse();window.fetch=originalFetch;await new Promise(r=>setTimeout(r,80));assert(!document.querySelector('.style-generator-result'),'unmounted response ignored');
 await fetch('/test/fail-drawing');button('AI 生成画风与预览').click();await until(()=>document.querySelector('.style-generator [role=alert]')?.textContent.includes('controlled image provider failed'),'provider failure visible');
 assert(button('保存 AI 画风到风格库').disabled,'cannot save failed image');
 assert((await(await fetch('/test/styles')).json()).length===1,'failure did not create style');
 await fetch('/test/fail-drawing');window.confirm=()=>true;button('重新生成预览').click();await until(()=>document.querySelector('.style-generator-result > img'),'explicit retry succeeds');
 assert((await(await fetch('/test/styles')).json()).length===1,'retry still requires explicit save');
 await fetch('/test/result',{method:'POST',body:JSON.stringify({ok:true,checks:'Edge upload12, async source + in-flight/unmount isolation, invalid JSON/error visibility, pending real reload, Drawing reuse, global preview, explicit save, double clicks, provider failure/retry, editing retained; controlled providers only'})});
}
`;
  const compiled=await build({stdin:{contents:entry,resolveDir:process.cwd(),sourcefile:'style-generation-browser.tsx'},bundle:true,platform:'browser',format:'esm',write:false,plugins:[{name:'css',setup(b){b.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}))}}]});
  await fs.writeFile(path.join(directory,'browser.js'),compiled.outputFiles[0].contents);
  const runner=path.join(directory,'runner.mjs');
  await build({entryPoints:['scripts/test-style-generation.mjs'],bundle:true,platform:'node',format:'esm',outfile:runner,external:['esbuild','sharp'],logLevel:'warning'});
  const log=await fs.open(path.join(directory,'server.log'),'a');
  const child=fork(runner,[],{env:{...process.env,GAMEUI_DATA:directory,STYLE_TEST_CHILD:'1'},stdio:['ignore','pipe','pipe','ipc']});
  child.stdout.on('data',chunk=>void log.write(chunk));child.stderr.on('data',chunk=>void log.write(chunk));
  let browser;
  const messages=[];child.on('message',message=>messages.push(message));
  const wait=async(predicate)=>{for(let i=0;i<500;i++){const found=messages.find(predicate);if(found)return found;if(child.exitCode!==null)throw Error('Fixture server exited '+child.exitCode);await new Promise(r=>setTimeout(r,20))}throw Error('Fixture server timeout')};
  try {
    const {port,refs}=await wait(m=>m.port);
    const origin='http://127.0.0.1:'+port;
    const post=async(route,body)=>{const r=await fetch(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}};
    for(const reference of ['../escape.png','C:\\escape.png','a/b.png','missing.png'])assert.equal((await post('/api/style-generation/analyze',{description:'x',referenceImages:[reference]})).status,400);
    assert.equal((await post('/api/style-generation/analyze',{description:'',referenceImages:[]})).status,400);
    assert.equal((await post('/api/style-generation/analyze',{description:'x',referenceImages:[...refs,refs[0]]})).status,400);
    assert.equal((await post('/api/style-generation/reference',{dataUrl:'data:image/png;base64,YmFk'})).status,400);
    await fetch(origin+'/test/invalid');
    const bad=await post('/api/style-generation/analyze',{description:'x',referenceImages:[]});assert.equal(bad.status,400);assert.match(bad.body.error,/JSON/);
    await fetch(origin+'/test/invalid');
    const twelve=await post('/api/style-generation/analyze',{description:'',referenceImages:refs});assert.equal(twelve.status,200);assert.equal(twelve.body.drawingReferences.length,1);
    const originals=await post('/api/style-generation/source-images',{drawingImage:twelve.body.drawingReferences[0]});
    assert.equal(originals.status,200);assert.deepEqual(originals.body.images,refs);
    const text=await post('/api/style-generation/analyze',{description:'水彩柔和蓝色游戏画风',referenceImages:[]});assert.equal(text.status,200);assert.deepEqual(text.body.drawingReferences,[]);
    const browserLog=await fs.open(path.join(directory,'edge.log'),'a');
    browser=spawn(process.env.STYLE_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',['--headless=new','--no-first-run','--disable-gpu','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+path.join(directory,'profile'),origin],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    browser.stderr.on('data',chunk=>void browserLog.write(chunk));browser.on('error',error=>messages.push({result:{ok:false,error:error.message}}));
    let result;
    for(let i=0;i<1200;i++){result=messages.find(m=>m.result)?.result;if(result)break;await new Promise(r=>setTimeout(r,50));}
    assert.ok(result?.ok,result?.error??'Edge fixture timeout');
    console.log('PASS real HTTP + Edge: '+result.checks+'; artifacts='+directory);
    browser.kill();await browserLog.close();
  } finally {browser?.kill();child.kill();await log.close();}
}
