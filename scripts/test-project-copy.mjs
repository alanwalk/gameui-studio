import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import ts from 'typescript';

if (!process.env.PROJECT_COPY_TEST_WORKER) {
  const directory = await fs.mkdtemp(path.resolve('.data/project-copy-test-'));
  const bundle = path.join(directory, 'test.mjs');
  const files = ['src/lib/projectCopy.ts', 'src/components/ProjectSidebar.tsx', 'server/projectCopyApi.ts', 'server/store.ts'];
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const program = ts.createProgram(files, parsed.options);
  const owned = new Set(files.map((file) => path.resolve(file).toLowerCase()));
  const allDiagnostics = ts.getPreEmitDiagnostics(program);
  const diagnostics = allDiagnostics.filter((entry) => !entry.file || owned.has(path.resolve(entry.file.fileName).toLowerCase()));
  const diagnosticText = ts.formatDiagnosticsWithColorAndContext(allDiagnostics, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
  });
  await fs.writeFile(path.join(directory, 'typecheck.log'), diagnosticText);
  if (diagnostics.length) throw new Error(`Scoped TypeScript check failed; details: ${directory}/typecheck.log`);
  console.log(`PASS scoped TypeScript (${files.length} roots); ${allDiagnostics.length - diagnostics.length} dependency diagnostics outside owned files`);
  await build({ entryPoints: [process.argv[1]], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: bundle });
  const result = spawnSync(process.execPath, [bundle], {
    env: { ...process.env, PROJECT_COPY_TEST_WORKER: '1', GAMEUI_DATA: path.join(directory, 'store') },
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  await fs.writeFile(path.join(directory, 'stdout.log'), result.stdout ?? '');
  await fs.writeFile(path.join(directory, 'stderr.log'), result.stderr ?? '');
  process.stdout.write((result.stdout ?? '').slice(0, 6000));
  process.stderr.write((result.stderr ?? '').slice(0, 6000));
  console.log(`Evidence: ${directory}; exit=${result.status}`);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  await runTests();
}

async function runTests() {
  const store = await import('../server/store.ts');
  const { registerProjectCopyApi } = await import('../server/projectCopyApi.ts');
  const client = await import('../src/lib/projectCopy.ts');
  const { ProjectSidebar } = await import('../src/components/ProjectSidebar.tsx');
  const root = process.env.GAMEUI_DATA;
  assert.ok(root.includes('project-copy-test-'));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const image = await store.saveImage(png, 'immutable');
  const snapshot = { id: 'style', name: '风格', prompt: 'gold', image, referenceImages: [image] };
  const screen = {
    id: 's1', name: '主界面', usage: '登录', layoutReferenceImage: image,
    layout: [{ id: 'node', name: '按钮', kind: 'button', rect: { x: .2, y: .3, w: .4, h: .1 }, text: '开始' }],
    versions: [
      { id: 'v1', parentVersionId: 'deleted', operation: 'import', image, prompt: 'root', createdAt: 1 },
      { id: 'v2', parentVersionId: 'v1', operation: 'refine', image, prompt: 'child', name: 'V2', note: '保留', styleSnapshot: snapshot, createdAt: 2 },
      { id: 'v3', parentVersionId: 'v2', operation: 'refine', image, prompt: 'leaf', createdAt: 3 },
    ], activeVersionId: 'v2',
  };
  const project = {
    id: 'p1', name: '游戏', stylePrompt: 'gold', styleImage: image, referenceImages: [image],
    orientation: 'landscape', size: { w: 1920, h: 1080 }, screens: [screen, { ...structuredClone(screen), id: 's2', name: '商店' }],
    createdAt: 1, updatedAt: 1,
  };
  await store.upsertProject(project);
  await store.upsertStyle({ id: 'style', name: '风格', prompt: 'original', referenceImages: [image], createdAt: 1, updatedAt: 1 });
  await store.upsertStyle({ id: 'legacy', name: '旧风格', prompt: 'legacy', createdAt: 1, updatedAt: 1 });
  const element = {
    id: 'element', kind: 'button', label: '开始', description: 'button', objectName: 'Start', state: 'normal',
    rect: { x: 23, y: 37, w: 120, h: 42 }, layer: 4, occluded: false, needsAi: true, approved: true,
    extractionMethod: 'manual', repainted: true, processingStatus: 'done', maskImage: image,
    slice: { image, width: 120, height: 42, border: { bgColor: [1, 2, 3], sideScore: { top: .1, right: .2, bottom: .3, left: .4 }, dirtySides: ['left'] } },
  };
  for (const [index, status] of ['done', 'running', 'interrupted'].entries()) {
    await store.upsertSliceTask({
      schemaVersion: 1, id: `t${index}`, name: `切图 ${index}`, source: { kind: 'project', projectId: 'p1', screenId: 's1', versionId: `v${index + 1}`, sourceImage: image },
      width: 1920, height: 1080, elements: [{ ...structuredClone(element), processingStatus: status }], status, createdAt: 1, updatedAt: 1,
    });
  }
  await store.upsertSliceTask({ schemaVersion: 1, id: 'standalone', name: '独立', source: { kind: 'standalone', sourceImage: image }, width: 1, height: 1, elements: [], status: 'idle', createdAt: 1, updatedAt: 1 });
  const originalProject = structuredClone((await store.listProjects())[0]);
  const originalTasks = structuredClone(await store.listSliceTasks());
  const styleBytes = await fs.readFile(path.join(root, 'styles.json'), 'utf8');
  const imageNames = await fs.readdir(path.join(root, 'images'));
  let middleware;
  registerProjectCopyApi({ middlewares: { use(handler) { middleware = handler; } } });
  const server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => nativeFetch(new URL(url, base), options);
  async function post(route, body, expected = 200) {
    const response = await fetch(route, { method: 'POST', body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function indexBytes() {
    return Promise.all(['projects.json', 'slice-tasks.json', 'styles.json'].map((file) => fs.readFile(path.join(root, file), 'utf8')));
  }
  try {
    const copied = await client.copyProject('p1', 'p-copy');
    assert.equal(copied.project.id, 'p-copy');
    assert.equal(copied.project.name, '游戏 副本');
    assert.equal(copied.project.screens.length, 2);
    assert.deepEqual(copied.project.size, project.size);
    assert.equal(copied.project.orientation, project.orientation);
    assert.equal(copied.project.stylePrompt, project.stylePrompt);
    assert.equal(copied.project.styleImage, image);
    assert.deepEqual(copied.project.referenceImages, [image]);
    for (const [index, target] of copied.project.screens.entries()) {
      const source = project.screens[index];
      assert.notEqual(target.id, source.id);
      assert.equal(target.name, source.name);
      assert.equal(target.usage, source.usage);
      assert.equal(target.layoutReferenceImage, image);
      assert.notEqual(target.layout[0].id, source.layout[0].id);
      assert.deepEqual({ ...target.layout[0], id: 'node' }, source.layout[0]);
      assert.equal(target.activeVersionId, target.versions[1].id);
      assert.notEqual(target.versions[0].parentVersionId, 'deleted');
      assert.equal(target.versions[1].parentVersionId, target.versions[0].id);
      assert.equal(target.versions[2].parentVersionId, target.versions[1].id);
      for (const [versionIndex, version] of target.versions.entries()) {
        assert.notEqual(version.id, source.versions[versionIndex].id);
        const { id, parentVersionId, ...metadata } = version;
        const { id: oldId, parentVersionId: oldParent, ...sourceMetadata } = source.versions[versionIndex];
        assert.deepEqual(metadata, sourceMetadata);
      }
    }
    assert.equal(copied.tasks.length, 3);
    for (const [index, task] of copied.tasks.entries()) {
      assert.notEqual(task.id, originalTasks[index].id);
      assert.equal(task.source.projectId, copied.project.id);
      assert.equal(task.source.screenId, copied.project.screens[0].id);
      assert.equal(task.source.versionId, copied.project.screens[0].versions[index].id);
      assert.equal(task.source.sourceImage, image);
      assert.equal(task.status, index === 0 ? 'done' : 'interrupted');
      const expectedElement = { ...originalTasks[index].elements[0], id: task.elements[0].id };
      if (expectedElement.processingStatus === 'running') expectedElement.processingStatus = 'interrupted';
      assert.notEqual(task.elements[0].id, element.id);
      assert.deepEqual(task.elements[0], expectedElement);
    }
    assert.deepEqual((await store.listProjects())[0], originalProject);
    assert.deepEqual((await store.listSliceTasks()).slice(0, 4), originalTasks);
    console.log('PASS HTTP project copy: fresh IDs, full parent chain, active version, layout, style snapshot, review/manual/artifact/mask metadata; source untouched; running interrupted');

    const screenCopy = await client.copyScreen('p1', 's1', 's-copy');
    assert.equal(screenCopy.project.id, 'p1');
    assert.equal(screenCopy.screenId, 's-copy');
    assert.equal(screenCopy.project.screens.at(-1).name, '主界面 副本');
    assert.deepEqual(screenCopy.project.screens.slice(0, 2), originalProject.screens);
    assert.equal(screenCopy.tasks.length, 3);
    assert.ok(screenCopy.tasks.every((task) => task.source.projectId === 'p1' && task.source.screenId === 's-copy'));
    assert.equal((await client.copyScreen('p1', 's1')).project.screens.at(-1).name, '主界面 副本 2');
    assert.equal((await client.copyProject('p1')).project.name, '游戏 副本 2');
    const edited = structuredClone(copied.project);
    edited.screens[0].layout[0].rect.x = .9;
    edited.screens[0].versions[1].styleSnapshot.prompt = 'changed';
    await store.upsertProject(edited);
    const editedTask = structuredClone(copied.tasks[0]);
    editedTask.elements[0].approved = false;
    editedTask.elements[0].rect.x = 99;
    await store.upsertSliceTask(editedTask);
    assert.deepEqual((await store.listProjects())[0].screens.slice(0, 2), originalProject.screens);
    assert.deepEqual((await store.listSliceTasks()).slice(0, 4), originalTasks);
    assert.equal(await fs.readFile(path.join(root, 'styles.json'), 'utf8'), styleBytes);
    assert.deepEqual(await fs.readdir(path.join(root, 'images')), imageNames);
    assert.equal(await store.readImage(image), png);
    console.log('PASS same-project screen copy, unique duplicate names, target edits isolated, styles/legacy refs unchanged, image bytes and file count reused');

    const beforeInvalid = await indexBytes();
    await post('/api/projects/copy', { projectId: 'missing' }, 404);
    await post('/api/screens/copy', { projectId: 'p1', screenId: 'missing' }, 404);
    await post('/api/projects/copy', { projectId: 'p1', newId: 'p1' }, 409);
    await post('/api/screens/copy', { projectId: 'p1', screenId: 's1', newId: 's1' }, 409);
    for (const body of [null, [], {}, { projectId: '../p1' }, { projectId: 'p1', path: 'any' }, { projectId: 'p1', canvas: {} }, { projectId: 'p1', base64: 'x' }, { projectId: 'p1', newId: 'a'.repeat(129) }, { projectId: 'p1', screenId: 's1' }]) {
      await post('/api/projects/copy', body, 400);
    }
    await post('/api/screens/copy', { projectId: 'p1' }, 400);
    const malformed = await fetch('/api/projects/copy', { method: 'POST', body: '{' });
    assert.equal(malformed.status, 400);
    const oversized = await fetch('/api/projects/copy', { method: 'POST', body: 'a'.repeat(3000) });
    assert.equal(oversized.status, 413);
    const wrongMethod = await fetch('/api/projects/copy');
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'POST');
    assert.equal((await fetch('/api/projects/copy/other')).status, 404);
    assert.deepEqual(await indexBytes(), beforeInvalid);
    console.log('PASS POST-only, strict routes/keys/ID/body bounds, missing sources, collision protection; no disk changes on invalid requests');

    for (const file of ['projects.json', 'slice-tasks.json']) {
      const target = path.join(root, file);
      const original = await fs.readFile(target, 'utf8');
      await fs.writeFile(target, '{broken');
      const beforeCorruptCopy = await indexBytes();
      try { await post('/api/projects/copy', { projectId: 'p1' }, 500); }
      finally {
        assert.deepEqual(await indexBytes(), beforeCorruptCopy);
        await fs.writeFile(target, original);
      }
    }
    const emptyProject = { ...structuredClone(project), id: 'empty', name: '未切图', screens: [{ ...structuredClone(screen), id: 'empty-screen', versions: [], activeVersionId: undefined }] };
    await store.upsertProject(emptyProject);
    const tasksBeforeEmpty = await fs.readFile(path.join(root, 'slice-tasks.json'), 'utf8');
    const emptyCopy = await client.copyProject('empty');
    assert.deepEqual(emptyCopy.tasks, []);
    assert.deepEqual(emptyCopy.project.screens[0].versions, []);
    const emptyScreenCopy = await client.copyScreen('empty', 'empty-screen');
    assert.deepEqual(emptyScreenCopy.tasks, []);
    assert.equal(await fs.readFile(path.join(root, 'slice-tasks.json'), 'utf8'), tasksBeforeEmpty);
    console.log('PASS corrupt index protection and no-task/no-version copy without touching task index');

    const originalRename = fs.rename;
    for (const failingIndex of ['projects.json', 'slice-tasks.json']) {
      const beforeFault = await indexBytes();
      let faultCount = 0;
      fs.rename = async (source, target) => {
        if (target === path.join(root, failingIndex) && faultCount++ === 0) {
          throw Object.assign(new Error(`injected EIO: ${failingIndex}`), { code: 'EIO' });
        }
        return originalRename(source, target);
      };
      try {
        const result = await post('/api/projects/copy', { projectId: 'p1', newId: 'failed-copy' }, 500);
        assert.match(result.error, /injected EIO/);
      } finally { fs.rename = originalRename; }
      assert.ok(faultCount > 0);
      assert.deepEqual(await indexBytes(), beforeFault);
      assert.ok(!(await store.listProjects()).some((entry) => entry.id === 'failed-copy'));
      assert.ok(!(await store.listSliceTasks()).some((entry) => entry.source.projectId === 'failed-copy'));
      assert.ok(!(await fs.readdir(root)).some((name) => name.endsWith('.tmp')));
    }
    // Both the project write and its rollback fail; task rollback must still execute and HTTP must report failure.
    const beforeRollbackFault = await indexBytes();
    fs.rename = async (source, target) => {
      if (target === path.join(root, 'projects.json')) throw Object.assign(new Error('persistent EIO'), { code: 'EIO' });
      return originalRename(source, target);
    };
    try {
      const result = await post('/api/projects/copy', { projectId: 'p1' }, 500);
      assert.match(result.error, /回滚未完成/);
    } finally { fs.rename = originalRename; }
    assert.deepEqual(await indexBytes(), beforeRollbackFault);
    await client.copyScreen('p1', 's1');
    console.log('PASS real rename EIO before first/second commit, rollback snapshot equality, rollback-error response, no orphan metadata/tmp files; queue recovers');

    const simultaneous = await Promise.all([client.copyProject('p1'), client.copyProject('p1')]);
    assert.notEqual(simultaneous[0].project.name, simultaneous[1].project.name);
    const storedIds = new Set((await store.listProjects()).map((entry) => entry.id));
    assert.ok(simultaneous.every((result) => storedIds.has(result.project.id)));
    const calls = [];
    function buttons(tree) {
      if (!tree || typeof tree !== 'object') return [];
      if (Array.isArray(tree)) return tree.flatMap(buttons);
      const own = tree.type === 'button' ? [tree] : [];
      return [...own, ...buttons(tree.props?.children)];
    }
    const props = {
      projects: [project], activeProjectId: 'p1', activeScreenId: 's1',
      onSelectProject: (id) => calls.push(['selectProject', id]), onSelectScreen: (id) => calls.push(['selectScreen', id]),
      onDeleteProject: (id) => calls.push(['deleteProject', id]), onDeleteScreen: (id) => calls.push(['deleteScreen', id]),
      onAddProject() {}, onAddScreen() {},
    };
    assert.equal(buttons(ProjectSidebar(props)).filter((button) => button.props['aria-label']?.startsWith('复制')).length, 0);
    for (const busy of [false, true]) {
      const rendered = buttons(ProjectSidebar({ ...props, busy, onCopyProject: (id) => calls.push(['copyProject', id]), onCopyScreen: (projectId, screenId) => calls.push(['copyScreen', projectId, screenId]) }));
      const copyButtons = rendered.filter((button) => button.props['aria-label']?.startsWith('复制'));
      assert.equal(copyButtons.length, 3);
      for (const button of copyButtons) {
        assert.equal(button.props.disabled, busy);
        assert.equal(button.props.title, button.props['aria-label']);
      }
      if (!busy) copyButtons.forEach((button) => button.props.onClick());
      rendered.find((button) => button.props.className === 'proj-name').props.onClick();
      rendered.find((button) => button.props.className === 'screen-pick').props.onClick();
      rendered.find((button) => button.props.title === '删除项目').props.onClick();
      const deleteScreen = rendered.find((button) => button.props.className === 'screen-del');
      assert.equal(deleteScreen.props.disabled, false);
      deleteScreen.props.onClick();
    }
    assert.deepEqual(calls.slice(0, 3), [['copyProject', 'p1'], ['copyScreen', 'p1', 's1'], ['copyScreen', 'p1', 's2']]);
    assert.deepEqual(calls.slice(3, 7), calls.slice(7));
    assert.deepEqual(calls.slice(3, 7), [['selectProject', 'p1'], ['selectScreen', 's1'], ['deleteProject', 'p1'], ['deleteScreen', 's1']]);
    const oneScreenButtons = buttons(ProjectSidebar({ ...props, projects: [{ ...project, screens: [screen] }], busy: true }));
    assert.equal(oneScreenButtons.find((button) => button.props.className === 'screen-del').props.disabled, true);
    console.log('PASS concurrent HTTP queue updates; optional sidebar callbacks/labels/busy and original select/delete semantics');
    console.log('Boundary: in-process rollback verified; process termination/power loss between JSON renames is not crash atomic. No model/Unity/build invoked.');
  } finally {
    globalThis.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
