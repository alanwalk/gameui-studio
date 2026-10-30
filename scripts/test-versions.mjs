import assert from 'node:assert/strict';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const directory = await fs.mkdtemp(path.resolve('.data/test-versions-'));
const output = path.join(directory, 'versions.mjs');
await build({ entryPoints: ['src/lib/versions.ts'], bundle: true, platform: 'node', format: 'esm', outfile: output });
const { appendVersion, deleteVersion, updateVersionScreen, versionName, versionSource } = await import(pathToFileURL(output));
const renderOutput = path.join(directory, 'project-render.mjs');
await build({ entryPoints: ['src/lib/projectRender.ts'], bundle: true, platform: 'node', format: 'esm', outfile: renderOutput });
const { reserveProjectRender } = await import(pathToFileURL(renderOutput));
const original = { id: 'v1', image: 'source.png', prompt: 'original', createdAt: 1 };
const screen = { id: 's1', versions: [original], activeVersionId: 'v1', layout: [], name: 'A', usage: '' };
const child = { id: 'v2', image: 'child.png', prompt: 'gold button', createdAt: 2, parentVersionId: 'v1', operation: 'refine', styleSnapshot: { prompt: 'ice', image: 'ice.png' } };
const appended = appendVersion(screen, child);
assert.equal(screen.versions.length, 1, 'original snapshot untouched');
assert.equal(appended.versions[0].image, 'source.png');
assert.equal(appended.versions[0].name, 'V1');
assert.equal(appended.versions[1].name, 'V2');
assert.equal(appended.activeVersionId, 'v2');
assert.throws(() => appendVersion(screen, { ...child, image: undefined }));
assert.throws(() => appendVersion(appended, child));
const removedParent = deleteVersion(appended, 'v1');
assert.equal(removedParent.versions[0].image, 'child.png');
assert.equal(removedParent.versions[0].parentVersionId, 'v1');
assert.equal(removedParent.versions[0].name, 'V2');
assert.match(versionSource(removedParent.versions[0], removedParent.versions), /已删除/);
assert.equal(appendVersion(removedParent, { ...child, id: 'v3' }).versions.at(-1).name, 'V3');
assert.equal(deleteVersion(appended, 'v2').activeVersionId, 'v1');
assert.equal(deleteVersion(screen, 'v1').activeVersionId, undefined);
assert.equal(versionName(original, 0), 'V1');
assert.equal(versionSource(original, [original]), '历史版本');
const projects = [{ id: 'p1', screens: [screen, { ...screen, id: 's2' }] }, { id: 'p2', screens: [screen] }];
const targeted = updateVersionScreen(projects, 'p1', 's1', (current) => appendVersion(current, child));
assert.equal(targeted.screens[0].versions.length, 2);
assert.equal(targeted.screens[1].versions.length, 1);
assert.equal(projects[1].screens[0].versions.length, 1);
assert.equal(updateVersionScreen(projects, 'deleted', 's1', () => assert.fail()), undefined);
assert.equal(updateVersionScreen(projects, 'p1', 'deleted', () => assert.fail()), undefined);
const edited = updateVersionScreen([targeted], 'p1', 's1', (current) => ({ ...current, versions: current.versions.map((version) => version.id === 'v2' ? { ...version, name: '金色按钮', note: '保留布局' } : version) }));
const reloaded = JSON.parse(JSON.stringify(edited));
assert.equal(reloaded.screens[0].versions[1].note, '保留布局');
assert.equal(reloaded.screens[0].versions[1].styleSnapshot.image, 'ice.png');
assert.match(versionSource(reloaded.screens[0].versions[1], reloaded.screens[0].versions), /V1/);
let latest = projects;
let finish;
const modelResult = new Promise((resolve) => { finish = resolve; });
const pending = modelResult.then((version) => updateVersionScreen(latest, 'p1', 's1', (current) => appendVersion(current, version)));
latest = projects.map((project) => project.id === 'p1' ? { ...project, name: 'edited while waiting', screens: project.screens.map((entry) => entry.id === 's1' ? { ...entry, usage: 'latest usage', versions: [{ ...original, note: 'latest note' }] } : entry) } : project);
finish(child);
const completed = await pending;
assert.equal(completed.name, 'edited while waiting');
assert.equal(completed.screens[0].usage, 'latest usage');
assert.equal(completed.screens[0].versions[0].note, 'latest note');
assert.equal(completed.screens[1].versions.length, 1);
assert.equal(latest[1].screens[0].versions.length, 1);

// Execute the actual App action bodies with delayed model/project I/O; no copied business logic.
const appSource = await fs.readFile('src/App.tsx', 'utf8');
const ast = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map();
function collect(node) {
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, node.getText(ast));
    }
  }
  ts.forEachChild(node, collect);
}
collect(ast);
const names = ['commit', 'saveVersionScreen', 'startProjectRender', 'onRetryProjectRender', 'onRefine', 'onGenerate', 'onSaveVersion', 'onSelectProject'];
const keys = ['useCallback', 'projectsRef', 'setProjects', 'unsavedProjects', 'setPendingSaves', 'saveQueue', 'saveProject', 'setSaveError', 'busy', 'sliceSession', 'activeProject', 'activeScreen', 'activeVersion', 'styleSnapshot', 'setOperation', 'setVersionBusy', 'setError', 'setStatus', 'updateVersionScreen', 'appendVersion', 'projects', 'setActiveProjectId', 'setActiveScreenId', 'setSelectedNodeId', 'reserveProjectRender', 'listProjectRenders', 'submitProjectRender', 'setRenderTasks', 'loadImageElement', 'imageUrl', 'GENERATION_SIZE', 'renderWireframe', 'buildGenerationPrompt'];
const harnessSource = `export function harness(context) { const { ${keys.join(',')} } = context; ${names.map((name) => declarations.get(name)).join('\n')} return { ${names.join(',')} }; }`;
const harnessPath = path.join(directory, 'app-actions.mjs');
await fs.writeFile(harnessPath, ts.transpileModule(harnessSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
const { harness } = await import(pathToFileURL(harnessPath));
function scenario(saveProject) {
  const project = { id: 'p1', name: '项目一', orientation: 'landscape', size: { w: 12, h: 8 }, screens: [screen] };
  const other = { id: 'p2', name: '项目二', screens: [{ ...screen, id: 's2' }] };
  const state = { status: '旧的成功反馈', error: null, saveError: null, projectId: 'p1', submissions: [] };
  const context = {
    useCallback: (callback) => callback, projectsRef: { current: [project, other] },
    setProjects() {}, unsavedProjects: { current: new Map() }, setPendingSaves() {},
    saveQueue: { current: Promise.resolve() }, saveProject, setSaveError: (value) => { state.saveError = value; },
    busy: false, sliceSession: { hasUnsaved: false }, activeProject: project, activeScreen: screen, activeVersion: original,
    styleSnapshot: { prompt: 'ice' }, setOperation() {}, setVersionBusy() {}, setError: (value) => { state.error = value; },
    setStatus: (value) => { state.status = value; }, updateVersionScreen, appendVersion,
    reserveProjectRender, listProjectRenders: async () => [],
    submitProjectRender: async (input) => { state.submissions.push(structuredClone(input)); return { ...input, status: 'queued' }; },
    setRenderTasks() {}, loadImageElement: async () => ({ naturalWidth: 12, naturalHeight: 8 }), imageUrl: (file) => file,
    GENERATION_SIZE: { landscape: '12x8' }, renderWireframe: () => ({ toDataURL: () => 'data:image/png;base64,fixture' }),
    buildGenerationPrompt: () => 'captured generation prompt',
    projects: [project, other], setActiveProjectId: (id) => { state.projectId = id; }, setActiveScreenId() {}, setSelectedNodeId() {},
  };
  return { context, state, actions: harness(context) };
}
const regressions = [];
let releaseSave;
const delayed = scenario(() => new Promise((resolve) => { releaseSave = resolve; }));
const saving = delayed.actions.onSaveVersion({ name: '新名字', note: '持久化备注' });
if (delayed.state.status !== null) regressions.push('metadata action retains old success');
await Promise.resolve();
delayed.actions.onSelectProject('p2');
assert.equal(delayed.state.projectId, 'p2', 'actual App selection action switches project while metadata PUT is pending');
releaseSave([]);
await saving;
if (!delayed.state.status?.includes('项目一')) regressions.push('delayed p1 completion publishes ownerless success into p2');
assert.equal(delayed.context.projectsRef.current[1].screens[0].versions[0].note, undefined);
const rejected = scenario(async () => { throw new Error('controlled PUT failure'); });
await rejected.actions.onRefine('gold button');
if (rejected.state.status !== null) regressions.push('failed refine save retains prior success');
assert.match(rejected.state.error, /controlled PUT failure/);
assert.equal(rejected.context.unsavedProjects.current.size, 1, 'failed reservation save retained for retry');
assert.equal(rejected.state.submissions.length, 0, 'failed project reservation never crosses paid boundary');
assert.equal(rejected.context.projectsRef.current[1].screens[0].versions.length, 1, 'p2 never receives p1 version');
assert.match(rejected.state.saveError, /项目一/, 'project retry error identifies its owner');
const rejectedMetadata = scenario(async () => { throw new Error('metadata PUT failed'); });
await rejectedMetadata.actions.onSaveVersion({ note: 'still unsaved' });
assert.equal(rejectedMetadata.state.status, null);
assert.match(rejectedMetadata.state.error, /项目一.*metadata PUT failed/);
assert.equal(rejectedMetadata.context.unsavedProjects.current.size, 1);
for (const operation of ['onGenerate', 'onRefine']) {
  const accepted = scenario(async () => []);
  if (operation === 'onGenerate') await accepted.actions.onGenerate();
  else await accepted.actions.onRefine('gold button');
  assert.equal(accepted.state.submissions.length, 1);
  const task = accepted.state.submissions[0];
  assert.equal(task.projectId, 'p1'); assert.equal(task.screenId, 's1');
  assert.equal(task.styleSnapshot.prompt, 'ice');
  assert.equal(task.size, '12x8');
  const reservation = accepted.context.projectsRef.current[0].screens[0].versions.at(-1);
  assert.equal(reservation.id, task.id);
  assert.equal(reservation.image, undefined, 'queued reservation is not a successful version');
  if (operation === 'onRefine') {
    assert.equal(task.sourceVersionId, 'v1'); assert.equal(task.sourceImage, 'source.png');
    assert.equal(reservation.parentVersionId, 'v1');
  }
  assert.equal(accepted.context.projectsRef.current[1].screens[0].versions.length, 1);
}
assert.deepEqual(regressions, [], 'App feedback regressions');
for (const operation of ['onGenerate', 'onRefine', 'onRetryProjectRender']) {
  const editing = scenario(async () => assert.fail('Unsaved slice edits must block version changes'));
  editing.context.sliceSession.hasUnsaved = true;
  const before = structuredClone(editing.context.projectsRef.current);
  await editing.actions[operation]('gold button');
  assert.deepEqual(editing.context.projectsRef.current, before, `${operation} preserves the active version during unsaved slice edits`);
  assert.equal(editing.state.submissions.length, 0);
}
console.log('PASS unsaved slice edits block generation, refinement and paid retry before version reservation');
console.log('PASS versions: legacy compatibility, immutable append, missing/duplicate image rejection, stable names, parent deletion, selection fallback, captured target isolation, metadata roundtrip');
console.log('PASS actual App action regressions: delayed p1 metadata PUT then actual p2 selection, owner-labelled feedback, prior status cleared, refine/metadata PUT failure retains retry without false success or p2 writes (AST harness, not browser)');
console.log(`Evidence: ${directory}`);
