import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// No installs, activation, Pipeline connections, scene edits, or generated API stubs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const compileOnly = process.argv.includes('--compile-only');
assert(process.argv.slice(2).every((arg) => arg === '--compile-only'), 'Only --compile-only is supported');
const runRoot = path.join(root, '.data', `unity-acceptance-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
await mkdir(runRoot, { recursive: false });
const cli = path.join(process.env.LOCALAPPDATA, 'Unity', 'bin', 'unity.exe');
const report = { runRoot, startedAt: new Date().toISOString(), compileOnly, commands: [], compilation: [], harnessCompilation: [], editorImport: { status: 'NOT_RUN' } };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const saveJson = (name, value) => writeFile(path.join(runRoot, name), JSON.stringify(value, null, 2) + '\n');

async function run(name, executable, args, cwd = root, timeoutMs = 60000) {
  const stdout = path.join(runRoot, `${name}.stdout.log`);
  const stderr = path.join(runRoot, `${name}.stderr.log`);
  const stdoutFd = openSync(stdout, 'wx');
  const stderrFd = openSync(stderr, 'wx');
  const command = { name, executable, args, cwd, stdout, stderr, startedAt: new Date().toISOString() };
  report.commands.push(command);
  console.log(`START ${name}`);
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd, windowsHide: true, stdio: ['ignore', stdoutFd, stderrFd],
        env: { ...process.env, UNITY_NO_CRASH_REPORT: '1', UNITY_NO_CONSENT_PROMPT: '1' },
      });
      command.pid = child.pid;
      timeout = setTimeout(() => {
        command.timedOut = true;
        child.kill(); // Only the process spawned by this invocation, never another Editor.
      }, timeoutMs);
      child.once('error', reject);
      child.once('close', (code, signal) => {
        command.exitCode = code;
        command.signal = signal;
        resolve();
      });
    });
  } catch (error) {
    command.spawnError = error.message;
    throw error;
  } finally {
    clearTimeout(timeout);
    closeSync(stdoutFd);
    closeSync(stderrFd);
    command.finishedAt = new Date().toISOString();
    await saveJson(`${name}.command.json`, command);
  }
  console.log(`END ${name}: exit=${command.exitCode}; logs=${stdout}`);
  return command;
}

const runner = `using System;
using System.IO;
using UnityEditor;
using UnityEngine;

public static class UnityImporterAcceptance
{
    const string TexturePath = "Assets/Art/Textures/UI/Acceptance/T_UI_Acceptance_Existing.png";

    [Serializable]
    public class Settings
    {
        public string textureType, spriteImportMode, wrapMode, filterMode, compression;
        public bool alphaIsTransparency, mipmapEnabled;
        public float pixelsPerUnit, pivotX, pivotY;
        public int alignment;
    }

    [Serializable]
    public class Result
    {
        public string status, unityVersion, texturePath, error;
        public Settings before, after, afterSecondApply;
        public float spritePivotX, spritePivotY;
    }

    static Settings ReadSettings()
    {
        var importer = AssetImporter.GetAtPath(TexturePath) as TextureImporter;
        Require(importer != null, "TextureImporter missing");
        var settings = new TextureImporterSettings();
        importer.ReadTextureSettings(settings);
        return new Settings {
            textureType = importer.textureType.ToString(),
            spriteImportMode = importer.spriteImportMode.ToString(),
            wrapMode = importer.wrapMode.ToString(),
            filterMode = importer.filterMode.ToString(),
            compression = importer.textureCompression.ToString(),
            alphaIsTransparency = importer.alphaIsTransparency,
            mipmapEnabled = importer.mipmapEnabled,
            pixelsPerUnit = importer.spritePixelsPerUnit,
            alignment = settings.spriteAlignment,
            pivotX = settings.spritePivot.x, pivotY = settings.spritePivot.y
        };
    }

    static void Require(bool valid, string message)
    {
        if (!valid) throw new Exception(message);
    }

    static void Verify(Settings actual)
    {
        Require(actual.textureType == "Sprite", "textureType");
        Require(actual.spriteImportMode == "Single", "spriteImportMode");
        Require(actual.alphaIsTransparency, "alphaIsTransparency");
        Require(!actual.mipmapEnabled, "mipmapEnabled");
        Require(actual.wrapMode == "Clamp", "wrapMode");
        Require(actual.filterMode == "Bilinear", "filterMode");
        Require(actual.compression == "Compressed", "textureCompression");
        Require(actual.pixelsPerUnit == 100, "spritePixelsPerUnit");
        Require(actual.alignment == (int)SpriteAlignment.Center, "spriteAlignment");
        Require(Mathf.Abs(actual.pivotX - 0.5f) < 0.0001f, "spritePivot.x");
        Require(Mathf.Abs(actual.pivotY - 0.5f) < 0.0001f, "spritePivot.y");
    }

    public static void Run()
    {
        var result = new Result { status = "FAIL", unityVersion = Application.unityVersion, texturePath = TexturePath };
        var output = Path.GetFullPath(Path.Combine(Application.dataPath, "..", "acceptance-result.json"));
        try
        {
            AssetDatabase.ImportAsset(TexturePath, ImportAssetOptions.ForceSynchronousImport);
            var importer = AssetImporter.GetAtPath(TexturePath) as TextureImporter;
            Require(importer != null, "PNG did not import");
            importer.textureType = TextureImporterType.Sprite;
            importer.spriteImportMode = SpriteImportMode.Single;
            importer.alphaIsTransparency = false;
            importer.mipmapEnabled = true;
            importer.wrapMode = TextureWrapMode.Repeat;
            importer.filterMode = FilterMode.Point;
            importer.spritePixelsPerUnit = 17;
            importer.textureCompression = TextureImporterCompression.Uncompressed;
            var settings = new TextureImporterSettings();
            importer.ReadTextureSettings(settings);
            settings.spriteAlignment = (int)SpriteAlignment.Custom;
            settings.spritePivot = new Vector2(0.25f, 0.75f);
            importer.SetTextureSettings(settings);
            importer.SaveAndReimport();
            result.before = ReadSettings();
            Require(result.before.pixelsPerUnit == 17 && result.before.mipmapEnabled, "baseline not persisted");

            GameUiSliceImporter.Apply();
            result.after = ReadSettings();
            Verify(result.after);
            GameUiSliceImporter.Apply();
            result.afterSecondApply = ReadSettings();
            Verify(result.afterSecondApply);

            var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(TexturePath);
            Require(sprite != null, "Sprite asset missing");
            result.spritePivotX = sprite.pivot.x / sprite.rect.width;
            result.spritePivotY = sprite.pivot.y / sprite.rect.height;
            Require(Mathf.Abs(result.spritePivotX - 0.5f) < 0.0001f, "actual Sprite pivot.x");
            Require(Mathf.Abs(result.spritePivotY - 0.5f) < 0.0001f, "actual Sprite pivot.y");
            result.status = "PASS";
            File.WriteAllText(output, JsonUtility.ToJson(result, true));
            Debug.Log("UNITY_IMPORTER_ACCEPTANCE_PASS " + Application.unityVersion);
        }
        catch (Exception error)
        {
            result.error = error.ToString();
            File.WriteAllText(output, JsonUtility.ToJson(result, true));
            Debug.LogException(error);
            EditorApplication.Exit(1);
        }
    }
}
`;

try {
  const templatePath = path.join(root, 'src', 'lib', 'templates.ts');
  const templateBytes = await readFile(templatePath);
  const source = ts.createSourceFile(templatePath, templateBytes.toString('utf8'), ts.ScriptTarget.Latest, true);
  const declarations = source.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations]);
  const initializer = declarations.find((declaration) => declaration.name.getText(source) === 'IMPORTER_SCRIPT')?.initializer;
  assert(initializer && ts.isCallExpression(initializer), 'Expected literal IMPORTER_SCRIPT array.join');
  const join = initializer.expression;
  assert(ts.isPropertyAccessExpression(join) && join.name.text === 'join' && ts.isArrayLiteralExpression(join.expression));
  assert.equal(initializer.arguments.length, 1);
  assert(ts.isStringLiteral(initializer.arguments[0]));
  assert.equal(initializer.arguments[0].text, '\n');
  const lines = join.expression.elements.map((element) => {
    assert(ts.isStringLiteral(element), 'Only literal template bytes may be extracted');
    return element.text;
  });
  const importerBytes = Buffer.from(lines.join('\n'), 'utf8');
  assert.match(importerBytes.toString('utf8'), /#if UNITY_EDITOR/);
  const importerPath = path.join(runRoot, 'GameUiSliceImporter.cs');
  await writeFile(importerPath, importerBytes, { flag: 'wx' });
  report.template = { source: templatePath, sourceSha256: sha256(templateBytes), importerPath, importerSha256: sha256(importerBytes), bytes: importerBytes.length };

  const discovery = await run('editors', cli, ['editors', '--installed', '--format', 'json', '--non-interactive']);
  assert.equal(discovery.exitCode, 0, 'Editor inventory failed; see complete stdout/stderr');
  const envelope = JSON.parse(await readFile(discovery.stdout, 'utf8'));
  assert.equal(envelope.success, true);
  report.notifications = envelope.notifications ?? [];
  report.installedEditors = envelope.data;
  const editors = envelope.data.filter((editor) => /^(2022\.3\.|6000\.)/.test(editor.version));
  editors.sort((a, b) => {
    const prefer2022 = Number(b.version.startsWith('2022.3.')) - Number(a.version.startsWith('2022.3.'));
    return prefer2022 || b.version.localeCompare(a.version, undefined, { numeric: true });
  });
  assert(editors.length > 0, 'No installed Unity 2022.3/6 Editor found; no downloads attempted');

  const sdkList = await run('dotnet-sdks', 'dotnet', ['--list-sdks']);
  assert.equal(sdkList.exitCode, 0);
  const sdkLine = (await readFile(sdkList.stdout, 'utf8')).split(/\r?\n/).find((line) => line.startsWith('10.0.303 '));
  assert(sdkLine, 'Required installed SDK 10.0.303 not found');
  const sdkRoot = sdkLine.match(/\[(.+)\]/)[1];
  const csc = path.join(sdkRoot, '10.0.303', 'Roslyn', 'bincore', 'csc.dll');
  await access(csc);
  report.compiler = { sdk: '10.0.303', csc, cscSha256: sha256(await readFile(csc)) };
  const runnerPath = path.join(runRoot, 'UnityImporterAcceptance.cs');
  await writeFile(runnerPath, runner, { flag: 'wx' });

  for (const editor of editors) {
    const editorData = path.join(path.dirname(editor.location), 'Data');
    const managed = path.join(editorData, 'Managed');
    const modules = path.join(managed, 'UnityEngine');
    const references = [path.join(editorData, 'NetStandard', 'ref', '2.1.0', 'netstandard.dll')];
    for (const folder of [managed, modules]) {
      for (const file of (await readdir(folder)).sort()) {
        if (/^Unity(?:Editor|Engine).*\.dll$/.test(file)) references.push(path.join(folder, file));
      }
    }
    const output = path.join(runRoot, `GameUiSliceImporter-${editor.version}.dll`);
    const responseFile = path.join(runRoot, `csc-${editor.version}.rsp`);
    // UNITY_EDITOR is essential: without it the exported body would compile away.
    const compilerArgs = ['/nostdlib+', '/target:library', '/langversion:9.0', '/define:UNITY_EDITOR', `/out:"${output}"`, ...references.map((file) => `/reference:"${file}"`), `"${importerPath}"`];
    await writeFile(responseFile, compilerArgs.join('\n') + '\n', { flag: 'wx' });
    const referenceEvidence = [];
    for (const file of references) referenceEvidence.push({ path: file, sha256: sha256(await readFile(file)) });
    await saveJson(`references-${editor.version}.json`, referenceEvidence);
    const compile = await run(`compile-${editor.version}`, 'dotnet', [csc, '/noconfig', `@${responseFile}`]);
    const result = { version: editor.version, editor: editor.location, status: compile.exitCode === 0 ? 'PASS' : 'FAIL', exitCode: compile.exitCode, output, responseFile, references: referenceEvidence.length };
    if (result.status === 'PASS') result.outputSha256 = sha256(await readFile(output));
    report.compilation.push(result);
    if (compile.exitCode !== 0) {
      // Product templates belong to the main task: report a failure without changing them.
      console.error((await readFile(compile.stdout, 'utf8')).slice(0, 6000));
      throw new Error(`Real Unity assembly compilation failed for ${editor.version}; report to main task`);
    }
    const harnessOutput = path.join(runRoot, `UnityImporterAcceptance-${editor.version}.dll`);
    const harnessResponseFile = path.join(runRoot, `csc-harness-${editor.version}.rsp`);
    const harnessArgs = compilerArgs.map((arg) => arg.startsWith('/out:') ? `/out:"${harnessOutput}"` : arg);
    harnessArgs.push(`"${runnerPath}"`);
    await writeFile(harnessResponseFile, harnessArgs.join('\n') + '\n', { flag: 'wx' });
    const harnessCompile = await run(`compile-harness-${editor.version}`, 'dotnet', [csc, '/noconfig', `@${harnessResponseFile}`]);
    report.harnessCompilation.push({ version: editor.version, status: harnessCompile.exitCode === 0 ? 'PASS' : 'FAIL', output: harnessOutput, exitCode: harnessCompile.exitCode });
    assert.equal(harnessCompile.exitCode, 0, `Acceptance harness compilation failed for ${editor.version}; see full logs`);
  }

  if (compileOnly) {
    report.editorImport.reason = '--compile-only: no Editor process launched';
  } else {
    const editor = editors[0];
    const project = path.join(runRoot, `project-${editor.version}`);
    report.editorImport = { status: 'NOT_RUN', version: editor.version, project, reason: 'Creating isolated project' };
    const creationLog = path.join(runRoot, 'editor-create.log');
    const creation = await run('editor-create', editor.location, ['-batchmode', '-quit', '-nographics', '-createProject', project, '-logFile', creationLog], runRoot, 240000);
    assert.equal(creation.exitCode, 0, 'Editor could not create isolated project; see editor-create.log');
    const editorScripts = path.join(project, 'Assets', 'Scripts', 'Editor');
    const textureFolder = path.join(project, 'Assets', 'Art', 'Textures', 'UI', 'Acceptance');
    for (const folder of [editorScripts, textureFolder, path.join(project, 'Packages'), path.join(project, 'ProjectSettings')]) await mkdir(folder, { recursive: true });
    // Keep the Editor-created project settings and built-in package manifest intact.
    await copyFile(importerPath, path.join(editorScripts, 'GameUiSliceImporter.cs'));
    await copyFile(runnerPath, path.join(editorScripts, 'UnityImporterAcceptance.cs'));
    const imageFolder = path.join(root, '.data', 'images');
    const pngs = (await readdir(imageFolder)).filter((name) => name.endsWith('.png')).sort();
    assert(pngs.length > 0, `No existing PNG in ${imageFolder}`);
    const image = path.join(imageFolder, pngs[0]);
    const imageBytes = await readFile(image);
    assert.equal(imageBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const texture = path.join(textureFolder, 'T_UI_Acceptance_Existing.png');
    await copyFile(image, texture);
    assert.equal(sha256(await readFile(texture)), sha256(imageBytes), 'PNG copy must be byte-identical');
    report.png = { source: image, copiedTo: texture, sha256: sha256(imageBytes), width: imageBytes.readUInt32BE(16), height: imageBytes.readUInt32BE(20) };
    report.editorImport = { status: 'NOT_RUN', version: editor.version, project, reason: 'Awaiting Editor completion and assertion result' };
    await saveJson('summary.json', report);
    const editorLog = path.join(runRoot, 'editor.log');
    const execution = await run('editor-import', editor.location, ['-batchmode', '-quit', '-nographics', '-projectPath', project, '-logFile', editorLog, '-executeMethod', 'UnityImporterAcceptance.Run'], project, 240000);
    report.editorImport.exitCode = execution.exitCode;
    report.editorImport.editorLog = editorLog;
    const resultPath = path.join(project, 'acceptance-result.json');
    try {
      report.editorImport.result = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch (error) {
      report.editorImport.reason = `Editor produced no readable assertion result: ${error.message}`;
    }
    if (report.editorImport.result) {
      report.editorImport.status = 'FAIL';
      assert.equal(execution.exitCode, 0, 'Editor command failed; see full logs');
      assert.equal(report.editorImport.result.status, 'PASS');
      assert.equal(report.editorImport.result.unityVersion, editor.version);
      assert.deepEqual(report.editorImport.result.afterSecondApply, report.editorImport.result.after);
      assert.equal(sha256(await readFile(texture)), sha256(imageBytes), 'Importer must preserve PNG bytes');
      report.editorImport.status = 'PASS';
      delete report.editorImport.reason;
    } else {
      throw new Error(report.editorImport.reason);
    }
  }
  assert.equal(sha256(await readFile(templatePath)), report.template.sourceSha256, 'Shared template changed during acceptance; rerun required');
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL_OR_BLOCKED';
  report.error = error.stack;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await saveJson('summary.json', report);
  console.log(JSON.stringify({ status: report.status, compilation: report.compilation.map(({ version, status }) => ({ version, status })), editorImport: report.editorImport.status, summary: path.join(runRoot, 'summary.json') }, null, 2));
}
