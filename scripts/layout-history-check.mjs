import assert from 'node:assert/strict';
import { LayoutHistory } from '../src/lib/layoutHistory.ts';
import { applyDrag, Handle } from '../src/lib/layout.ts';

const history = new LayoutHistory();
const key = 'project-a/screen-a';
const node = { id: 'button', name: '按钮', kind: 'button', rect: { x: .1, y: .1, w: .2, h: .1 } };
const first = [node];
let passed = 0;
function check(name, run) { run(); passed += 1; console.log(`PASS ${name}`); }
check('empty history cannot undo or redo', () => assert.deepEqual(history.state(key), { canUndo: false, canRedo: false }));
history.record(key, [], first);
check('add can undo to empty', () => assert.deepEqual(history.undo(key), []));
check('add can redo', () => assert.deepEqual(history.redo(key), first));
const renamed = [{ ...node, name: '领取奖励' }];
history.record(key, first, renamed);
check('property edit undo restores name', () => assert.equal(history.undo(key)[0].name, '按钮'));
check('redo returns copied snapshots', () => {
  const result = history.redo(key);
  result[0].rect.x = .99;
  history.undo(key);
  assert.equal(history.redo(key)[0].rect.x, .1);
});
history.record(key, renamed, []);
check('delete undo restores node', () => assert.equal(history.undo(key)[0].name, '领取奖励'));
history.undo(key);
const planned = [{ ...node, id: 'planned' }, { ...node, id: 'planned-2' }];
history.record(key, first, planned);
check('AI replacement is one undo step', () => assert.deepEqual(history.undo(key), first));
check('editing after undo discards old redo branch', () => {
  history.record(key, first, renamed);
  assert.equal(history.redo(key), null);
});
check('project and screen keys isolate histories', () => {
  history.record('project-b/screen-a', [], planned);
  history.record('project-a/screen-b', [], renamed);
  assert.deepEqual(history.undo('project-b/screen-a'), []);
  assert.deepEqual(history.undo('project-a/screen-b'), []);
  assert.equal(history.undo(key)[0].name, '按钮');
});
check('drag previews become one committed history entry', () => {
  const dragHistory = new LayoutHistory();
  let preview = node.rect;
  for (let delta = 1; delta <= 40; delta++) preview = applyDrag(node.rect, Handle.Move, delta, delta, 400, 800);
  dragHistory.record(key, first, [{ ...node, rect: preview }]);
  assert.deepEqual(dragHistory.undo(key), first);
  assert.equal(dragHistory.undo(key), null);
  assert.deepEqual(dragHistory.redo(key)[0].rect, preview);
});
check('no movement does not add history', () => {
  const same = new LayoutHistory();
  same.record(key, first, structuredClone(first));
  assert.equal(same.undo(key), null);
});
check('input snapshots cannot mutate recorded history', () => {
  const isolated = new LayoutHistory();
  const input = structuredClone(first);
  isolated.record(key, [], input);
  input[0].rect.y = .8;
  isolated.undo(key);
  assert.equal(isolated.redo(key)[0].rect.y, .1);
});
console.log(`${passed} layout history checks passed`);
