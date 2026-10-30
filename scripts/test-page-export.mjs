import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const directory = await fs.mkdtemp(path.resolve('.data/page-export-'));
const browserPath = process.env.PAGE_EXPORT_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const entry = String.raw`
import JSZip from 'jszip';
import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { buildPageExport, pageExportDirectory } from './src/lib/pageExport';
import { PageExportPanel } from './src/components/PageExportPanel';
const checks = [];
const assert = (value, message) => { if (!value) throw Error(message); checks.push(message); };
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), message + ': ' + JSON.stringify(actual));
const rejects = async (operation, pattern) => {
  try { await operation(); } catch (error) { assert(pattern.test(error.message), 'reject ' + pattern + ': ' + error.message); return; }
  throw Error('Expected rejection: ' + pattern);
};
const canvas = (w,h) => { const c=document.createElement('canvas'); c.width=w; c.height=h; return c; };
const storeImage = async (name, c, mime='image/png') => {
  const blob=await new Promise(resolve=>c.toBlob(resolve,mime));
  assert(blob.type===mime, 'real browser encodes '+mime);
  await fetch('/fixture/'+name,{method:'POST',body:blob});
};
const source = canvas(400,200);
const context = source.getContext('2d');
context.fillStyle='#ff0000'; context.fillRect(0,0,200,200);
context.fillStyle='#0000ff'; context.fillRect(200,0,200,200);
await storeImage('source.jpg',source,'image/jpeg');
await storeImage('source.webp',source,'image/webp');
await storeImage('source.png',source);
const tall = canvas(200,400); const tallContext=tall.getContext('2d');
tallContext.fillStyle='#ff0000'; tallContext.fillRect(0,0,200,400);
await storeImage('tall.png',tall);
const slice = canvas(8,4); const sliceContext = slice.getContext('2d');
sliceContext.fillStyle='#00ff00'; sliceContext.fillRect(0,0,8,4);
await storeImage('slice.png',slice);
await fetch('/fixture/broken.png',{method:'POST',body:'not an image'});
const settings={visionModel:'unused',imageModel:'unused',module:'../Common',tolerance:1,softness:1,hardEdge:false,fringeFix:false,includeTextAsImage:false};
const version={id:'v2',name:'Selected',operation:'import',parentVersionId:'v1',note:'review note',prompt:'fixture prompt',image:'source.jpg',createdAt:2,
  styleSnapshot:{id:'style',name:'Selected style',prompt:'version style'}};
const screen={id:'s/1',name:'../Same',usage:'fixture',layout:[],versions:[{...version,id:'v1',image:'broken.png'},version],activeVersionId:'v2'};
const noAssets={...screen,id:'s?1',versions:[{...version,image:'source.webp'}]};
const noImage={...screen,id:'empty',name:'No image',versions:[version,{...version,id:'pending',image:undefined}],activeVersionId:'pending'};
const filteredPage={...screen,id:'filtered',name:'Filtered'};
const noVersion={...screen,id:'no-version',name:'No version',versions:[]};
const project={id:'p',name:'../Project',stylePrompt:'current style',styleImage:'style.png',orientation:'portrait',size:{w:750,h:1334},screens:[screen,noAssets,noImage,filteredPage,noVersion],createdAt:1,updatedAt:2};
const border={bgColor:[0,0,0],sideScore:{top:1,right:1,bottom:1,left:1},dirtySides:[]};
const element={id:'a',label:'button',kind:'button',description:'green',objectName:'../Same',state:'normal',rect:{x:40,y:20,w:80,h:40},layer:2,occluded:false,needsAi:false,approved:true,processingStatus:'done',extractionMethod:'manual',slice:{width:8,height:4,border,image:'slice.png'}};
const task={schemaVersion:1,id:'task',name:'saved',source:{kind:'project',projectId:'p',screenId:screen.id,versionId:'v2',sourceImage:'source.jpg'},width:400,height:200,
  elements:[element,{...element,id:'b'}, {...element,id:'text',kind:'text',text:'TXT'}, {...element,id:'rejected',approved:false,slice:{...element.slice,image:'broken.png'}}, {...element,id:'unsliced',slice:undefined}],status:'done',createdAt:1,updatedAt:2};
let tasks=[task,{...task,id:'old',source:{...task.source,screenId:noAssets.id,versionId:'v1'}},
  {...task,id:'wrong-image',source:{...task.source,screenId:noAssets.id,sourceImage:'source.png'}},
  {...task,id:'filtered-task',source:{...task.source,screenId:filteredPage.id},elements:[{...element,approved:false}]}];
const saveTasks=async(value)=>{await fetch('/fixture/tasks',{method:'POST',body:JSON.stringify(value)});};
await saveTasks(tasks);
const pack=await buildPageExport(project,settings,{scope:'all',size:'750x1334'});
const zip=await JSZip.loadAsync(pack.blob);
const manifest=JSON.parse(await zip.file('manifest.json').async('string'));
assert(manifest.pages.length===3 && manifest.skipped.length===2,'no-image active version and no-version pages skipped without old image fallback');
assert(pack.report.includes('无素材') && pack.report.includes('无图') && pack.report.includes('没有已存切图任务'),'no-assets and no-image reports');
assert(manifest.pages[0].version.id==='v2' && manifest.pages[0].version.styleSnapshot.prompt==='version style' && manifest.project.stylePrompt==='current style','selected version, version style and current project style provenance');
const page=manifest.pages[0];
equal(page.transform,{fit:'contain',padding:'transparent',sourceSize:{width:400,height:200},exportSize:{width:750,height:1334},scale:1.875,offset:{x:0,y:479.5}},'actual dimensions and centered contain transform');
assert(page.assets.length===2 && page.assets.every(a=>a.approved),'approved and text filtering');
assert(manifest.pages[1].assets.length===0 && !manifest.pages[1].task,'old-version and wrong-image tasks excluded');
assert(manifest.pages[2].assets.length===0 && manifest.pages[2].task,'filtered task exports whole page with no-assets report');
assert(page.assets[0].path!==page.assets[1].path,'same-name assets do not overwrite');
assert(manifest.pages[0].directory!==manifest.pages[1].directory,'sanitized same screen names and IDs do not overwrite');
assert(manifest.pages[1].directory.endsWith('_2'),'colliding screen name and ID receive stable numeric suffix');
const used=new Set(); const collisionA=pageExportDirectory({id:'s',name:'A'},used); const collisionB=pageExportDirectory({id:'S',name:'a'},used);
assert(collisionB.toLowerCase()!==collisionA.toLowerCase() && collisionB.endsWith('_2'),'case-insensitive stable numeric suffix');
const files=Object.values(zip.files).filter(f=>!f.dir).map(f=>f.name);
assert(files.every(f=>!f.split('/').includes('..') && !f.startsWith('/')),'safe relative ZIP paths');
const coords=JSON.parse(await zip.file(page.directory+'/coords.json').async('string'));
equal(coords[0].sourceRect,{x:40,y:20,w:80,h:40},'sourceRect unchanged');
equal(coords[0].exportRect,{x:75,y:517,w:150,h:75},'sourceRect mapped with padding and scale');
equal(page.assets[0].sourceMapping.destination,{x:0,y:0,w:8,h:4},'slice mapping preserves actual PNG resolution');
const inspect=async(z,file,w,h)=>{
  const bytes=await z.file(file).async('uint8array');
  equal(Array.from(bytes.slice(0,8)),[137,80,78,71,13,10,26,10],'actual PNG signature '+file);
  const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
  assert(bitmap.width===w && bitmap.height===h,'actual PNG dimensions '+w+'x'+h);
  const c=canvas(w,h); const ctx=c.getContext('2d'); ctx.drawImage(bitmap,0,0); bitmap.close();
  return (x,y)=>Array.from(ctx.getImageData(x,y,1,1).data);
};
const pixel=await inspect(zip,page.image,750,1334);
equal(pixel(100,100),[0,0,0,0],'top padding transparent');
equal(pixel(100,1200),[0,0,0,0],'bottom padding transparent');
assert(pixel(100,600)[0]>245 && pixel(600,600)[2]>245 && pixel(100,600)[3]===255,'actual red/blue image retained without stretch or crop');
const assetPixel=await inspect(zip,page.assets[0].path,8,4);
equal(assetPixel(4,2),[0,255,0,255],'actual saved slice pixels');
await inspect(zip,manifest.pages[1].image,750,1334);
const current=await buildPageExport(project,settings,{scope:'current',currentScreenId:screen.id,size:'original'});
const currentZip=await JSZip.loadAsync(current.blob);
equal(current.manifest.pages[0].transform.exportSize,{width:400,height:200},'original uses source dimensions instead of project dimensions');
assert(current.manifest.pages[0].directory===page.directory,'stable directory across current/all scopes');
await inspect(currentZip,current.manifest.pages[0].image,400,200);
for(const preset of ['1500x2668','1334x750','2668x1500']){
  const [w,h]=preset.split('x').map(Number);
  const result=await buildPageExport({...project,screens:[{...screen,versions:[{...version,image:'tall.png'}]}]},settings,{scope:'all',size:preset});
  const z=await JSZip.loadAsync(result.blob); const p=result.manifest.pages[0]; const px=await inspect(z,p.image,w,h);
  assert(p.transform.sourceSize.width===200 && p.transform.sourceSize.height===400,'portrait source actual size '+preset);
  assert(px(0,Math.floor(h/2))[3]===0 && px(Math.floor(w/2),Math.floor(h/2))[0]===255,'horizontal transparent padding and center pixels '+preset);
}
const textPack=await buildPageExport(project,{...settings,includeTextAsImage:true},{scope:'current',currentScreenId:screen.id,size:'original'});
assert(textPack.manifest.pages[0].assets.length===3 && textPack.manifest.pages[0].assets.some(a=>a.kind==='text'),'settings enables approved text');
const textZip=await JSZip.loadAsync(textPack.blob);
await inspect(textZip,textPack.manifest.pages[0].assets.find(a=>a.kind==='text').path,8,4);
await rejects(()=>buildPageExport({...project,screens:[noImage,noVersion]},settings,{scope:'all',size:'original'}),/没有可导出的整图.*无图/);
await rejects(()=>buildPageExport(project,settings,{scope:'current',size:'original'}),/没有可导出的界面/);
await rejects(()=>buildPageExport(project,settings,{scope:'all',size:'bad'}),/不支持的导出尺寸/);
await rejects(()=>buildPageExport({...project,screens:[{...screen,versions:[{...version,image:'broken.png'}]}]},settings,{scope:'all',size:'original'}),/导出失败.*图片解码失败/);
await rejects(()=>buildPageExport({...project,screens:[{...screen,versions:[{...version,image:'missing.png'}]}]},settings,{scope:'all',size:'original'}),/导出失败/);
await saveTasks([{...task,width:401}]);
await rejects(()=>buildPageExport(project,settings,{scope:'all',size:'original'}),/任务尺寸.*实际尺寸不一致/);
await saveTasks([{...task,elements:[{...element,slice:{...element.slice,width:9}}]}]);
await rejects(()=>buildPageExport(project,settings,{scope:'all',size:'original'}),/素材 PNG 实际尺寸不一致/);
await saveTasks([{...task,elements:[{...element,slice:{...element.slice,image:'broken.png'}}]}]);
await rejects(()=>buildPageExport(project,settings,{scope:'all',size:'original'}),/导出失败.*图片解码失败/);
await saveTasks([task,task]);
await rejects(()=>buildPageExport(project,settings,{scope:'all',size:'original'}),/多个素材任务/);
// Failure injection only after real pixel/dimension acceptance above.
const toBlob=HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob=function(callback){ callback(null); };
await rejects(()=>buildPageExport(project,settings,{scope:'all',size:'original'}),/PNG 编码失败/);
HTMLCanvasElement.prototype.toBlob=toBlob;
await saveTasks(tasks);
await fetch('/fixture/task-status',{method:'POST',body:'503'});
await rejects(()=>buildPageExport(project,settings,{scope:'all',size:'original'}),/HTTP 503/);
await fetch('/fixture/task-status',{method:'POST',body:'200'});
// Mount the production component; HTTP remains controlled data, Canvas/JSZip remain real.
const host=document.createElement('div'); document.body.append(host); const root=createRoot(host);
const until=async(predicate,message)=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error(message);};
const busyChanges=[];
let downloads=0; const click=HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click=function(){downloads++;};
const render=(busy=false,id=screen.id)=>root.render(React.createElement(PageExportPanel,{project,currentScreenId:id,settings,busy,onBusyChange:value=>busyChanges.push(value)}));
render(true); await until(()=>host.querySelector('button'),'panel mounted');
assert(host.querySelector('button').disabled,'external busy disables export');
root.render(React.createElement(PageExportPanel,{project,settings,busy:false,onBusyChange:value=>busyChanges.push(value)}));
await until(()=>!host.querySelector('select').disabled,'missing-current panel rendered');
assert(host.querySelector('button').disabled,'missing current screen disables current export');
render(false);
await until(()=>!host.querySelector('button').disabled,'busy released');
host.querySelector('button').click(); host.querySelector('button').click();
await until(()=>host.querySelector('[role=status]'),'panel completion report');
equal(busyChanges,[true,false],'panel busy released and double click guarded');
assert(downloads===1 && host.textContent.includes('已导出 1 个界面'),'panel downloads one concrete ZIP and reports');
const selects=host.querySelectorAll('select'); selects[0].value='all';
flushSync(()=>selects[0].dispatchEvent(new Event('change',{bubbles:true})));
const currentReport=host.querySelector('[role=status]').textContent;
host.querySelector('button').click();
// The download happens before React commits setReport; wait for the rendered completion.
await until(()=>downloads===2 && !host.querySelector('button').disabled &&
  host.querySelector('[role=status]')?.textContent &&
  host.querySelector('[role=status]').textContent!==currentReport,'panel all-screen export completion report');
assert(host.textContent.includes('无素材') && host.textContent.includes('无图'),'panel displays multi-page report');
await fetch('/fixture/task-status',{method:'POST',body:'503'});
host.querySelector('button').click(); await until(()=>host.querySelector('[role=alert]'),'panel error');
assert(host.textContent.includes('HTTP 503') && downloads===2 && busyChanges.at(-1)===false,'panel failure visible, no download and busy released');
root.unmount(); HTMLAnchorElement.prototype.click=click;
await fetch('/fixture/export.zip',{method:'POST',body:pack.blob});
await fetch('/fixture/checks.json',{method:'POST',body:JSON.stringify(checks,null,2)});
document.body.textContent='PASS '+checks.length+' assertions';
`;

let tasks = [];
let taskStatus = 200;
const compiled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'page-export-test.tsx', loader: 'tsx' },
  bundle: true, platform: 'browser', format: 'esm', write: false, jsx: 'automatic',
  plugins: [{ name: 'test-css', setup(builder) { builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' })); } }],
});
await fs.writeFile(path.join(directory, 'browser.js'), compiled.outputFiles[0].contents);
let resolveResult;
const finished = new Promise(resolve => { resolveResult = resolve; });
const requestLog = await fs.open(path.join(directory, 'requests.log'), 'a');
const server = http.createServer(async (req, res) => {
  try {
    await requestLog.write(`${req.method} ${req.url}\n`);
    if (req.url === '/result') {
      const parts = []; for await (const chunk of req) parts.push(chunk);
      const result = JSON.parse(Buffer.concat(parts));
      await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
      res.end('ok'); resolveResult(result); return;
    }
    if (req.url === '/api/slice-tasks') {
      res.statusCode = taskStatus; res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(taskStatus === 200 ? { tasks } : { error: 'controlled task service failure' })); return;
    }
    if (req.url.startsWith('/fixture/')) {
      const name = path.basename(req.url);
      if (req.method === 'POST') {
        const parts = []; for await (const chunk of req) parts.push(chunk);
        const body = Buffer.concat(parts);
        if (name === 'tasks') tasks = JSON.parse(body);
        else if (name === 'task-status') taskStatus = Number(body.toString());
        else await fs.writeFile(path.join(directory, name), body);
        res.end('ok'); return;
      }
    }
    if (req.url.startsWith('/api/image?')) {
      const name = path.basename(new URL(req.url, 'http://localhost').searchParams.get('name') ?? '');
      try {
        res.setHeader('Content-Type', name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.webp') ? 'image/webp' : 'image/png');
        res.end(await fs.readFile(path.join(directory, name)));
      } catch { res.statusCode = 404; res.end('missing fixture'); }
      return;
    }
    if (req.url === '/browser.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(compiled.outputFiles[0].contents); return; }
    if (req.url !== '/') { res.statusCode = 404; res.end('unknown fixture route'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<body>Real Edge page export fixtures<script type="module">try { await import('/browser.js'); await fetch('/result',{method:'POST',body:JSON.stringify({ok:true,summary:document.body.textContent})}); } catch(error) { await fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:error.stack})}); }</script>`);
  } catch (error) { res.statusCode = 500; res.end(error.message); resolveResult({ ok: false, error: error.stack }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const stdout = await fs.open(path.join(directory, 'browser-stdout.log'), 'a');
const stderr = await fs.open(path.join(directory, 'browser-stderr.log'), 'a');
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-extensions', '--remote-debugging-port=0',
  `--user-data-dir=${path.join(directory, 'profile')}`, `http://127.0.0.1:${server.address().port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
browser.stdout.on('data', chunk => { void stdout.write(chunk); });
browser.stderr.on('data', chunk => { void stderr.write(chunk); });
browser.on('error', error => resolveResult({ ok: false, error: error.message }));
browser.on('exit', code => { if (code) resolveResult({ ok: false, error: `Edge exited ${code}; see browser-stderr.log` }); });
const timeout = setTimeout(() => resolveResult({ ok: false, error: 'Browser fixture timeout (60 seconds)' }), 60000);
try {
  const result = await finished;
  await fs.writeFile(path.join(directory, 'runner-result.json'), JSON.stringify(result, null, 2));
  assert.ok(result.ok, `${result.error}; artifacts=${directory}`);
  console.log(`${result.summary}: real Edge Canvas/JSZip page export, all presets, PNG/JPEG/WebP source conversion, sourceRect, padding pixels, saved task matching, review/text filters, collisions, errors and React panel; artifacts=${directory}`);
} finally {
  clearTimeout(timeout); browser.kill(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await Promise.all([stdout.close(), stderr.close(), requestLog.close()]);
}
