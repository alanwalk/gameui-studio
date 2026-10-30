import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const directory = await fs.mkdtemp('./.data/infinite-canvas-');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:5174/');
  await page.locator('.screen-card').first().waitFor();
  assert.equal(await page.locator('.project-overview .overview-toolbar').count(),0);
  assert.equal(await page.locator('.project-overview').getByRole('button',{name:'导出',exact:true}).count(),0);
  assert.equal(await page.locator('.project-overview .project-style-readout').count(),0);
  const createButton=page.locator('.canvas-create-project');
  const createPosition=await createButton.boundingBox();
  assert.equal(await page.getByRole('button',{name:'整包换肤',exact:true}).count(),0,'removed feature is absent from navigation');
  assert.equal(await page.getByRole('slider').count(),0);
  const layout = () => page.locator('.canvas-world .screen-card').evaluateAll(cards => cards.map(card => ({
    x:card.offsetLeft,y:card.offsetTop,w:card.offsetWidth,h:card.offsetHeight,
    frameHeight:card.querySelector('.screen-preview-frame').offsetHeight,
  })));
  const camera = () => page.locator('.canvas-world').evaluate(element => {
    const matrix=new DOMMatrix(getComputedStyle(element).transform);
    return { x:matrix.e,y:matrix.f,zoom:matrix.a };
  });
  const original=await layout();
  const viewport=await page.getByLabel('无限画布',{exact:true}).boundingBox();
  const pointer={x:viewport.x+300,y:viewport.y+200};
  const before=await camera();
  await page.mouse.move(pointer.x,pointer.y);
  await page.mouse.wheel(0,-350);
  await page.waitForTimeout(100);
  const after=await camera();
  assert.ok(after.zoom>before.zoom);
  assert.deepEqual(await layout(),original,'zoom cannot resize or reflow cards');
  const worldBefore=(pointer.x-viewport.x-before.x)/before.zoom;
  const worldAfter=(pointer.x-viewport.x-after.x)/after.zoom;
  assert.ok(Math.abs(worldBefore-worldAfter)<.01,'zoom stays anchored to pointer');
  const gapX=viewport.x+after.x+532*after.zoom;
  const gapY=viewport.y+after.y+150*after.zoom;
  await page.mouse.move(gapX,gapY);
  await page.mouse.down();
  await page.mouse.move(gapX-120,gapY-70,{steps:8});
  await page.mouse.up();
  const panned=await camera();
  const finalCreatePosition=await createButton.boundingBox();
  assert.equal(finalCreatePosition.x+finalCreatePosition.width,createPosition.x+createPosition.width,'new-project right edge stays fixed while the canvas pans and zooms');
  assert.equal(finalCreatePosition.y,createPosition.y);
  assert.ok(Math.abs(panned.x-after.x+120)<.01);
  assert.ok(Math.abs(panned.y-after.y+70)<.01);
  await page.setViewportSize({width:1366,height:900});
  assert.deepEqual(await layout(),original,'viewport resize cannot rearrange world cards');
  await page.getByRole('button',{name:'重置画布视图'}).click();
  assert.deepEqual(await camera(),{x:24,y:24,zoom:1});
  await page.locator('.screen-preview-frame').first().hover();
  await page.locator('.screen-card').first().getByRole('button',{name:'编辑布局',exact:true}).click();
  await page.getByRole('dialog',{name:'布局编辑器',exact:true}).waitFor();
  page.once('dialog',dialog=>dialog.accept());
  await page.keyboard.press('Escape');
  await page.screenshot({path:directory+'/canvas.png'});
  assert.deepEqual(errors,[]);
  console.log('PASS pointer-anchored wheel zoom, fixed card geometry, pan, no resize reflow, reset and card actions; '+directory);
} finally {await browser.close();}
