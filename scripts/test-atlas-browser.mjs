import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import sharp from 'sharp';
import JSZip from 'jszip';

const directory = await fs.mkdtemp(path.resolve('.data/atlas-browser-'));
const fixtures = [];
const expected = new Map();
const encoder = new TextEncoder();
const pageWidth = 18; const pageHeight = 14;
const baseRegions = [
  { x: 3, y: 3, w: 3, h: 2, W: 7, H: 6, left: 2, top: 1, name: 'button', page: 0 },
  { x: 12, y: 8, w: 2, h: 3, W: 2, H: 3, left: 0, top: 0, name: 'other', page: 0 },
  { x: 4, y: 4, w: 2, h: 2, W: 4, H: 4, left: 1, top: 1, name: 'page-two', page: 1 },
];
const png = (data, width, height) => sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
const pix = (index, seed) => [((index + 1) * 29 + seed) % 256, ((index + 3) * 47 + seed) % 256, ((index + 7) * 31 + seed) % 256, [0, 1, 127, 255][index % 4]];
for (const kind of ['hash', 'array', 'textures', 'plist2', 'plist3', 'spine', 'spine-old']) {
  const rotated = kind.startsWith('spine') ? 'ccw' : 'cw';
  const pages = [0, 1].map(seed => {
    const bytes = Buffer.alloc(pageWidth * pageHeight * 4);
    for (let i = 0; i < pageWidth * pageHeight; i++) bytes.set(pix(i, 13 + seed), i * 4);
    return bytes;
  });
  const regions = baseRegions.map((r, index) => ({ ...r, rotated: index === 0, seed: index * 50 + 17 }));
  for (const r of regions) {
    const untrimmed = Buffer.alloc(r.W * r.H * 4);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const rgba = pix(y * r.w + x, r.seed);
      let px = r.x + x; let py = r.y + y;
      if (r.rotated && rotated === 'cw') { px = r.x + r.h - 1 - y; py = r.y + x; }
      if (r.rotated && rotated === 'ccw') { px = r.x + y; py = r.y + r.w - 1 - x; }
      pages[r.page].set(rgba, (py * pageWidth + px) * 4);
      untrimmed.set(rgba, ((r.top + y) * r.W + r.left + x) * 4);
    }
    expected.set(`${kind}/input-${regions.indexOf(r)}.png`, { data: untrimmed, width: r.W, height: r.H });
  }
  const files = new Map(); const descriptions = [];
  files.set('root/pages/one.png', await png(pages[0], pageWidth, pageHeight));
  files.set('root/pages/two.png', await png(pages[1], pageWidth, pageHeight));
  files.set('root/other/keep.json', Buffer.from('{"arbitrary":true}\r\n'));
  files.set('root/other/exif.jpg', await sharp({ create: { width: 3, height: 5, channels: 3, background: '#be8032' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
  files.set('root/other/empty.bin', Buffer.alloc(0));
  files.set('root/other/readme.txt', Buffer.from('retain me\r\n'));
  const writeDescription = (name, text) => { descriptions.push(name); files.set(name, Buffer.from(text)); };
  const jsonFrame = r => ({ frame: { x: r.x, y: r.y, w: r.w, h: r.h }, rotated: r.rotated, trimmed: true,
    sourceSize: { w: r.W, h: r.H }, spriteSourceSize: { x: r.left, y: r.top, w: r.w, h: r.h } });
  if (kind === 'hash' || kind === 'array' || kind === 'textures') {
    const textures = [0, 1].map(page => {
      const selected = regions.filter(r => r.page === page);
      const frames = {};
      for (const r of selected) frames[r.name] = jsonFrame(r);
      if (page === 0) frames.alias = jsonFrame(selected[0]);
      return { image: `../pages/${page ? 'two' : 'one'}.png`, size: { w: pageWidth, h: pageHeight }, frames };
    });
    if (kind === 'textures') writeDescription('root/meta/sheet.json', '\uFEFF' + JSON.stringify({ textures }, null, 2) + '\r\n');
    else for (let page = 0; page < 2; page++) {
      const texture = textures[page];
      const frames = kind === 'array' ? Object.entries(texture.frames).map(([filename, value]) => ({ filename, ...value })) : texture.frames;
      writeDescription(`root/meta/sheet-${page}.json`, JSON.stringify({ frames, meta: { image: texture.image, size: texture.size } }, null, 1) + '\r\n');
    }
  } else if (kind.startsWith('plist')) {
    const string = value => `<string>${value}</string>`;
    const field = (key, value) => `<key>${key}</key>${value}`;
    for (let page = 0; page < 2; page++) {
      let frames = '';
      for (const r of regions.filter(r => r.page === page)) {
        const rect = `{{${r.x},${r.y}},{${r.w},${r.h}}}`;
        const offset = `{${r.left - (r.W - r.w) / 2},${(r.H - r.h) / 2 - r.top}}`;
        const source = `{${r.W},${r.H}}`;
        let content;
        if (kind === 'plist2') content = field('frame', string(rect)) + field('rotated', `<${r.rotated}/>` ) + field('offset', string(offset)) + field('sourceSize', string(source));
        else content = field('textureRect', string(rect)) + field('spriteSize', string(`{${r.w},${r.h}}`)) + field('textureRotated', `<${r.rotated}/>` ) + field('spriteOffset', string(offset)) + field('spriteSourceSize', string(source)) + field('aliases', r.name === 'button' ? '<array><string>alias</string></array>' : '<array/>');
        frames += field(r.name, `<dict>${content}</dict>`);
        if (kind === 'plist2' && r.name === 'button') frames += field('alias', `<dict>${content}</dict>`);
      }
      const meta = field('format', `<integer>${kind === 'plist2' ? 2 : 3}</integer>`) + field('textureFileName', string(`../pages/${page ? 'two' : 'one'}.png`)) + field('size', string(`{${pageWidth},${pageHeight}}`));
      writeDescription(`root/meta/sheet-${page}.plist`, `<?xml version="1.0" encoding="UTF-8"?>\r\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\r\n<plist version="1.0"><dict>${field('metadata', `<dict>${meta}</dict>`)}${field('frames', `<dict>${frames}</dict>`)}</dict></plist>\r\n`);
    }
  } else {
    let atlas = '';
    for (let page = 0; page < 2; page++) {
      atlas += `../pages/${page ? 'two' : 'one'}.png\r\nsize: ${pageWidth},${pageHeight}\r\nformat: RGBA8888\r\nfilter: Linear,Linear\r\npma: false\r\n`;
      const selected = regions.filter(r => r.page === page);
      for (const r of [...selected, ...(page === 0 ? [{ ...selected[0], name: 'alias' }] : [])]) {
        atlas += `${r.name}\r\n  rotate: ${r.rotated ? (kind === 'spine' ? '90' : 'true') : 'false'}\r\n`;
        if (kind === 'spine') atlas += `  bounds: ${r.x},${r.y},${r.w},${r.h}\r\n  offsets: ${r.left},${r.H - r.h - r.top},${r.W},${r.H}\r\n`;
        else atlas += `  xy: ${r.x},${r.y}\r\n  size: ${r.w},${r.h}\r\n  offset: ${r.left},${r.H - r.h - r.top}\r\n  orig: ${r.W},${r.H}\r\n`;
        atlas += '  index: -1\r\n';
      }
      atlas += '\r\n';
    }
    writeDescription('root/meta/sheet.atlas', atlas);
  }
  const payload = { kind, descriptions, files: [...files].map(([name, bytes]) => ({ name, base64: bytes.toString('base64') })) };
  fixtures.push(payload);
  for (let i = 0; i < 2; i++) expected.set(`${kind}/identity-page-${i}.png`, { data: pages[i], width: pageWidth, height: pageHeight });
  const changed = Buffer.from(pages[0]); const r = regions[0];
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const px = rotated === 'cw' ? r.x + r.h - 1 - y : r.x + y;
    const py = rotated === 'cw' ? r.y + x : r.y + r.w - 1 - x;
    changed.set([201, 45, 17, 128], (py * pageWidth + px) * 4);
  }
  expected.set(`${kind}/changed-page-0.png`, { data: changed, width: pageWidth, height: pageHeight });
  expected.set(`${kind}/changed-page-1.png`, { data: pages[1], width: pageWidth, height: pageHeight });
  const edged = Buffer.from(changed);
  for (let y = r.y - 1; y <= r.y + r.w; y++) for (let x = r.x - 1; x <= r.x + r.h; x++) edged.set([201, 45, 17, 128], (y * pageWidth + x) * 4);
  expected.set(`${kind}/edged-page-0.png`, { data: edged, width: pageWidth, height: pageHeight });
}
await fs.writeFile(path.join(directory, 'fixtures.json'), JSON.stringify(fixtures));

const entry = String.raw`
import JSZip from 'jszip';
import { atlasPackInputs, importAtlas, inspectAtlasZip, parseAtlasFiles, decodeAtlasPng, encodeAtlasPng, atlasDataUrl } from './src/lib/atlasImport';
import { exportAtlas } from './src/lib/atlasExport';
import { AtlasTool } from './src/components/AtlasTool';
import React from 'react';
import { createRoot } from 'react-dom/client';
const assert = (value, message) => { if (!value) throw Error(message); };
const rejects = async (operation, pattern) => { try { await operation(); } catch (error) { assert(pattern.test(error.message), 'wrong rejection: '+error.message); return; } throw Error('expected rejection '+pattern); };
const originalFetch = fetch.bind(window);
const artifacts = (name, bytes) => originalFetch('/artifact/'+name, { method:'POST', body:bytes });
const fixtures = await (await fetch('/fixtures')).json();
let lastJob, lastTask;
for (const fixture of fixtures) {
  const files = fixture.files.map(file => {
    const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
    const f = new File([bytes], file.name.split('/').pop()); Object.defineProperty(f,'webkitRelativePath',{value:file.name}); return f;
  });
  const imported = await importAtlas(files, fixture.descriptions);
  assert(imported.manifest.pages.length===2 && imported.manifest.regions.length===3, fixture.kind+' multi-page & shared rect');
  assert(imported.manifest.regions[0].names.length===2, 'alias merged');
  const inputs = await atlasPackInputs(imported);
  assert(new Set(inputs.map(i=>i.originalPath)).size===3, 'unique PNG input paths');
  const images = new Map();
  const items = inputs.map((input, index) => {
    const bytes=Uint8Array.from(atob(input.dataUrl.split(',')[1]), c=>c.charCodeAt(0));
    images.set('original-'+index, bytes); images.set('result-'+index,bytes);
    return {...input,id:String(index),originalImage:'original-'+index,resultImage:'result-'+index,status:'done'};
  });
  for(let i=0;i<inputs.length;i++) await artifacts(fixture.kind+'/input-'+i+'.png', images.get('original-'+i));
  window.fetch = async (url, options) => {
    if(String(url).startsWith('/api/reskin-images/')) { const data=images.get(decodeURIComponent(String(url).split('/').pop())); return new Response(data,{status:data?200:404}); }
    return originalFetch(url, options);
  };
  const task={schemaVersion:1,id:'fixture-pack',name:'Fixture atlas',sourceTaskId:'fixture-job',style:{name:'Ice',prompt:'ice'},items,status:'done',createdAt:1,updatedAt:1};
  const identity=await exportAtlas(imported,task);
  for(let i=0;i<2;i++) await artifacts(fixture.kind+'/identity-page-'+i+'.png',identity.pages.get(imported.manifest.pages[i].path));
  const zip=await JSZip.loadAsync(identity.blob);
  assert(Object.values(zip.files).filter(f=>!f.dir).length===files.length,'exact ZIP file count');
  for(const [name,bytes] of imported.files) if(!imported.manifest.pages.some(p=>p.path===name)) {
    const out=await zip.file(name).async('uint8array'); assert(out.length===bytes.length&&out.every((v,i)=>v===bytes[i]),'original descriptor/sidecar/JPEG bytes '+name);
  }
  const replacement=new Uint8Array(inputs[0].width*inputs[0].height*4);
  for(let i=0;i<replacement.length;i+=4) replacement.set([201,45,17,128],i);
  images.set('result-0',await encodeAtlasPng({width:inputs[0].width,height:inputs[0].height,data:replacement}));
  items[1].status='failed'; items[1].error='controlled failure';
  items[2].status='interrupted'; items[2].error='server restart';
  const partial=await exportAtlas(imported,task);
  assert(partial.report.includes('回填 1 / 3')&&partial.report.includes('controlled failure'),'partial report');
  for(let i=0;i<2;i++) await artifacts(fixture.kind+'/changed-page-'+i+'.png',partial.pages.get(imported.manifest.pages[i].path));
  await artifacts(fixture.kind+'/export.zip',partial.blob);
  const edged=await exportAtlas(imported,task,1);
  await artifacts(fixture.kind+'/edged-page-0.png',edged.pages.get(imported.manifest.pages[0].path));
  images.delete('result-0');
  const missing=await exportAtlas(imported,task);
  const unchanged=new Uint8Array(await missing.pages.get(imported.manifest.pages[0].path).arrayBuffer());
  const originalPage=imported.files.get(imported.manifest.pages[0].path);
  assert(unchanged.length===originalPage.length&&unchanged.every((v,i)=>v===originalPage[i]),'unreadable result preserves original page bytes');
  const zipped=new JSZip(); for(const [name,bytes] of imported.files) zipped.file(name,bytes);
  const zipBytes=await zipped.generateAsync({type:'uint8array'});
  const fromZip=await importAtlas([new File([zipBytes],'atlas.zip')],fixture.descriptions);
  assert(JSON.stringify(fromZip.manifest)===JSON.stringify(imported.manifest),'folder & ZIP same manifest');
  const bad=new Map(imported.files); bad.delete(imported.manifest.pages[0].path);
  await rejects(()=>parseAtlasFiles(bad,fixture.descriptions),/缺少/);
  const badPng=new Uint8Array(imported.files.get(imported.manifest.pages[0].path)); badPng[42]^=1;
  await rejects(()=>decodeAtlasPng(badPng),/CRC/);
  lastTask=task; lastJob={id:'fixture-job',name:'Fixture atlas',manifest:imported.manifest,files:[...imported.files.keys()].map(path=>({path,asset:'0.bin'})),packTaskId:task.id,createdAt:1,updatedAt:1};
}
const page=fixtures[0].files.find(f=>f.name==='root/pages/one.png');
const pageBytes=Uint8Array.from(atob(page.base64),c=>c.charCodeAt(0));
const invalidJson = async root => parseAtlasFiles(new Map([['sheet.json',new TextEncoder().encode(JSON.stringify(root))],['page.png',pageBytes]]));
const frame={frame:{x:3,y:3,w:3,h:2},rotated:true,trimmed:true,sourceSize:{w:7,h:6},spriteSourceSize:{x:2,y:1,w:3,h:2}};
const valid={frames:{sprite:frame},meta:{image:'page.png',size:{w:18,h:14}}};
await rejects(()=>invalidJson({unknown:{}}),/schema/);
await rejects(()=>invalidJson({...valid,meta:{image:'../page.png'}}),/逃逸/);
await rejects(()=>invalidJson({...valid,frames:{sprite:{...frame,frame:{x:17,y:3,w:3,h:2}}}}),/超出/);
await rejects(()=>invalidJson({...valid,frames:{sprite:{...frame,vertices:[]}}}),/polygon/);
await rejects(()=>invalidJson({...valid,meta:{...valid.meta,pma:true}}),/PMA/);
await rejects(()=>invalidJson({...valid,frames:{sprite:{...frame,rotated:180}}}),/boolean/);
await rejects(()=>invalidJson({...valid,frames:{sprite:{...frame,spriteSourceSize:{x:6,y:1,w:3,h:2}}}}),/trim/);
await rejects(()=>invalidJson({...valid,meta:{...valid.meta,size:{w:99,h:14}}}),/尺寸/);
await rejects(()=>parseAtlasFiles(new Map([['sheet.plist',new TextEncoder().encode('bplist00blah')]])),/binary/);
await rejects(()=>parseAtlasFiles(new Map([['sheet.plist',new TextEncoder().encode('<plist version="1.0"><dict><key>metadata</key><dict><key>format</key><integer>1</integer></dict></dict></plist>')]])),/format/);
const spine = 'page.png\nsize:18,14\npma: false\nregion\nrotate:180\nbounds:3,3,3,2\n';
await rejects(()=>parseAtlasFiles(new Map([['sheet.atlas',new TextEncoder().encode(spine)],['page.png',pageBytes]])),/0\/90/);
const overlap={...valid,frames:{one:frame,two:{...frame,frame:{x:4,y:3,w:3,h:2}}}};
await rejects(()=>invalidJson(overlap),/重叠/);
const unsafe=new JSZip(); unsafe.file('../evil.png',pageBytes);
await rejects(async()=>inspectAtlasZip(await unsafe.generateAsync({type:'uint8array'})),/不安全/);
const dup=new JSZip();dup.file('A.png',pageBytes);dup.file('a.png',pageBytes);
await rejects(async()=>inspectAtlasZip(await dup.generateAsync({type:'uint8array'})),/重复/);
await rejects(()=>importAtlas([new File([new Uint8Array(20*1024*1024+1)],'large.png')]),/20 MB/);
// Conflicting padding is rejected; default edge=0 remains a valid export.
const tight=await invalidJson({frames:{one:{frame:{x:0,y:0,w:2,h:2}}},meta:valid.meta});
const tightInput=(await atlasPackInputs(tight))[0];
const tightBytes=Uint8Array.from(atob(tightInput.dataUrl.split(',')[1]),c=>c.charCodeAt(0));
window.fetch=async()=>new Response(tightBytes);
await rejects(()=>exportAtlas(tight,{...lastTask,items:[{...tightInput,id:'tight',status:'done',originalImage:'o',resultImage:'r'}]},1),/越界|邻区/);
// Exercise the webpage import -> save -> C create/run -> preview chain with controlled HTTP responses.
const sourceFixture=fixtures[0];let uiJobs=[];let uiTasks=[];let uiImported;let createdItems;let runs=0;const uiImages=new Map();
window.fetch=async(url,options)=>{
  const p=String(url);const body=options?.body?JSON.parse(options.body):undefined;
  if(p==='/api/atlas-jobs'){
    if(!body)return Response.json(uiJobs);
    const entries=body.files.map(f=>[f.path,Uint8Array.from(atob(f.base64),c=>c.charCodeAt(0))]);
    uiImported=await parseAtlasFiles(new Map(entries),body.descriptions);
    const saved={id:'ui-job',name:body.name,manifest:uiImported.manifest,files:entries.map(([path])=>({path,asset:'0.bin'})),createdAt:1,updatedAt:1};
    uiJobs=[saved];return Response.json(saved,{status:201});
  }
  if(p==='/api/atlas-jobs/ui-job/link'){assert(body.packTaskId==='ui-pack','link uses C task ID');uiJobs[0]={...uiJobs[0],packTaskId:body.packTaskId};return Response.json(uiJobs[0]);}
  if(p.startsWith('/api/atlas-jobs/ui-job/files/')){const i=Number(p.split('/').pop());return new Response(uiImported.files.get(uiJobs[0].files[i].path));}
  if(p==='/api/reskin-tasks'){
    if(!body)return Response.json(uiTasks);
    assert(body.sourceTaskId==='ui-job','Pack source is saved atlas job');createdItems=body.items;
    assert(body.items.length===3&&body.items.every(i=>i.originalPath.startsWith('atlas-regions/')&&i.format==='png'),'only upright region PNGs enter C, never whole pages');
    const items=[];
    for(let i=0;i<body.items.length;i++){
      const item=body.items[i];const bytes=Uint8Array.from(atob(item.dataUrl.split(',')[1]),c=>c.charCodeAt(0));uiImages.set('ui-original-'+i,bytes);
      await artifacts('ui/original-'+i+'.png',bytes);
      items.push({...item,id:String(i),originalImage:'ui-original-'+i,status:'pending'});
    }
    const saved={schemaVersion:1,id:'ui-pack',name:body.name,sourceTaskId:body.sourceTaskId,items,style:body.style,status:'idle',createdAt:1,updatedAt:1};uiTasks=[saved];return Response.json(saved,{status:201});
  }
  if(p==='/api/reskin-tasks/ui-pack/run'){runs++;uiTasks[0]={...uiTasks[0],status:'done',items:uiTasks[0].items.map((item,i)=>({...item,status:i===0?'done':'failed',resultImage:i===0?item.originalImage:undefined,error:i===0?undefined:'controlled UI failure'}))};return Response.json(uiTasks[0],{status:202});}
  if(p==='/api/reskin-tasks/ui-pack')return Response.json(uiTasks[0]);
  if(p.startsWith('/api/reskin-images/'))return new Response(uiImages.get(p.split('/').pop()));
  return originalFetch(url,options);
};
localStorage.removeItem('gameui-atlas-selected-job');
const uiHost=document.createElement('div');document.body.append(uiHost);const uiRoot=createRoot(uiHost);
uiRoot.render(React.createElement(AtlasTool,{busy:false,onBusyChange:()=>{}}));
const waitFor=async(predicate,description)=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error(description+': '+uiHost.textContent);};
await waitFor(()=>uiHost.querySelector('input'),'tool mounts');
const change=(node,value)=>{const prototype=node.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));};
change(uiHost.querySelector('input'),sourceFixture.descriptions.join(','));await new Promise(r=>setTimeout(r,10));
const selectedFiles=sourceFixture.files.map(file=>{const f=new File([Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0))],file.name.split('/').pop());Object.defineProperty(f,'webkitRelativePath',{value:file.name});return f;});
const chooser=uiHost.querySelectorAll('input[type=file]')[1];Object.defineProperty(chooser,'files',{value:selectedFiles});chooser.dispatchEvent(new Event('change',{bubbles:true}));
await waitFor(()=>Array.from(uiHost.querySelectorAll('button')).some(b=>b.textContent==='保存原图集'),'draft import');
Array.from(uiHost.querySelectorAll('button')).find(b=>b.textContent==='保存原图集').click();
await waitFor(()=>uiJobs.length===1&&uiHost.textContent.includes('原文件和 region 映射已保存'),'original save');
change(uiHost.querySelector('textarea'),'controlled ice style');await new Promise(r=>setTimeout(r,10));
Array.from(uiHost.querySelectorAll('button')).find(b=>b.textContent==='开始 region 换肤').click();
await waitFor(()=>uiHost.textContent.includes('Pack ui-pack')&&uiHost.textContent.includes('controlled UI failure'),'C create/run states');
assert(runs===1&&createdItems.length===3,'webpage invokes existing C run exactly once');
Array.from(uiHost.querySelectorAll('button')).find(b=>b.textContent==='检查回填页').click();
await waitFor(()=>uiHost.querySelectorAll('.atlas-pages figure').length===4,'original and rebuilt page preview');
assert(uiHost.textContent.includes('回填 1 / 3'),'webpage export report');
await Promise.all(Array.from(uiHost.querySelectorAll('img')).map(image=>image.decode()));
await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
assert((await originalFetch('/preview',{method:'POST'})).ok,'real Edge UI screenshot');
uiRoot.unmount();
// Component restoration is read-only, including a remount. It must never create or run AI work.
let paidCalls=0;
window.fetch=async(url,options)=>{
  const p=String(url);
  if(p==='/api/atlas-jobs') return Response.json([lastJob]);
  if(p==='/api/reskin-tasks/'+lastTask.id) return Response.json(lastTask);
  if(p.startsWith('/api/reskin-tasks')&&options?.method==='POST'){paidCalls++;throw Error('unexpected paid call');}
  return originalFetch(url,options);
};
localStorage.setItem('gameui-atlas-selected-job',lastJob.id);
const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('component timeout: '+host.textContent);};
root.render(React.createElement(AtlasTool,{key:'first',busy:false,onBusyChange:()=>{},styles:[{id:'ice',name:'Ice',prompt:'ice'}]}));
await until(()=>host.textContent.includes('Pack fixture-pack'));
assert(host.querySelectorAll('.atlas-regions article').length===3,'regions restored');
const first=host.querySelector('.atlas-regions article');
root.render(React.createElement(AtlasTool,{key:'second',busy:false,onBusyChange:()=>{}}));
await until(()=>host.querySelector('.atlas-regions article')&&host.querySelector('.atlas-regions article')!==first&&host.textContent.includes('Pack fixture-pack'));
assert(paidCalls===0,'no generation on mount or refresh');root.unmount();
document.body.textContent='PASS';
`;
const compiled = await build({ stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'atlas-browser-test.ts' }, bundle: true, platform: 'browser', format: 'esm', write: false,
  outfile:path.join(directory,'browser.js'),logLevel:'warning' });
const jsOutput=compiled.outputFiles.find(file=>file.path.endsWith('.js')).contents;
const cssOutput=compiled.outputFiles.find(file=>file.path.endsWith('.css')).contents;
await fs.writeFile(path.join(directory, 'browser.js'), jsOutput);
await fs.writeFile(path.join(directory, 'browser.css'), cssOutput);
let debugPort;
async function screenshot(){
  assert.ok(debugPort,'Edge DevTools is ready');
  const tabs=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const tab=tabs.find(tab=>tab.type==='page'&&tab.url.startsWith(`http://127.0.0.1:${server.address().port}/`));assert.ok(tab,'Atlas fixture page available');
  const socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  try{
    const result=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('Edge screenshot timeout')),10000);
      socket.onmessage=event=>{const message=JSON.parse(event.data);if(message.id===1){clearTimeout(timeout);if(message.error)reject(Error(JSON.stringify(message.error)));else resolve(message.result);}};
      socket.send(JSON.stringify({id:1,method:'Page.captureScreenshot',params:{format:'png',captureBeyondViewport:true,fromSurface:true}}));
    });
    await fs.writeFile(path.join(directory,'ui-preview.png'),Buffer.from(result.data,'base64'));
  }finally{socket.close();}
}
let resolveResult; const finished = new Promise(resolve => { resolveResult = resolve; });
const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/result') { const parts=[]; for await(const part of req) parts.push(part); resolveResult(JSON.parse(Buffer.concat(parts))); res.end('ok'); return; }
    if (req.url === '/fixtures') { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(fixtures)); return; }
    if(req.url==='/preview'){await screenshot();res.end('ok');return;}
    if(req.url.startsWith('/api/reskin-images/ui-original-')){
      const match=/^\/api\/reskin-images\/ui-original-(\d+)$/.exec(req.url);assert.ok(match);
      res.setHeader('Content-Type','image/png');res.end(await fs.readFile(path.join(directory,'ui',`original-${match[1]}.png`)));return;
    }
    if(req.url.startsWith('/api/atlas-jobs/ui-job/files/')){
      const index=Number(req.url.split('/').pop());const file=fixtures[0].files[index];assert.ok(file);
      res.setHeader('Content-Type',file.name.endsWith('.png')?'image/png':'application/octet-stream');res.end(Buffer.from(file.base64,'base64'));return;
    }
    if(req.url.startsWith('/api/')){res.statusCode=404;res.end();return;}
    if (req.url.startsWith('/artifact/')) {
      const relative = req.url.slice('/artifact/'.length);
      assert.match(relative,/^[a-z0-9-]+\/[a-z0-9-]+\.(png|zip)$/);
      const target=path.join(directory,relative); await fs.mkdir(path.dirname(target),{recursive:true});
      const parts=[]; for await(const part of req) parts.push(part); await fs.writeFile(target,Buffer.concat(parts));res.end('ok');return;
    }
    if(req.url==='/browser.js'){res.setHeader('Content-Type','application/javascript');res.end(jsOutput);return;}
    if(req.url==='/browser.css'){res.setHeader('Content-Type','text/css');res.end(cssOutput);return;}
    res.setHeader('Content-Type','text/html');res.end(`<head><link rel="stylesheet" href="/browser.css"><style>body{background:#101828;color:#e9eef9;font-family:system-ui;margin:24px}</style></head><body>Atlas fixtures<script type="module">try{await import('/browser.js');await fetch('/result',{method:'POST',body:JSON.stringify({ok:true})});}catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:error.stack})});}</script>`);
  } catch(error){res.statusCode=500;res.end(error.stack);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browserPath=process.env.ATLAS_BROWSER??'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser=spawn(browserPath,['--headless=new','--no-first-run','--disable-gpu','--disable-extensions','--window-size=1440,1200','--remote-debugging-port=0',`--user-data-dir=${path.join(directory,'profile')}`,`http://127.0.0.1:${server.address().port}`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
const stderr=await fs.open(path.join(directory,'edge-stderr.log'),'a');
browser.stderr.on('data',chunk=>{void stderr.write(chunk);const match=/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());if(match)debugPort=Number(match[1]);});
browser.on('error',error=>resolveResult({ok:false,error:error.message}));
const timeout=setTimeout(()=>resolveResult({ok:false,error:'Real Edge timeout (60s)'}),60000);
try {
  const result=await finished; assert.ok(result.ok,result.error);
  // Independent libvips decoder and manually built expected pixels, not parser self-confirmation.
  for(const [relative,wanted] of expected){
    const actual=await sharp(await fs.readFile(path.join(directory,relative))).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(actual.info.width,wanted.width,relative+' width'); assert.equal(actual.info.height,wanted.height,relative+' height');
    assert.deepEqual(actual.data,wanted.data,relative+' exact RGBA including transparent RGB and alpha=1/127');
  }
  for(const fixture of fixtures){
    const zip=await JSZip.loadAsync(await fs.readFile(path.join(directory,fixture.kind,'export.zip')));
    const names=Object.values(zip.files).filter(f=>!f.dir).map(f=>f.name).sort();
    assert.deepEqual(names,fixture.files.map(f=>f.name).sort());
    for(const file of fixture.files.filter(f=>!f.name.startsWith('root/pages/'))) assert.deepEqual(await zip.file(file.name).async('nodebuffer'),Buffer.from(file.base64,'base64'),file.name+' original bytes');
  }
  console.log(`PASS real Edge: 7 schemas, CW/CCW rotation, trim, 2 pages, aliases, folder/ZIP, ${expected.size} independent sharp pixel comparisons, changed-only rectangle, failures, descriptor/EXIF-JPEG bytes, range/path/schema/PMA/polygon/binary rejection, React refresh; artifacts=${directory}`);
}finally{clearTimeout(timeout);browser.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await stderr.close();}
