import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import sharp from 'sharp';

const directory = await fs.mkdtemp(path.resolve('.data/drawing-browser-'));
process.env.GAMEUI_DATA = directory;
const serverBundle = path.join(directory, 'drawing-server.mjs');
await build({ entryPoints: ['server/drawingApi.ts'], bundle: true, platform: 'node', format: 'esm', outfile: serverBundle, external: ['sharp'], logLevel: 'warning' });
const { createDrawingHandler } = await import(pathToFileURL(serverBundle).href);
const events = [];
let released = false;
const resultImage = async (size) => {
  const [width, height] = size.split('x').map(Number);
  return sharp({ create: { width: width / 32, height: height / 32, channels: 3, background: '#7ec4aa' } }).png().toBuffer();
};
const drawing = createDrawingHandler({
  async generateImage(args) {
    events.push({ kind: 'generate', ...args });
    const inputPrompt = args.prompt.split('\n\nCanvas requirements:')[0];
    if (inputPrompt === 'edge-pending') return { pendingId: 'edge-pending-id', isError: false, text: 'still running' };
    // Reproduce a valid provider result whose aspect ratio differs from the requested canvas.
    return { base64: (await resultImage('1024x1024')).toString('base64'), isError: false, text: 'controlled browser ratio mismatch fixture' };
  },
  async waitForGeneration(args) {
    events.push({ kind: 'wait', ...args });
    while (!released) await delay(30);
    return { base64: (await resultImage('1024x1536')).toString('base64'), isError: false, text: 'controlled browser pending fixture' };
  },
});
const reference = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#d58e52' } }).png().toBuffer();
const fixtures = {
  png: { mime: 'image/png', bytes: reference },
  jpeg: { mime: 'image/jpeg', bytes: await sharp(reference).withMetadata({ orientation: 6 }).jpeg().toBuffer() },
  webp: { mime: 'image/webp', bytes: await sharp(reference).webp().toBuffer() },
};

const entry = String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DrawingTool } from './src/components/DrawingTool';
const assert = (value, message) => { if (!value) throw Error(message); };
const until = async (predicate, message) => {
  for (let attempt = 0; attempt < 600; attempt++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(message + ': ' + document.body.innerText);
};
const state = async () => (await fetch('/api/drawing/state')).json();
function App() { const [busy, setBusy] = useState(false); return React.createElement(DrawingTool, {busy, onBusyChange:setBusy, styles:[]}); }
const host = document.getElementById('app');
createRoot(host).render(React.createElement(App));
await until(() => host.querySelector('#drawing-prompt') && !host.textContent.includes('正在恢复生成记录'), 'load component');
const typePrompt = async (value) => {
  const textarea = host.querySelector('#drawing-prompt');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea, value);
  textarea.dispatchEvent(new Event('input',{bubbles:true}));
  await until(() => !host.querySelector('.drawing-generate').disabled, 'prompt React update');
};
const phase = sessionStorage.getItem('drawing-test-phase');
if (phase !== 'after-reload') {
  const transfer = new DataTransfer();
  for (const [index, format] of ['png','jpeg','webp','png','png'].entries()) {
    const blob = await (await fetch('/fixture/' + format)).blob();
    transfer.items.add(new File([blob], 'ref-' + index + '.' + format, {type:blob.type}));
  }
  const input = host.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change',{bubbles:true}));
  await until(() => host.querySelectorAll('.drawing-reference').length === 5 && !host.querySelector('#drawing-prompt').disabled, 'five reference uploads saved');
  assert(host.querySelector('input[type=file]').disabled,'sixth reference prevented');
  await until(() => [...host.querySelectorAll('.drawing-reference img')].every(image=>image.complete && image.naturalWidth>0), 'reference browser decode');
  const jpegPreview = host.querySelectorAll('.drawing-reference img')[1];
  assert(jpegPreview.naturalWidth===8 && jpegPreview.naturalHeight===12,'EXIF JPEG browser upload displays upright 8x12');
  await typePrompt('edge-first');
  host.querySelector('input[value="3:2"]').click();
  host.querySelector('.drawing-generate').click();
  await until(async () => (await state()).tasks.some(task => task.prompt==='edge-first' && task.status==='done'), 'first fixture job done');
  await until(() => host.querySelector('.drawing-result-image img')?.naturalWidth===32, 'first result browser decode');
  assert(host.querySelector('.drawing-snapshot').textContent.includes('实际 32×32'),'actual result size shown separately');
  assert(host.querySelector('.drawing-results > .drawing-ratio-warning')?.textContent.includes('实际 32×32，请求 3:2'),'visible preview ratio warning');
  assert(host.querySelector('.drawing-history .drawing-ratio-warning')?.textContent.includes('实际 32×32，请求 3:2'),'visible history ratio warning');
  const mismatchDownload = await fetch(host.querySelector('.drawing-result-actions a[download]').href);
  const mismatchBitmap = await createImageBitmap(await mismatchDownload.blob());
  assert(mismatchBitmap.width===32 && mismatchBitmap.height===32,'mismatched result remains downloadable without stretching or cropping'); mismatchBitmap.close();
  await typePrompt('edge-pending'); host.querySelector('input[value="2:3"]').click(); host.querySelector('.drawing-generate').click();
  await until(async () => (await state()).tasks.some(task=>task.prompt==='edge-pending' && task.status==='running'),'server pending before refresh');
  sessionStorage.setItem('drawing-test-phase','after-reload');
  location.reload();
} else {
  await until(() => host.querySelectorAll('.drawing-history > button').length===2, 'history restored after actual page reload');
  assert(host.querySelector('#drawing-prompt').value==='edge-pending','draft prompt restored');
  assert(host.querySelector('input[value="2:3"]').checked,'draft ratio restored');
  assert(host.querySelectorAll('.drawing-reference').length===5,'reference file IDs restored');
  await fetch('/release',{method:'POST'});
  await until(() => host.querySelector('.drawing-result-image img')?.naturalHeight===48,'pending result survives actual reload');
  const restored = await state(); const task = restored.tasks.find(task=>task.prompt==='edge-pending');
  assert(task.ratio==='2:3' && task.size==='1024x1536','requested ratio snapshot preserved');
  assert(task.resultSize.width===32 && task.resultSize.height===48,'actual decode dimensions persisted');
  host.querySelector('.drawing-result-image button').click();
  await until(() => host.querySelector('dialog')?.open && host.querySelector('dialog img')?.naturalHeight===48,'result native dialog preview');
  host.querySelector('dialog button').click();
  const firstHistory = [...host.querySelectorAll('.drawing-history > button')].find(button=>button.textContent.includes('edge-first'));
  firstHistory.click(); await until(() => host.querySelector('.drawing-result-image img')?.naturalHeight===32,'history result selection');
  assert(host.querySelector('.drawing-results > .drawing-ratio-warning')?.textContent.includes('请求 3:2'),'mismatch warning restored from history after reload');
  const pendingHistory = [...host.querySelectorAll('.drawing-history > button')].find(button=>button.textContent.includes('edge-pending'));
  pendingHistory.click(); await until(() => host.querySelector('.drawing-result-image img')?.naturalHeight===48,'return to restored result');
  assert(!host.querySelector('.drawing-results > .drawing-ratio-warning'),'matching ratio must not display a warning');
  const download = host.querySelector('.drawing-result-actions a[download]');
  const response = await fetch(download.href); assert(response.headers.get('content-type')==='image/png','download mime PNG');
  assert(response.headers.get('content-disposition').includes('attachment'),'download attachment header');
  const bitmap = await createImageBitmap(await response.blob()); assert(bitmap.width===32 && bitmap.height===48,'download bytes decode'); bitmap.close();
  download.click();
  await fetch('/result',{method:'POST',body:JSON.stringify({ok:true, agent:navigator.userAgent, resultId:task.result})});
}
`;
const compiled = await build({ stdin: { contents: entry, sourcefile: 'drawing-browser-fixture.tsx', resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'esm', outfile: path.join(directory, 'browser.js'), write: false, logLevel: 'warning' });
for (const output of compiled.outputFiles) await fs.writeFile(output.path, output.contents);
let resolveResult;
const finished = new Promise((resolve) => { resolveResult = resolve; });
const server = http.createServer((req, res) => {
  void drawing.handle(req, res, async () => {
    try {
      if (req.url === '/result') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        resolveResult(JSON.parse(Buffer.concat(chunks).toString())); res.end('ok'); return;
      }
      if (req.url === '/release' && req.method === 'POST') { released = true; res.end('ok'); return; }
      const format = req.url?.match(/^\/fixture\/(png|jpeg|webp)$/)?.[1];
      if (format) { res.setHeader('Content-Type',fixtures[format].mime); res.end(fixtures[format].bytes); return; }
      if (req.url === '/browser.js' || req.url === '/browser.css') {
        res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'application/javascript');
        res.end(await fs.readFile(path.join(directory, req.url.slice(1)))); return;
      }
      res.setHeader('Content-Type','text/html');
      res.end(`<html><head><link rel="stylesheet" href="/browser.css"><style>body{margin:0;background:#0e141c;font-family:Arial,sans-serif}</style></head><body><div id="app"></div><script type="module">try{await import('/browser.js')}catch(error){await fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:error.stack})})}</script></body></html>`);
    } catch (error) { res.statusCode = 500; res.end(error.message); }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browserPath = process.env.DRAWING_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--disable-gpu', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${path.join(directory, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
const browserLog = await fs.open(path.join(directory, 'edge-stderr.log'), 'a');
let resolveDebugger;
const debuggerReady = new Promise((resolve) => { resolveDebugger = resolve; });
let debugOutput = '';
browser.stderr.on('data', (chunk) => {
  void browserLog.appendFile(chunk);
  debugOutput += chunk.toString();
  const endpoint = debugOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
  if (endpoint) resolveDebugger(endpoint);
});
browser.once('error', (error) => resolveResult({ok:false,error:error.message}));
const timeout = setTimeout(() => resolveResult({ok:false,error:'Edge fixture timed out after 60 seconds'}), 60000);
let socket;
try {
  const endpoint = await Promise.race([debuggerReady, finished.then((result) => { throw Error(result.error); })]);
  socket = new WebSocket(endpoint); await once(socket, 'open');
  let nextId = 1; const pending = new Map();
  socket.addEventListener('message',(event) => {
    const message = JSON.parse(event.data); const request = pending.get(message.id);
    if (!request) return; pending.delete(message.id);
    if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result);
  });
  const command = (method, params = {}, sessionId) => new Promise((resolve,reject) => {
    const id = nextId++; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params,sessionId}));
  });
  const downloads = path.join(directory, 'downloads'); await fs.mkdir(downloads);
  await command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  const target = await command('Target.createTarget',{url:`http://127.0.0.1:${server.address().port}`});
  const result = await finished; assert.ok(result.ok,result.error);
  let files = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    files = (await fs.readdir(downloads)).filter((file)=>file.endsWith('.png'));
    if (files.length) break; await delay(30);
  }
  assert.equal(files.length,1,'real Edge anchor download completed to isolated evidence directory');
  const downloaded = await sharp(await fs.readFile(path.join(downloads, files[0]))).metadata();
  assert.equal(downloaded.format,'png'); assert.equal(downloaded.width,32); assert.equal(downloaded.height,48);
  assert.equal(events.filter((event)=>event.kind==='generate').length,2,'reload must not create a third paid request');
  assert.ok(events.filter((event)=>event.kind==='generate').every(event=>event.prompt.includes('Canvas requirements: Request a ') && event.prompt.includes('do not crop the main subject')),'provider receives canvas instructions');
  const attached = await command('Target.attachToTarget',{targetId:target.targetId,flatten:true});
  await command('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false},attached.sessionId);
  const screenshot = await command('Page.captureScreenshot',{format:'png'},attached.sessionId);
  await fs.writeFile(path.join(directory,'drawing-edge.png'),Buffer.from(screenshot.data,'base64'));
  await fs.writeFile(path.join(directory,'provider-events.json'),JSON.stringify(events,null,2));
  console.log(JSON.stringify({ok:true,browser:result.agent,tests:'real DrawingTool + HTTP server + disk; five refs PNG/EXIF JPEG/WebP, ratio snapshots, actual reload while pending, history, native preview, real anchor download',provider:'controlled job fixture, no paid model acceptance claimed',evidence:directory}));
} finally {
  clearTimeout(timeout); released=true; drawing.stop(); socket?.close(); browser.kill(); server.closeAllConnections(); await new Promise((resolve)=>server.close(resolve)); await browserLog.close();
}
