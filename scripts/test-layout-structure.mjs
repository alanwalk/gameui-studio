import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundle=await build({entryPoints:['src/lib/layoutStructure.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {normalizeHierarchy,descendantIds,transformLayoutGroup,alignmentRect,orderedLayout,moveLayoutNode}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const nodes=[{id:'child',kind:'button',name:'child',rect:{x:.2,y:.2,w:.1,h:.1}},
 {id:'group',kind:'container',name:'group',rect:{x:.1,y:.1,w:.8,h:.8}},
 {id:'icon',kind:'icon',name:'icon',rect:{x:.22,y:.22,w:.04,h:.04}}];
const normalized=normalizeHierarchy(nodes);
assert.equal(normalized[0].parentId,'group');assert.equal(normalized[2].parentId,'group');
assert.equal(nodes[0].parentId,undefined);
assert.deepEqual(orderedLayout(normalized).map(node=>node.id),['group','child','icon']);
assert.equal(descendantIds(normalized,'group').size,3);
const moved=transformLayoutGroup(normalized,'group',{x:.15,y:.15,w:.4,h:.4});
assert.ok(Math.abs(moved[0].rect.x-.2)<1e-10);assert.equal(moved[0].rect.w,.05);
assert.deepEqual(alignmentRect(nodes[0].rect,nodes[1].rect,'right'),{x:.8,y:.2,w:.1,h:.1});
const explicit=normalizeHierarchy([{...nodes[0],parentId:null},nodes[1]]);assert.equal(explicit[0].parentId,null);
assert.equal(orderedLayout([{...nodes[0],parentId:'group'},{...nodes[1],parentId:'child'}]).length,2);
console.log('PASS hierarchy migration, explicit roots, group transform, draw order, descendants, alignment and corrupt-cycle guard');
const tree=[{...nodes[1],id:'a',parentId:null},{...nodes[0],id:'one',parentId:'a'},
 {...nodes[1],id:'nested',parentId:'a'}, {...nodes[2],id:'two',parentId:'nested'}, {...nodes[1],id:'b',parentId:null}];
const movedLeaf=moveLayoutNode(tree,'one','b','inside');
assert.equal(movedLeaf.find(node=>node.id==='one').parentId,'b');
assert.deepEqual(movedLeaf.find(node=>node.id==='one').rect,tree[1].rect);
assert.equal(tree[1].parentId,'a');
const movedGroup=moveLayoutNode(tree,'nested','b','before');
assert.equal(movedGroup.find(node=>node.id==='nested').parentId,null);
assert.equal(movedGroup.find(node=>node.id==='two').parentId,'nested');
assert.deepEqual(movedGroup.map(node=>node.id),['a','one','nested','two','b']);
assert.equal(moveLayoutNode(tree,'a','two','after'),tree);
assert.equal(moveLayoutNode(tree,'a','nested','inside'),tree);
for (const kind of ['container','panel','button','icon','text','image','progress']) {
 const targets=tree.map(node=>node.id==='two'?{...node,kind}:node);
 const nested=moveLayoutNode(targets,'one','two','inside');
 assert.equal(nested.find(node=>node.id==='one').parentId,'two');
 assert.deepEqual(nested.find(node=>node.id==='one').rect,tree[1].rect);
 assert.equal(moveLayoutNode(nested,'two','one','inside'),nested);
}
assert.equal(moveLayoutNode(tree,'one','one','before'),tree);
const roots=moveLayoutNode(tree,'nested',null,'after');
assert.equal(roots.find(node=>node.id==='nested').parentId,null);
assert.deepEqual(roots.slice(-2).map(node=>node.id),['nested','two']);
console.log('PASS tree drag reorder, all node types as parents, subtree moves, immutable coordinates, root drop and cycle rejection');
