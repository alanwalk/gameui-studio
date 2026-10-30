import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import sharp from 'sharp';

async function serve(api) {
  const middlewares=[];
  const vite={middlewares:{use(fn){middlewares.push(fn);}}};
  api.registerAtlasApi(vite); api.registerReskinApi(vite);
  const server=http.createServer((req,res)=>{
    let index=0;
    const next=()=>{const fn=middlewares[index++];if(fn)void fn(req,res,next);else{res.statusCode=404;res.end();}};
    next();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,base:`http://127.0.0.1:${server.address().port}`};
}
const request = async (base,route,body) => {
  const response=await fetch(base+route,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {code:response.status,body:await response.json()};
};

if(process.argv.includes('--child')){
  const api=await import(pathToFileURL(process.env.ATLAS_TEST_BUNDLE).href);
  const {server,base}=await serve(api);
  try{
    const listed=await request(base,'/api/atlas-jobs'); assert.equal(listed.code,200);assert.equal(listed.body.length,1);
    const job=listed.body[0]; assert.ok(job.packTaskId);
    const pack=await request(base,'/api/reskin-tasks/'+job.packTaskId);
    assert.equal(pack.body.status,'interrupted');assert.equal(pack.body.items[0].status,'interrupted');
    assert.equal(pack.body.items[0].pendingId,'saved-provider-id');
    const restored=await request(base,'/api/atlas-jobs/'+job.id);assert.deepEqual(restored.body,job);
    for(let i=0;i<job.files.length;i++)assert.equal((await fetch(base+`/api/atlas-jobs/${job.id}/files/${i}`)).status,200);
    console.log('PASS isolated fresh-process API recovery: atlas manifest/pages/assets/PackTask ID, pending task preserved; zero model calls');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}else{
  const directory=await fs.mkdtemp(path.resolve('.data/atlas-server-')); process.env.GAMEUI_DATA=path.join(directory,'data');
  const bundle=path.join(directory,'server.mjs');
  const imports=['server/atlasApi.ts','server/atlasStore.ts','server/reskinApi.ts','server/reskinStore.ts'].map(p=>`export * from '${path.resolve(p).replaceAll('\\','/')}';`).join('\n');
  await build({stdin:{contents:imports,resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:bundle,external:['sharp'],logLevel:'warning',
    plugins:[{name:'controlled-provider',setup(builder){
      builder.onResolve({filter:/\/magpieMcp$/},()=>({path:'provider',namespace:'test'}));
      builder.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const generateImage=(args)=>globalThis.atlasProvider.generate(args); export const waitForGeneration=(args)=>globalThis.atlasProvider.wait(args);'}));
    }}]});
  const api=await import(pathToFileURL(bundle).href);
  const pixels=Buffer.alloc(12*10*4);for(let i=0;i<pixels.length;i+=4)pixels.set([i%251,37,81,255],i);
  const png=await sharp(pixels,{raw:{width:12,height:10,channels:4}}).png().toBuffer();
  const metadata=Buffer.from('\uFEFF{\r\n "frames": {"button":{"frame":{"x":2,"y":2,"w":3,"h":2},"rotated":true,"trimmed":true,"spriteSourceSize":{"x":1,"y":1,"w":3,"h":2},"sourceSize":{"w":5,"h":4}}},\r\n "meta":{"image":"../pages/one.png","size":{"w":12,"h":10}}\r\n}\r\n');
  const jpeg=await sharp({create:{width:3,height:5,channels:3,background:'#326789'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const originalFiles=[{path:'root/meta/sheet.json',bytes:metadata},{path:'root/pages/one.png',bytes:png},{path:'root/other/oriented.jpg',bytes:jpeg},{path:'root/other/keep.json',bytes:Buffer.from('{"other":true}\n')},{path:'root/empty.bin',bytes:Buffer.alloc(0)}];
  const payload={name:'Fixture atlas',descriptions:['root/meta/sheet.json'],files:originalFiles.map(f=>({path:f.path,base64:f.bytes.toString('base64')}))};
  const {server,base}=await serve(api);
  let generated=0;
  globalThis.atlasProvider={async generate(args){generated++;assert.equal(args.referenceImages.length,1);const image=await sharp(args.referenceImages[0]).metadata();assert.equal(image.width,5);assert.equal(image.height,4);return {base64:(await fs.readFile(args.referenceImages[0])).toString('base64'),text:'controlled',isError:false};},async wait(){throw Error('no waits in this phase');}};
  try{
    for(const invalid of [
      {...payload,files:[...payload.files,{...payload.files[0],path:'../evil.json'}]},
      {...payload,files:[...payload.files,payload.files[0]]},
      {...payload,files:payload.files.filter(f=>!f.path.endsWith('one.png'))},
      {...payload,files:payload.files.map((f,i)=>i===0?{...f,base64:Buffer.from('{"unknown":true}').toString('base64')}:f)},
      {...payload,files:payload.files.map((f,i)=>i===0?{...f,base64:Buffer.from(metadata.toString().replace('"w":3','"w":999')).toString('base64')}:f)},
      {...payload,files:payload.files.map((f,i)=>i===1?{...f,base64:Buffer.from('not PNG').toString('base64')}:f)},
      {...payload,files:payload.files.map((f,i)=>i===1?{...f,base64:'a==='}:f)},
    ]) assert.equal((await request(base,'/api/atlas-jobs',invalid)).code,400);
    assert.equal((await request(base,'/api/atlas-jobs')).body.length,0,'invalid uploads leave no manifest');
    const saved=await request(base,'/api/atlas-jobs',payload);assert.equal(saved.code,201);const job=saved.body;
    assert.equal(job.manifest.regions.length,1);assert.equal(job.manifest.pages.length,1);assert.ok(job.files.find(f=>f.image));
    for(let i=0;i<originalFiles.length;i++)assert.deepEqual(Buffer.from(await(await fetch(base+`/api/atlas-jobs/${job.id}/files/${i}`)).arrayBuffer()),originalFiles[i].bytes);
    const manifestDisk=await fs.readFile(path.join(process.env.GAMEUI_DATA,'atlas',job.id,'manifest.json'),'utf8');
    assert.ok(!manifestDisk.includes('base64')&&!manifestDisk.includes('data:image')&&!manifestDisk.includes('Canvas'),'only file references in persisted JSON');
    assert.equal((await request(base,`/api/atlas-jobs/${job.id}/link`,{packTaskId:'absent'})).code,400);
    const region=job.manifest.regions[0];
    const inputPng=await sharp({create:{width:5,height:4,channels:4,background:'#123456'}}).png().toBuffer();
    const input={originalPath:region.inputPath,width:5,height:4,format:'png',dataUrl:`data:image/png;base64,${inputPng.toString('base64')}`};
    const created=await request(base,'/api/reskin-tasks',{name:job.name,sourceTaskId:job.id,style:{name:'Ice',prompt:'ice'},items:[input]});
    assert.equal(created.code,201);const task=created.body;
    assert.equal((await request(base,`/api/atlas-jobs/${job.id}/link`,{packTaskId:task.id})).code,200);
    assert.equal((await request(base,`/api/reskin-tasks/${task.id}/run`,{})).code,202);
    let final;
    for(let i=0;i<200;i++){final=(await request(base,`/api/reskin-tasks/${task.id}`)).body;if(final.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(final.items[0].status,'done');assert.equal(generated,1,'one region uses C provider once');assert.equal(final.items[0].orientation,1);
    const result=await fetch(base+'/api/reskin-images/'+final.items[0].resultImage);assert.equal(result.status,200);
    await api.updateReskinTask(task.id,current=>{current.status='running';current.items[0].status='running';current.items[0].submitted=true;current.items[0].pendingId='saved-provider-id';});
    const invalidTask=await api.createReskinTask({...task,id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',items:[{...task.items[0],originalPath:'wrong.png'}]});
    assert.equal((await request(base,`/api/atlas-jobs/${job.id}/link`,{packTaskId:invalidTask.id})).code,400);
    assert.equal((await fetch(base+`/api/atlas-jobs/${job.id}/files/999`)).status,400);
    assert.equal((await request(base,'/api/atlas-jobs/not-an-id')).code,400);
    console.log(`PASS atlas API: authoritative reparse, path/range/schema/corruption rejection, exact original descriptor/JPEG/page bytes, refs-only manifests, C create/run/link/image services; artifacts=${directory}`);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  const child=spawn(process.execPath,[path.resolve('scripts/test-atlas-server.mjs'),'--child'],{env:{...process.env,ATLAS_TEST_BUNDLE:bundle},windowsHide:true,stdio:['ignore','pipe','pipe']});
  const stdout=[];const stderr=[];child.stdout.on('data',part=>stdout.push(part));child.stderr.on('data',part=>stderr.push(part));
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  await fs.writeFile(path.join(directory,'recovery.stdout.log'),Buffer.concat(stdout));await fs.writeFile(path.join(directory,'recovery.stderr.log'),Buffer.concat(stderr));
  assert.equal(code,0,Buffer.concat(stderr).toString());console.log(Buffer.concat(stdout).toString().trim());
}
