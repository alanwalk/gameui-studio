import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const original={id:'menu-style',name:'森林画风',prompt:'明亮的森林游戏',image:'style-one.png',referenceImages:['style-one.png','style-two.png'],createdAt:1};
let styles=[structuredClone(original)];
let failSave=false;
const deletes=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
  const page=await browser.newPage({viewport:{width:782,height:884}});
  await page.route('**/api/project-render/tasks',route=>route.fulfill({contentType:'application/json',body:'[]'}));
  await page.route('**/api/styles',async route=>{
    const request=route.request();
    if(request.method()==='PUT') {
      if(failSave) {
        failSave=false;
        await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟风格保存失败'})});
        return;
      }
      const saved=request.postDataJSON().style;
      styles=[...styles.filter(style=>style.id!==saved.id),saved];
    }
    if(request.method()==='DELETE') {
      const id=request.postDataJSON().id;
      deletes.push(id);
      styles=styles.filter(style=>style.id!==id);
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify({styles})});
  });
  await page.goto('http://127.0.0.1:5174/');
  await page.getByRole('tab',{name:'我的画风',exact:true}).click();
  const row=page.locator('.home-project-row').filter({hasText:'森林画风'}).first();
  const menu=row.locator('.home-item-menu');
  await menu.waitFor();
  await row.locator('.home-style-open').click();
  const details=page.getByRole('main',{name:'画风详情',exact:true});
  await details.waitFor();
  assert.equal((await details.boundingBox()).width,782);
  assert.equal(await page.locator('.styles').count(),0,'open the selected style rather than the collection');
  assert.equal(await details.getByRole('heading',{name:original.name,exact:true}).count(),1);
  const prompt=details.getByLabel('画风提示词',{exact:true});
  assert.equal(await prompt.inputValue(),original.prompt);
  assert.equal(await prompt.getAttribute('readonly'),'');
  assert.equal(await details.locator('.style-details-gallery figure').count(),2);
  await details.getByRole('button',{name:'预览参考图 2',exact:true}).click();
  const preview=page.getByRole('dialog',{name:'参考图预览',exact:true});
  await preview.waitFor();
  assert.ok((await preview.getByRole('link',{name:'下载原图',exact:true}).getAttribute('href')).includes('style-two.png'));
  await preview.getByRole('button',{name:'关闭参考图预览',exact:true}).click();
  await details.getByRole('button',{name:'编辑风格',exact:true}).click();
  const editor=page.getByRole('main',{name:'编辑风格',exact:true});
  await editor.waitFor();
  assert.equal((await editor.boundingBox()).width,782);
  assert.equal(await page.getByRole('dialog',{name:'编辑风格',exact:true}).count(),0);
  await editor.getByLabel('名称',{exact:true}).fill('取消的名称');
  await editor.getByRole('button',{name:'移除',exact:true}).first().click();
  await editor.getByRole('button',{name:'取消编辑',exact:true}).click();
  await details.waitFor();assert.deepEqual(styles,[original]);
  await details.getByRole('button',{name:'编辑风格',exact:true}).click();
  await editor.getByLabel('风格提示词',{exact:true}).fill('保存后的画风提示词');
  await editor.getByRole('button',{name:'移除',exact:true}).first().click();
  failSave=true;
  await editor.getByRole('button',{name:'保存到风格库',exact:true}).click();
  await page.locator('.toast-item').filter({hasText:'模拟风格保存失败'}).waitFor();
  assert.equal(await editor.getByLabel('风格提示词',{exact:true}).inputValue(),'保存后的画风提示词');
  await editor.getByRole('button',{name:'保存到风格库',exact:true}).click();
  await details.waitFor();
  assert.equal(styles[0].id,original.id);
  assert.equal(styles[0].createdAt,original.createdAt);
  assert.deepEqual(styles[0].referenceImages,['style-two.png']);
  Object.assign(original,structuredClone(styles[0]));
  await details.getByRole('button',{name:'← 我的画风',exact:true}).click();
  assert.equal(await page.getByRole('tab',{name:'我的画风',exact:true}).getAttribute('aria-selected'),'true');
  await page.mouse.move(700,100);
  await page.locator(':focus').evaluateAll(elements=>elements.forEach(element=>element.blur()));
  assert.equal(await menu.evaluate(el=>getComputedStyle(el).opacity),'0');
  await row.hover();
  assert.equal(await menu.evaluate(el=>getComputedStyle(el).opacity),'1');
  await menu.locator('summary').click();
  await menu.getByRole('button',{name:'复制画风',exact:true}).click();
  await page.locator('.home-style-open').filter({hasText:'森林画风 副本'}).waitFor();
  const copy=styles.find(style=>style.id!==original.id);
  assert.equal(copy.name,'森林画风 副本');
  assert.deepEqual(copy.referenceImages,original.referenceImages);
  assert.equal(copy.prompt,original.prompt);
  assert.deepEqual(styles.find(style=>style.id===original.id),original);
  const copyRow=page.locator('.home-project-row').filter({hasText:'森林画风 副本'});
  await copyRow.hover();await copyRow.locator('summary').click();
  await copyRow.getByRole('button',{name:'删除画风',exact:true}).click();
  const confirmation=page.getByRole('dialog',{name:'删除画风',exact:true});
  await confirmation.getByRole('button',{name:'取消',exact:true}).click();
  assert.equal(deletes.length,0);
  await copyRow.hover();await copyRow.locator('summary').click();
  await copyRow.getByRole('button',{name:'删除画风',exact:true}).click();
  await confirmation.getByRole('button',{name:'确认删除',exact:true}).click();
  await confirmation.waitFor({state:'detached'});
  assert.deepEqual(deletes,[copy.id]);
  assert.deepEqual(styles,[original]);
  await page.reload();await page.getByRole('tab',{name:'我的画风',exact:true}).click();
  assert.equal(await page.locator('.home-style-open').count(),1);
  console.log('PASS style menu hover, copy/new ID/all references, delete cancel/confirm, original preservation and refreshed list; style API mocked');
} finally { await browser.close(); }
