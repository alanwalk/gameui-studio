import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';
import sharp from 'sharp';

const directory = await fs.mkdtemp(path.resolve('.data/pack-server-'));
process.env.GAMEUI_DATA = directory;
const bundle = path.join(directory, 'server.mjs');
const apiPath = path.resolve('server/reskinApi.ts').replaceAll('\\', '/');
const storePath = path.resolve('server/reskinStore.ts').replaceAll('\\', '/');
const codecPath = path.resolve('server/imageCodec.ts').replaceAll('\\', '/');
await build({ stdin: { contents: `export * from '${apiPath}'; export * from '${storePath}'; export * from '${codecPath}';`, resolveDir: process.cwd() }, bundle: true, packages: 'external', platform: 'node', format: 'esm', outfile: bundle,
  plugins: [{ name: 'controlled-provider', setup(builder) {
    builder.onResolve({ filter: /\/magpieMcp$/ }, () => ({ path: 'provider', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const generateImage=(args)=>globalThis.packProvider.generate(args); export const waitForGeneration=(args)=>globalThis.packProvider.wait(args);' }));
  } }],
});

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  const data = Buffer.concat([Buffer.from(name), bytes]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(data));
  return Buffer.concat([header, data, crc]);
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2); ihdr.writeUInt32BE(3, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc(3 * 9, 0))), chunk('IEND', Buffer.alloc(0))]);
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
await fs.mkdir(path.join(directory, 'fixtures'), { recursive: true });
await fs.writeFile(path.join(directory, 'fixtures', 'button.png'), png);
const input = (originalPath) => ({ originalPath, format: 'png', width: 2, height: 3, dataUrl });
let generated = 0;
let waited = 0;
let mode = 'success';
let providerBytes = png;
let release;
globalThis.packProvider = {
  async generate(args) {
    generated++;
    assert.equal(args.referenceImages.length, 1);
    const reference = await sharp(await fs.readFile(args.referenceImages[0])).raw().toBuffer({resolveWithObject:true});
    assert.equal(reference.info.width,2);
    assert.equal(reference.info.height,3);
    if (mode === 'blocked') await new Promise((resolve) => { release = resolve; });
    if (mode === 'pending' || mode === 'wait-fail') return { pendingId: 'known-generation', text: 'pending', isError: false };
    if (mode === 'unknown') throw Error('controlled disconnect before acknowledgement');
    return { base64: providerBytes.toString('base64'), text: 'controlled success', isError: false };
  },
  async wait(args) {
    waited++;
    if (args.pendingId) assert.equal(args.pendingId, 'known-generation');
    assert.ok(path.isAbsolute(args.watchPath));
    if (mode === 'wait-fail') throw Error('controlled timeout');
    if (!args.pendingId && mode === 'unknown') throw Error('controlled missing output');
    return { base64: png.toString('base64'), text: 'controlled recovered', isError: false };
  },
};
const api = await import(pathToFileURL(bundle).href);
let middleware;
api.registerReskinApi({ middlewares: { use(callback) { middleware = callback; } } });
const server = http.createServer((req, res) => { void middleware(req, res, () => { res.statusCode = 404; res.end(); }); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/reskin-tasks`;
async function request(suffix = '', body) {
  const response = await fetch(base + suffix, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { code: response.status, body: await response.json() };
}
const payload = (items = [input('root/a/button.png'), input('root/b/button.png')]) => ({ name: 'fixture pack', style: { name: 'Ice', prompt: 'ice', id: 'style-1' }, sourceTaskId: 'slice-123', items });
async function settled(id) {
  for (let i = 0; i < 150; i++) {
    const { body } = await request(`/${id}`);
    if (body.status !== 'running') return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('controlled task did not settle');
}
try {
  for (const invalid of [payload([input('../evil.png')]), payload([input('A.png'), input('a.png')]), payload([{ ...input('bad.jpg'), format: 'jpeg', dataUrl: dataUrl.replace('image/png', 'image/jpeg') }]), payload([{ ...input('bad.png'), width: 999 }]), payload([{ ...input('bad.png'), dataUrl: 'data:image/png;base64,YmFk' }]), payload(Array.from({ length: 301 }, (_, i) => input(`${i}.png`)))]) {
    assert.equal((await request('', invalid)).code, 400);
  }
  const corrupt = Buffer.from(png);
  corrupt[41] ^= 0xff;
  assert.equal((await request('', payload([{...input('corrupt.png'),dataUrl:`data:image/png;base64,${corrupt.toString('base64')}`}]))).code,400);
  const invalidHeader = Buffer.from(ihdr); invalidHeader[9] = 255;
  const invalidPng = Buffer.concat([png.subarray(0,8),chunk('IHDR',invalidHeader),chunk('IDAT',deflateSync(Buffer.alloc(27,255))),chunk('IEND',Buffer.alloc(0))]);
  const invalidWebp = Buffer.alloc(30);
  invalidWebp.write('RIFF'); invalidWebp.writeUInt32LE(22,4); invalidWebp.write('WEBP',8); invalidWebp.write('VP8X',12);
  invalidWebp.writeUInt32LE(10,16); invalidWebp.writeUIntLE(1,24,3); invalidWebp.writeUIntLE(2,27,3);
  const invalidJpeg = Buffer.from('ffd8ffc0000b080003000201011100ffd9','hex');
  for (const [format,bytes] of [['png',invalidPng],['jpeg',invalidJpeg],['webp',invalidWebp]]) {
    await fs.writeFile(path.join(directory,'fixtures',`malformed.${format}`),bytes);
    await assert.rejects(()=>api.decodeImage(bytes),/完整解码失败/,format);
    assert.equal((await request('',payload([{...input(`bad.${format}`),format,dataUrl:`data:image/${format};base64,${bytes.toString('base64')}`}]))).code,400);
  }
  const genuine = new Map();
  for (const format of ['png','jpeg','webp']) {
    const bytes = await sharp({create:{width:7,height:9,channels:4,background:'#b53c97'}}).toFormat(format).toBuffer();
    genuine.set(format,bytes);
    await fs.writeFile(path.join(directory,'fixtures',`actual.${format}`),bytes);
    const decoded = await api.decodeImage(bytes);
    assert.deepEqual([decoded.format,decoded.width,decoded.height,decoded.encodedWidth,decoded.encodedHeight,decoded.orientation],[format,7,9,7,9,1]);
    const normalized = await sharp(decoded.png).raw().toBuffer({resolveWithObject:true});
    assert.deepEqual([normalized.info.width,normalized.info.height],[7,9]);
    const imported = await request('',payload([{originalPath:`actual.${format}`,format,width:7,height:9,dataUrl:`data:image/${format};base64,${bytes.toString('base64')}`} ]));
    assert.equal(imported.code,201);
    const original = await fetch(base.replace('/reskin-tasks',`/reskin-images/${imported.body.items[0].originalImage}`));
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
  }
  await assert.rejects(()=>api.decodeImage(genuine.get('png'),{maxPixels:62}),/完整解码失败/);
  await assert.rejects(()=>api.decodeImage(genuine.get('png'),{maxBytes:10}),/超限/);
  const noise=Buffer.alloc(64*64*3);
  for(let i=0;i<noise.length;i++) noise[i]=(i*73+Math.floor(i/11)*29)%256;
  const compact=await sharp(noise,{raw:{width:64,height:64,channels:3}}).jpeg({quality:20}).toBuffer();
  assert.ok((await sharp(compact).png().toBuffer()).length>compact.length);
  await assert.rejects(()=>api.decodeImage(compact,{maxBytes:compact.length}),/规范 PNG 编码大小超限/);
  // Valid metadata with broken actual scan data must still fail the complete decoder.
  const pngChunks = [];
  const actualPng = genuine.get('png');
  for(let offset=8;offset<actualPng.length;) {
    const length=actualPng.readUInt32BE(offset);
    const type=actualPng.toString('ascii',offset+4,offset+8);
    const data=actualPng.subarray(offset+8,offset+8+length);
    pngChunks.push(chunk(type,type==='IDAT'?data.subarray(0,2):data));
    offset+=length+12;
  }
  const brokenPixelsPng=Buffer.concat([actualPng.subarray(0,8),...pngChunks]);
  const actualJpeg=genuine.get('jpeg');
  const sos=actualJpeg.indexOf(Buffer.from([0xff,0xda]));
  const brokenPixelsJpeg=Buffer.concat([actualJpeg.subarray(0,sos+2+actualJpeg.readUInt16BE(sos+2)),Buffer.from([0xff,0xd9])]);
  const brokenPixelsWebp=Buffer.from(genuine.get('webp'));
  brokenPixelsWebp[30]=255;
  for(const [format,bytes] of [['png',brokenPixelsPng],['jpeg',brokenPixelsJpeg],['webp',brokenPixelsWebp]]) {
    assert.equal((await sharp(bytes).metadata()).format,format,'metadata alone accepts damaged scan data');
    await assert.rejects(()=>api.decodeImage(bytes),/完整解码失败/,format);
    assert.equal((await request('',payload([{originalPath:`scan-broken.${format}`,format,width:7,height:9,dataUrl:`data:image/${format};base64,${bytes.toString('base64')}`}]))).code,400);
    await fs.writeFile(path.join(directory,'fixtures',`scan-broken.${format}`),bytes);
    const legacyReference=await api.saveReskinImage(bytes,format);
    const download=await fetch(base.replace('/reskin-tasks',`/reskin-images/${legacyReference}?validate=1`));
    assert.equal(download.status,400,'historical malformed result must fail strict download validation');
  }
  const gif = await sharp(genuine.get('png')).gif().toBuffer();
  await assert.rejects(()=>api.decodeImage(gif),/仅支持/);
  for (let orientation=1;orientation<=8;orientation++) {
    const bytes = await sharp(genuine.get('jpeg')).withMetadata({orientation}).jpeg().toBuffer();
    await fs.writeFile(path.join(directory,'fixtures',`orientation-${orientation}.jpg`),bytes);
    const display = orientation>=5 ? [9,7] : [7,9];
    const decoded = await api.decodeImage(bytes);
    assert.deepEqual([decoded.width,decoded.height,decoded.encodedWidth,decoded.encodedHeight,decoded.orientation],[...display,7,9,orientation]);
    const imported = await request('',payload([{originalPath:`orientation-${orientation}.jpg`,format:'jpeg',width:display[0],height:display[1],dataUrl:`data:image/jpeg;base64,${bytes.toString('base64')}`} ]));
    assert.equal(imported.code,201,JSON.stringify(imported.body));
    const item = imported.body.items[0];
    assert.deepEqual([item.width,item.height,item.encodedWidth,item.encodedHeight,item.orientation],[...display,7,9,orientation]);
    const original = await fetch(base.replace('/reskin-tasks',`/reskin-images/${item.originalImage}`));
    assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes,'original EXIF file bytes must remain exact');
  }
  let response = await request('', payload());
  assert.equal(response.code, 201);
  const task = response.body;
  assert.equal(task.sourceTaskId, 'slice-123');
  assert.equal(task.items.length, 2);
  assert.notEqual(task.items[0].originalImage, task.items[1].originalImage);
  assert.equal(task.style.prompt, 'ice');
  const original = await fetch(base.replace('/reskin-tasks', `/reskin-images/${task.items[0].originalImage}`));
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
  mode = 'blocked';
  assert.equal((await request(`/${task.id}/run`, {})).code, 202);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await request(`/${task.id}/run`, {})).code, 400);
  assert.equal((await request(`/${task.id}`)).body.items[0].submitted, true);
  assert.ok((await request(`/${task.id}`)).body.items[0].watchPath);
  // A fresh browser only reads HTTP; processing continues without a client connection.
  assert.equal((await request()).body.find(entry=>entry.id===task.id).status, 'running');
  mode = 'success'; release();
  let completed = await settled(task.id);
  assert.ok(completed.items.every((item) => item.status === 'done' && item.resultImage));
  assert.equal(generated, 2);
  assert.equal((await request(`/${task.id}/run`, { itemIds: [task.items[0].id] })).code, 400);

  mode = 'wait-fail';
  const pending = (await request('', payload([input('pending.png')]))).body;
  await request(`/${pending.id}/run`, {});
  let failed = await settled(pending.id);
  assert.equal(failed.items[0].status, 'failed');
  assert.equal(failed.items[0].pendingId, 'known-generation');
  const beforeRetry = generated;
  mode = 'success';
  await request(`/${pending.id}/run`, { itemIds: [pending.items[0].id] });
  completed = await settled(pending.id);
  assert.equal(generated, beforeRetry, 'known pending retry must not generate');
  assert.equal(completed.items[0].status, 'done');

  // Persist the exact disk state left by process termination, then run startup recovery.
  const restart = (await request('', payload([input('restart.png')]))).body;
  await api.updateReskinTask(restart.id, (record) => {
    record.status = 'running'; record.items[0].status = 'running';
    record.items[0].submitted = true; record.items[0].watchPath = path.join(directory, 'unknown.png');
  });
  await api.recoverReskinTasks();
  const interrupted = (await request(`/${restart.id}`)).body;
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.items[0].status, 'interrupted');
  assert.match(interrupted.items[0].error, /提交结果未知/);
  mode = 'unknown';
  await request(`/${restart.id}/run`, {});
  failed = await settled(restart.id);
  assert.equal(generated, beforeRetry, 'unknown submission must not generate silently');
  assert.equal(failed.items[0].status, 'failed');
  mode = 'success';
  await request(`/${restart.id}/run`, { itemIds: [restart.items[0].id], confirmRegenerate: true });
  completed = await settled(restart.id);
  assert.equal(completed.items[0].status, 'done');
  assert.equal(generated, beforeRetry + 1);

  const resume = (await request('', payload([input('resume.png')]))).body;
  await api.updateReskinTask(resume.id, (record) => {
    record.status = 'running'; record.items[0].status = 'running'; record.items[0].pendingId = 'known-generation';
    record.items[0].submitted = true; record.items[0].watchPath = path.join(directory, 'pending.png');
  });
  await api.recoverReskinTasks();
  await request(`/${resume.id}/run`, {});
  assert.equal((await settled(resume.id)).items[0].status, 'done');
  assert.equal(generated, beforeRetry + 1);
  assert.ok(waited >= 4);
  for (const [format,bytes] of [['png',invalidPng],['jpeg',invalidJpeg],['webp',invalidWebp],['png',brokenPixelsPng],['jpeg',brokenPixelsJpeg],['webp',brokenPixelsWebp]]) {
    providerBytes = bytes;
    const created = (await request('',payload([input(`provider-${format}.png`)]))).body;
    await request(`/${created.id}/run`,{});
    const failed = await settled(created.id);
    assert.equal(failed.items[0].status,'failed','malformed provider output must fail complete decode');
    assert.equal(failed.items[0].resultImage,undefined);
    assert.match(failed.items[0].error,/完整解码失败/);
  }
  for (const format of ['png','jpeg','webp']) {
    providerBytes = genuine.get(format);
    const created = (await request('',payload([input(`provider-real-${format}.png`)]))).body;
    await request(`/${created.id}/run`,{});
    const done = await settled(created.id);
    assert.equal(done.items[0].status,'done');
    const result = await fetch(base.replace('/reskin-tasks',`/reskin-images/${done.items[0].resultImage}`));
    assert.equal((await api.decodeImage(Buffer.from(await result.arrayBuffer()))).format,'png');
  }
  const index = JSON.parse(await fs.readFile(path.join(directory, 'reskin/tasks.json'), 'utf8'));
  assert.ok(index.every((entry) => entry.items.every((item) => !('dataUrl' in item))));
  assert.equal((await request('/missing')).code, 404);
  console.log(`PASS: full sharp PNG/JPEG/WebP decoding, malformed import/provider rejection, EXIF 1–8 display/encoded/original bytes, pixel/byte limits, HTTP refs, style snapshot, lock, disconnect, pending retry, restart recovery; artifacts=${directory}`);
} finally { await new Promise((resolve) => server.close(resolve)); }
