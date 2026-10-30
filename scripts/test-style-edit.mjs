import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/components/StyleLibrary.tsx'], bundle: true, write: false,
  platform: 'node', format: 'esm', loader: { '.css': 'empty' },
});
const { editStyleFields } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('editing trims fields, preserves identity, image and creation date without mutating snapshots', () => {
  const original = Object.freeze({ id: 'style-1', name: '旧名', prompt: '旧提示', image: 'style.png', createdAt: 100, updatedAt: 200 });
  const project = { stylePrompt: original.prompt, styleImage: original.image };
  const version = { styleSnapshot: { ...original } };
  const snapshots = structuredClone({ project, version });
  const edited = editStyleFields(original, ' 新名 ', ' 新提示 ', 300);
  assert.deepEqual(edited, { ...original, name: '新名', prompt: '新提示', updatedAt: 300 });
  assert.notEqual(edited, original);
  assert.deepEqual({ project, version }, snapshots);
  assert.equal(original.name, '旧名');
  const noImage = { ...original, image: undefined };
  assert.equal(editStyleFields(noImage, 'name', 'prompt').image, undefined);
});

test('empty names and prompts cannot overwrite a saved style', () => {
  const original = { id: 's', name: 'name', prompt: 'prompt', createdAt: 1, updatedAt: 1 };
  assert.throws(() => editStyleFields(original, ' ', 'prompt'), /不能为空/);
  assert.throws(() => editStyleFields(original, 'name', '\n'), /不能为空/);
  assert.equal(original.prompt, 'prompt');
});
