import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
const base='http://127.0.0.1:5174';const id='test-tree-drag-'+randomUUID();const name='树拖动测试 '+id;
const directory=await fs.mkdtemp('./.data/tree-drag-');
async function api(body,method='PUT'){
 const response=await fetch(base+'/api/projects',body?{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
 assert.ok(response.ok);return response.json();
}
const nodes=[{id:'group-a',name:'GroupA',kind:'container',parentId:null,rect:{x:.05,y:.05,w:.4,h:.8}},
 {id:'leaf-a',name:'LeafA',kind:'button',parentId:'group-a',rect:{x:.1,y:.1,w:.2,h:.1}},
 {id:'leaf-b',name:'LeafB',kind:'icon',parentId:'group-a',rect:{x:.1,y:.4,w:.1,h:.1}},
 {id:'group-b',name:'GroupB',kind:'panel',parentId:null,rect:{x:.55,y:.1,w:.4,h:.7}}];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 await api({project:{id,name,orientation:'portrait',size:{w:800,h:1200},stylePrompt:'',createdAt:1,updatedAt:1,screens:[{id:id+'-screen',name:'界面',usage:'',layout:nodes,versions:[]}]}});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base);await page.locator('.home-project-open').filter({hasText:name}).click();
 const open=async()=>{const card=page.locator('.screen-card').first();await card.locator('.screen-preview-frame').first().hover();await card.getByRole('button',{name:'编辑布局',exact:true}).click();};
 await open();const editor=page.getByRole('dialog',{name:'布局编辑器',exact:true});
 const surface=editor.getByLabel('线稿无限画布',{exact:true});
 const canvas=surface.locator('canvas');
 const initialCanvas=await canvas.boundingBox();
 const surfaceBox=await surface.boundingBox();
 assert.ok(surfaceBox.height>200);
 const leafPick=editor.locator('[data-node-id="leaf-a"] .layout-tree-pick');
 await leafPick.click();
 assert.equal(await editor.locator('.node-properties').count(),1);
 await leafPick.click();
 assert.equal(await editor.locator('.node-properties').count(),0);
 await editor.getByRole('button',{name:'AI 规划线稿',exact:true}).waitFor();
 await leafPick.click();
 await surface.click({position:{x:10,y:30}});
 assert.equal(await editor.locator('.node-properties').count(),0);
 await leafPick.click();
 const raster=await canvas.evaluate(element=>[element.width,element.height]);
 await page.mouse.move(initialCanvas.x+initialCanvas.width/2,initialCanvas.y+initialCanvas.height/2);
 await page.mouse.wheel(0,-200);
 await page.waitForTimeout(100);
 const zoomedCanvas=await canvas.boundingBox();
 assert.ok(zoomedCanvas.width>initialCanvas.width);
 assert.deepEqual(await canvas.evaluate(element=>[element.width,element.height]),raster);
 const beforePan=await surface.locator('.panzoom-world').getAttribute('style');
 await page.mouse.move(surfaceBox.x+10,surfaceBox.y+30);
 await page.mouse.down();await page.mouse.move(surfaceBox.x+55,surfaceBox.y+60,{steps:5});await page.mouse.up();
 assert.notEqual(await surface.locator('.panzoom-world').getAttribute('style'),beforePan);
 assert.equal(await editor.locator('[data-node-id="leaf-a"].active').count(),1,'panning preserves selection');
 // Node movement uses screen coordinates correctly after camera zoom and pan.
 const movedCanvas=await canvas.boundingBox();
 await page.mouse.move(movedCanvas.x+movedCanvas.width*.15,movedCanvas.y+movedCanvas.height*.45);
 await page.mouse.down();
 await page.mouse.move(movedCanvas.x+movedCanvas.width*.18,movedCanvas.y+movedCanvas.height*.47,{steps:5});
 await page.mouse.up();
 const nodeX=Number(await editor.getByLabel('节点x',{exact:true}).inputValue());
 assert.ok(Math.abs(nodeX-.13)<.003);
 await editor.getByRole('button',{name:'撤销',exact:true}).click();
 await surface.getByRole('button',{name:/适应/}).click();
 const row=nodeId=>editor.locator(`.layout-tree-row[data-node-id="${nodeId}"]`);
 const order=()=>editor.locator('.layout-tree-row').evaluateAll(rows=>rows.map(row=>row.dataset.nodeId));
 await row('leaf-a').dragTo(row('leaf-b'));
 await row('leaf-b').getByRole('button',{name:'展开或收起 LeafB',exact:true}).waitFor();
 assert.deepEqual(await order(),['group-a','leaf-b','leaf-a','group-b']);
 await editor.getByRole('button',{name:'撤销',exact:true}).click();
 await row('leaf-a').dragTo(row('group-b'));
 await page.waitForFunction(()=>{
   const rows=[...document.querySelectorAll('.layout-tree-row')];
   return rows.map(row=>row.dataset.nodeId).join(',')==='group-a,leaf-b,group-b,leaf-a';
 });
 assert.equal(await editor.getByText('所属容器',{exact:true}).count(),0);
 assert.ok(await row('leaf-a').evaluate(element=>element.getBoundingClientRect().height)<=28);
 const original=(await api()).projects.find(project=>project.id===id).screens[0].layout;
 assert.deepEqual(original,nodes,'drag edits remain local until Use');
 await row('leaf-b').dragTo(row('group-a'),{targetPosition:{x:80,y:2}});
 assert.deepEqual(await order(),['leaf-b','group-a','group-b','leaf-a']);
 await editor.getByRole('button',{name:'撤销',exact:true}).click();
 assert.deepEqual(await order(),['group-a','leaf-b','group-b','leaf-a']);
 await editor.getByRole('button',{name:'重做',exact:true}).click();
 const beforeInvalid=await order();
 await row('group-b').dragTo(row('leaf-a'));
 assert.deepEqual(await order(),beforeInvalid,'cannot drag parent into descendant');
 await editor.getByRole('button',{name:'保存关闭',exact:true}).click();await editor.waitFor({state:'detached'});
 const saved=(await api()).projects.find(project=>project.id===id).screens[0].layout;
 assert.equal(saved.find(node=>node.id==='leaf-a').parentId,'group-b');assert.equal(saved.find(node=>node.id==='leaf-b').parentId,null);
 for(const node of nodes)assert.deepEqual(saved.find(entry=>entry.id===node.id).rect,node.rect);
 await page.reload();await page.locator('.home-project-open').filter({hasText:name}).click();await open();
 assert.deepEqual(await order(),['leaf-b','group-a','group-b','leaf-a']);
 await page.screenshot({path:directory+'/tree.png'});assert.deepEqual(errors,[]);
 page.once('dialog',dialog=>dialog.accept());await page.keyboard.press('Escape');
 console.log('PASS native browser tree drag/reparent/reorder, cycle guard, local draft, undo/redo, saved hierarchy/coordinates and reload; '+directory);
}finally{await browser.close();await api({id},'DELETE');}
