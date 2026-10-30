import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import sharp from 'sharp';
import { decodeImage } from '../server/imageCodec.ts';

const directory = await fs.mkdtemp(path.resolve('.data/pack-browser-'));
const pixels = Buffer.alloc(7*9*3);
for(let y=0;y<9;y++) for(let x=0;x<7;x++) {
  const color = y<4 ? (x<3 ? [220,20,20] : [20,220,20]) : (x<3 ? [20,20,220] : [220,220,20]);
  pixels.set(color,(y*7+x)*3);
}
for(let orientation=1;orientation<=8;orientation++) {
  const bytes = await sharp(pixels,{raw:{width:7,height:9,channels:3}}).withMetadata({orientation}).jpeg({quality:100,chromaSubsampling:'4:4:4'}).toBuffer();
  await fs.writeFile(path.join(directory,`orientation-${orientation}.jpg`),bytes);
}
for(const format of ['png','jpeg','webp']) {
  const source=await sharp({create:{width:7,height:9,channels:4,background:'#b53c97'}}).toFormat(format).toBuffer();
  let damaged=Buffer.from(source);
  if(format==='png') damaged[damaged.indexOf(Buffer.from('IDAT'))+4]=0;
  if(format==='jpeg') {
    const sos=source.indexOf(Buffer.from([0xff,0xda]));
    damaged=Buffer.concat([source.subarray(0,sos+2+source.readUInt16BE(sos+2)),Buffer.from([0xff,0xd9])]);
  }
  if(format==='webp') damaged[30]=255;
  assert.equal((await sharp(damaged).metadata()).format,format);
  await assert.rejects(()=>sharp(damaged,{failOn:'warning'}).rotate().png().toBuffer());
  await fs.writeFile(path.join(directory,`damaged-${format}`),damaged);
}
const browserPath = process.env.PACK_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const entry = String.raw`
import JSZip from 'jszip';
import { importPack, inspectPackZip } from './src/lib/packImport';
import { exportPack, encodePackResult } from './src/lib/packExport';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ReskinTool } from './src/components/ReskinTool';
const assert = (value, message) => { if (!value) throw Error(message); };
const rejects = async (operation, pattern) => {
  try { await operation(); } catch (error) { assert(pattern.test(error.message), error.message); return; }
  throw Error('Expected rejection: ' + pattern);
};
const file = (blob, name, relativePath) => { const result = new File([blob], name, { type: blob.type }); Object.defineProperty(result, 'webkitRelativePath', { value: relativePath }); return result; };
const canvas = document.createElement('canvas'); canvas.width = 7; canvas.height = 9;
const context = canvas.getContext('2d'); context.fillStyle = '#18ab56'; context.fillRect(1, 1, 5, 7);
const fixtures = [];
for (const [extension, mime] of [['png','image/png'], ['jpg','image/jpeg'], ['JPEG','image/jpeg'], ['webp','image/webp']]) {
  const blob = await new Promise(resolve => canvas.toBlob(resolve, mime));
  assert(blob.type === mime, 'real browser must encode ' + mime);
  const name = 'button.' + extension;
  const originalPath = 'fixture/' + extension + '/' + name;
  await fetch('/fixture/' + extension, { method: 'POST', body: blob });
  const stored = await (await fetch('/fixture/' + extension)).blob();
  fixtures.push(file(stored, name, originalPath));
}
const imported = await importPack(fixtures);
assert(imported.length === 4 && imported.every(item => item.width === 7 && item.height === 9), 'real folder images decoded');
const zip = new JSZip();
for (let i = 0; i < fixtures.length; i++) zip.file(imported[i].originalPath, fixtures[i]);
zip.file('fixture/other/button.png', fixtures[0]);
const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
await fetch('/fixture/pack.zip', { method: 'POST', body: zipBlob });
const storedZip = await (await fetch('/fixture/pack.zip')).blob();
const zipped = await importPack([file(storedZip, 'pack.zip', '')]);
assert(zipped.length === 5, 'cross-directory same name retained');
await rejects(() => importPack([fixtures[0], fixtures[0]]), /路径重复/);
await rejects(() => importPack([file(fixtures[0], 'bad.png', '../bad.png')]), /不安全/);
await rejects(() => importPack([file(new Blob(['broken']), 'bad.png', 'bad.png')]), /损坏/);
await rejects(() => importPack([file(new Blob(['bad']), 'bad.gif', 'bad.gif')]), /不支持/);
await rejects(() => importPack(Array.from({length: 301}, (_, i) => file(fixtures[0], i+'.png', i+'.png'))), /超过 300/);
await rejects(() => importPack([file(new Blob([new Uint8Array(20*1024*1024+1)]), 'large.png', 'large.png')]), /超过 20 MB/);
const traversal = new JSZip(); traversal.file('../escape.png', fixtures[0]);
await rejects(async () => inspectPackZip(new Uint8Array(await traversal.generateAsync({type:'arraybuffer'}))), /不安全/);
const duplicate = new JSZip(); duplicate.file('A.png', fixtures[0]); duplicate.file('a.png', fixtures[0]);
await rejects(async () => inspectPackZip(new Uint8Array(await duplicate.generateAsync({type:'arraybuffer'}))), /重复/);
// Replace a same-length central name to test exact duplicate entries before JSZip can overwrite them.
const repeated = new JSZip(); repeated.file('a.png', fixtures[0]); repeated.file('b.png', fixtures[0]);
const repeatedBytes = new Uint8Array(await repeated.generateAsync({type:'arraybuffer'}));
for (let i=0; i<repeatedBytes.length-5; i++) if (repeatedBytes[i]===98 && String.fromCharCode(...repeatedBytes.subarray(i,i+5))==='b.png') repeatedBytes[i]=97;
await rejects(async () => inspectPackZip(repeatedBytes), /重复/);
const oversized = new Uint8Array(await zip.generateAsync({type:'arraybuffer'}));
for (let i=0; i<oversized.length-46; i++) {
  const view = new DataView(oversized.buffer);
  if (view.getUint32(i,true)!==0x02014b50) continue;
  const nameLength = view.getUint16(i+28,true);
  if (oversized[i+46+nameLength-1]===47) continue;
  view.setUint32(i+24,21*1024*1024,true); break;
}
await rejects(async () => inspectPackZip(oversized), /超限/);

const originalFetch = window.fetch.bind(window);
const images = new Map();
const items = zipped.map((item, i) => {
  const originalImage = 'original-'+i; images.set(originalImage, new Blob([Uint8Array.from(atob(item.dataUrl.split(',')[1]), c => c.charCodeAt(0))], {type: 'image/'+item.format}));
  const resultImage = 'result-'+i; images.set(resultImage, fixtures[0]);
  return {...item, id: String(i), originalImage, resultImage: i === 4 ? undefined : resultImage, status: i === 4 ? 'failed' : 'done', error: i === 4 ? 'controlled provider failure' : undefined};
});
window.fetch = async (url, options) => {
  if (String(url).startsWith('/api/reskin-images/')) {
    const imageUrl = new URL(String(url),location.href);
    const blob=images.get(decodeURIComponent(imageUrl.pathname.split('/').pop()));
    if(imageUrl.searchParams.get('validate')==='1') return originalFetch('/validated-image',{method:'POST',body:blob});
    return new Response(blob);
  }
  return originalFetch(url, options);
};
const task = {id:'fixture-task',name:'fixture',style:{name:'ice',prompt:'ice'},items,status:'done'};
const output = await exportPack(task);
assert(output.report.includes('换肤成功 4 项') && output.report.includes('保留原图 1 项') && output.report.includes('controlled provider failure'), 'partial export report');
const exported = await JSZip.loadAsync(output.blob);
const names = Object.values(exported.files).filter(entry => !entry.dir).map(entry => entry.name);
assert(JSON.stringify(names.sort()) === JSON.stringify(zipped.map(item => item.originalPath).sort()), 'exact original paths and extensions');
for (const item of items) {
  const bytes = await exported.file(item.originalPath).async('uint8array');
  const blob = new Blob([bytes], {type: 'image/'+item.format});
  const bitmap = await createImageBitmap(blob);
  assert(bitmap.width===7 && bitmap.height===9, 'export dimensions for '+item.originalPath); bitmap.close();
  if (item.format==='jpeg') assert(bytes[0]===255 && bytes[1]===216, 'actual JPEG bytes');
  if (item.format==='webp') assert(String.fromCharCode(...bytes.slice(8,12))==='WEBP', 'actual WebP bytes');
}
const fallback = await exported.file(items[4].originalPath).async('uint8array');
const originalBytes = new Uint8Array(await images.get(items[4].originalImage).arrayBuffer());
assert(fallback.every((value,i)=>value===originalBytes[i]) && fallback.length===originalBytes.length,'failed entry preserves original bytes');
const changed = {...items[4], width: 8};
await rejects(() => exportPack({...task,items:[changed]}), /尺寸不一致/);
const toBlob = HTMLCanvasElement.prototype.toBlob;
HTMLCanvasElement.prototype.toBlob = function(callback) { return toBlob.call(this, callback, 'image/png'); };
await rejects(() => encodePackResult(fixtures[0], items[1]), /不支持 image\/jpeg 编码/);
HTMLCanvasElement.prototype.toBlob = toBlob;
await originalFetch('/fixture/export.zip', {method:'POST', body: output.blob});
// Old tasks can contain invalid results accepted by earlier header-only validation.
const toleratedDamagedFormats=[];
for (const [index,format] of ['png','jpeg','webp'].entries()) {
  const damaged = await (await originalFetch('/fixture/damaged-'+format)).blob();
  let browserAccepted=false;
  try { await importPack([file(damaged,'damaged.'+format,'damaged.'+format)]); browserAccepted=true; }
  catch(error) { assert(/损坏/.test(error.message),error.message); }
  // Browser decoders can substitute pixels for damaged scans; the strict server is authoritative.
  if(browserAccepted) toleratedDamagedFormats.push(format);
  assert((await originalFetch('/validated-image',{method:'POST',body:damaged})).status===400,'strict server rejects real damaged '+format);
  images.set('historical-broken-'+index,damaged);
  const item = {...items[index],resultImage:'historical-broken-'+index,status:'done'};
  const recovered = await exportPack({...task,items:[item]});
  assert(recovered.report.includes('保留原图 1 项') && recovered.report.includes('结果不可导出'),'historical bad result explained');
  const recoveredZip = await JSZip.loadAsync(recovered.blob);
  const bytes = await recoveredZip.file(item.originalPath).async('uint8array');
  const original = new Uint8Array(await images.get(item.originalImage).arrayBuffer());
  assert(bytes.length===original.length && bytes.every((value,i)=>value===original[i]),'historical fallback retains exact source');
}
await originalFetch('/fixture/browser-tolerated.json',{method:'POST',body:JSON.stringify(toleratedDamagedFormats)});
async function displayPixels(blob) {
  const bitmap = await createImageBitmap(blob);
  const surface = document.createElement('canvas'); surface.width=bitmap.width; surface.height=bitmap.height;
  const ctx=surface.getContext('2d'); ctx.drawImage(bitmap,0,0); bitmap.close();
  return ctx.getImageData(0,0,surface.width,surface.height).data;
}
for (let orientation=1;orientation<=8;orientation++) {
  const source = await (await originalFetch('/fixture/orientation-'+orientation+'.jpg')).blob();
  const [imported] = await importPack([file(source,'orientation-'+orientation+'.jpg','orientation-'+orientation+'.jpg')]);
  const display = orientation>=5 ? [9,7] : [7,9];
  assert(imported.width===display[0] && imported.height===display[1],'browser oriented source dimensions '+orientation);
  const orientedItem={...imported,id:'orientation-'+orientation,encodedWidth:7,encodedHeight:9,orientation,originalImage:'oriented-source-'+orientation,resultImage:'oriented-result-'+orientation,status:'done'};
  images.set(orientedItem.originalImage,source);
  // The actual display-oriented model image, as it is persisted by the shared decoder.
  const bitmap=await createImageBitmap(source);
  const displayCanvas=document.createElement('canvas');displayCanvas.width=display[0];displayCanvas.height=display[1];
  displayCanvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
  const normalized = await new Promise(resolve=>displayCanvas.toBlob(resolve,'image/png'));
  images.set(orientedItem.resultImage,normalized);
  const exported=await exportPack({...task,items:[orientedItem]});
  assert(exported.report.includes('换肤成功 1 项'),'oriented result exported '+orientation+': '+exported.report);
  const orientedZip=await JSZip.loadAsync(exported.blob);
  const result=new Blob([await orientedZip.file(orientedItem.originalPath).async('uint8array')],{type:'image/jpeg'});
  const expected=await displayPixels(normalized);const actual=await displayPixels(result);
  assert(expected.length===actual.length,'oriented display size retained '+orientation);
  let difference=0;for(let i=0;i<actual.length;i++) difference+=Math.abs(expected[i]-actual[i]);
  assert(difference/actual.length<20,'orientation and mirrored pixel positions retained '+orientation+' error='+difference/actual.length);
  await originalFetch('/fixture/orientation-'+orientation+'-export.jpg',{method:'POST',body:result});
}
// Exercise the real component, including explicit source import and key remount recovery.
const savedTasks = [{...task, schemaVersion:1, createdAt:1, updatedAt:1}];
window.fetch = async (url, options) => {
  if (String(url)==='/api/reskin-tasks') return Response.json(savedTasks);
  return originalFetch(url,options);
};
localStorage.setItem('gameui-reskin-selected-task','fixture-task');
const host = document.createElement('div'); document.body.append(host);
const root = createRoot(host);
const settings = {module:'Common',includeTextAsImage:true};
const currentElement = {id:'current',approved:true,kind:'icon',objectName:'Current',state:'',label:'Current',slice:{canvas,width:7,height:9}};
const renderTool = (key, sourceTaskId) => root.render(React.createElement(ReskinTool,{key,settings,elements:[currentElement],styles:[{id:'ice',name:'Ice library',prompt:'ice',createdAt:1,updatedAt:1}],sourceTaskId,busy:false,onBusyChange:()=>{}}));
const until = async (predicate, message) => { for(let i=0;i<100;i++) { if(predicate()) return; await new Promise(resolve=>setTimeout(resolve,10)); } throw Error(message); };
renderTool('first','source-one');
await until(()=>host.querySelector('.reskin-pack-grid article'),'saved task restored');
assert(host.querySelector('.reskin-content h3').textContent==='fixture','task selected from storage');
renderTool('first','source-two');
await new Promise(resolve=>setTimeout(resolve,25));
assert(host.querySelector('.reskin-content h3').textContent==='fixture','props must not replace imported task');
const previousCard = host.querySelector('.reskin-pack-grid article');
renderTool('second','source-three');
await until(()=>host.querySelector('.reskin-pack-grid article') && host.querySelector('.reskin-pack-grid article')!==previousCard,'key remount restores saved task');
assert(host.querySelector('.reskin-content h3').textContent==='fixture','remount preserves selected task');
Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='从当前素材创建换肤任务').click();
await until(()=>host.querySelector('.reskin-draft-files')?.textContent.includes('Current'),'explicit current source draft: '+host.textContent);
assert(host.querySelector('select').textContent.includes('Ice library'),'library styles available');
assert(host.querySelector('.reskin-task-list').textContent.includes('fixture'),'saved imported task remains available');
root.unmount();
document.body.textContent='PASS';
`;
const compiled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'pack-browser-test.ts' }, bundle: true, platform: 'browser', format: 'esm', write: false,
  plugins: [{name:'test-css',setup(builder){builder.onLoad({filter:/\.css$/},()=>({contents:'',loader:'js'}));}}],
});
await fs.writeFile(path.join(directory, 'browser.js'), compiled.outputFiles[0].contents);
let resolveResult;
const finished = new Promise((resolve) => { resolveResult = resolve; });
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/validated-image') {
      const parts=[]; for await(const chunk of req) parts.push(chunk);
      const bytes=Buffer.concat(parts);
      try { await decodeImage(bytes); res.end(bytes); }
      catch(error) { res.statusCode=400; res.end(error.message); }
      return;
    }
    if (req.url === '/result') {
      const parts = []; for await (const chunk of req) parts.push(chunk);
      resolveResult(JSON.parse(Buffer.concat(parts))); res.end('ok'); return;
    }
    if (req.url.startsWith('/fixture/')) {
      const name = path.basename(req.url);
      const target = path.join(directory, name);
      if (req.method === 'POST') { const parts=[]; for await (const chunk of req) parts.push(chunk); await fs.writeFile(target, Buffer.concat(parts)); res.end('ok'); }
      else { res.end(await fs.readFile(target)); }
      return;
    }
    if (req.url === '/browser.js') { res.setHeader('Content-Type','application/javascript'); res.end(compiled.outputFiles[0].contents); return; }
    res.setHeader('Content-Type','text/html');
    res.end(`<body>Running real browser fixtures<script type="module">try { await import('/browser.js'); await fetch('/result',{method:'POST',body:JSON.stringify({ok:true})}); } catch(error) { await fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:error.stack})}); }</script>`);
  } catch(error) { res.statusCode=500; res.end(error.message); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory,'profile')}`, `http://127.0.0.1:${server.address().port}`], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
const stderr = fs.open(path.join(directory, 'browser-stderr.log'), 'a');
browser.stderr.on('data', async (chunk) => { (await stderr).write(chunk); });
browser.on('error', (error) => resolveResult({ok:false,error:error.message}));
const timeout = setTimeout(() => resolveResult({ok:false,error:'Browser fixture timeout (60 seconds)'}), 60000);
try {
  const result = await finished;
  assert.ok(result.ok, result.error);
  for(let orientation=1;orientation<=8;orientation++) {
    const bytes=await fs.readFile(path.join(directory,`orientation-${orientation}-export.jpg`));
    const metadata=await sharp(bytes,{failOn:'warning'}).metadata();
    assert.deepEqual([metadata.width,metadata.height,metadata.orientation],[7,9,orientation]);
    const decoded=await sharp(bytes,{failOn:'warning'}).rotate().raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([decoded.info.width,decoded.info.height],orientation>=5?[9,7]:[7,9]);
  }
  console.log(`PASS: real Edge PNG/JPG/JPEG/WebP folder/ZIP, EXIF 1–8 encoded 7x9/oriented dimensions and mirrored pixels (sharp cross-validation), historical broken results fallback, exact original bytes, limits, partial export, encoding rejection, React recovery; artifacts=${directory}`);
} finally {
  clearTimeout(timeout); browser.kill(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); await (await stderr).close();
}
