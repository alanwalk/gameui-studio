import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { finished } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const mode = process.argv[2] ?? '--offline';
if (process.argv.length > 3 || !['--offline', '--integration', '--web', '--model'].includes(mode)) {
  console.error('Usage: npm run check | npm run check:integration | npm run check:web | npm run check:model');
  process.exitCode = 1;
} else {
  await main();
}

async function main() {
  const checks = path.join(root, '.data/checks');
  await mkdir(checks, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = await mkdtemp(path.join(checks, `${stamp}-${mode.slice(2)}-`));
  const results = [];
  console.log(`Checks: ${mode.slice(2)}. Full stdout/stderr: ${directory}`);

  async function run(name, args) {
    const stdoutFile = path.join(directory, `${name}.stdout.log`);
    const stderrFile = path.join(directory, `${name}.stderr.log`);
    const stdout = createWriteStream(stdoutFile, { flags: 'wx' });
    const stderr = createWriteStream(stderrFile, { flags: 'wx' });
    const saved = Promise.all([finished(stdout), finished(stderr)]);
    const previews = { stdout: { head: '', tail: '' }, stderr: { head: '', tail: '' } };
    const started = Date.now();
    console.log(`RUN ${name}`);
    let spawnError;
    const recordSpawnError = (error) => {
      spawnError = error.stack ?? String(error);
      stderr.write(`${spawnError}\n`);
    };
    let child;
    try {
      child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      recordSpawnError(error);
    }
    let outcome = { code: null, signal: null };
    if (child) {
      child.on('error', recordSpawnError);
      for (const [streamName, log] of [['stdout', stdout], ['stderr', stderr]]) {
        child[streamName].pipe(log, { end: false });
        child[streamName].on('data', (chunk) => {
          const preview = previews[streamName];
          const text = chunk.toString('utf8');
          preview.head = (preview.head + text).slice(0, 2000);
          preview.tail = (preview.tail + text).slice(-6000);
        });
      }
      outcome = await new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })));
    }
    stdout.end();
    stderr.end();
    await saved;
    const passed = !spawnError && outcome.code === 0;
    results.push({ name, command: [process.execPath, ...args], ...outcome, spawnError,
      durationMs: Date.now() - started, stdoutFile, stderrFile });
    await writeFile(path.join(directory, 'summary.json'), JSON.stringify({ mode, passed, results }, null, 2));
    console.log(`${passed ? 'PASS' : 'FAIL'} ${name} (${Date.now() - started} ms)`);
    if (!passed) {
      for (const [streamName, preview] of Object.entries(previews)) {
        if (preview.head) console.error(`${streamName} (bounded first/last context):\n${preview.head}\n...\n${preview.tail}`);
      }
      if (spawnError) console.error(spawnError);
      console.error(`Stopped at ${name}; full root-cause output: ${stderrFile}; stdout: ${stdoutFile}`);
      process.exitCode = outcome.code || 1;
      return false;
    }
    if (previews.stdout.tail) console.log(previews.stdout.tail.trim().split('\n').slice(-2).join('\n').slice(-600));
    if (previews.stderr.tail) console.error(`stderr (last 1200 chars; full log saved):\n${previews.stderr.tail.slice(-1200)}`);
    return true;
  }

  if (mode === '--integration') {
    if (!await run('store-rest', ['scripts/test-slice-tasks.mjs'])) return;
    if (!await run('segmentation-api', ['scripts/test-segmentation-api.mjs'])) return;
    for (const name of ['refine-api', 'drawing-api', 'pack-server', 'atlas-server', 'project-copy', 'project-render', 'ai-slice-api']) {
      if (!await run(name, [`scripts/test-${name}.mjs`])) return;
    }
  } else if (mode === '--web') {
    // Real browser/Canvas/downloads; only external model providers are controlled.
    for (const name of ['web-workflows', 'page-export', 'atlas-browser', 'pack-browser', 'drawing-browser', 'style-references', 'ai-slice-browser']) {
      if (!await run(name, [`scripts/test-${name}.mjs`])) return;
    }
  } else if (mode === '--model') {
    // Existing explicit probe costs one image generation; never included in other modes.
    console.log('REAL MODEL: one paid Magpie image generation. Requires configured MAGPIE_BIN.');
    if (!await run('image-model', ['scripts/probe-gen.mjs'])) return;
  } else {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error('Run with npm run check so the existing npm smoke/typecheck scripts can be used.');
    if (!await run('smoke', [npmCli, 'run', 'smoke'])) return;
    if (!await run('detection-rects', ['--test', 'scripts/test-detection-rects.mjs'])) return;
    const require = createRequire(import.meta.url);
    const esbuild = require.resolve('esbuild/bin/esbuild');
    for (const name of ['export-check', 'layout-history-check', 'mask-edit-check']) {
      const bundle = path.join(directory, `${name}.mjs`);
      if (!await run(`${name}-bundle`, [esbuild, `scripts/${name}.mjs`, '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${bundle}`, '--log-level=warning'])) return;
      if (!await run(name, [bundle])) return;
    }
    if (!await run('stage3-batch', ['scripts/test-stage3-batch.mjs'])) return;
    if (!await run('slice-task-failures', ['scripts/test-slice-task-failures.mjs'])) return;
    for (const name of ['versions', 'layout-tools', 'layout-structure', 'style-edit', 'parity-boundaries']) {
      if (!await run(name, [`scripts/test-${name}.mjs`])) return;
    }
    if (!await run('typecheck', [npmCli, 'run', 'typecheck'])) return;
  }
  if (mode === '--model') {
    console.log('Probe exited 0; inspect FIRST/POLL and actual image output before accepting generation.');
  }
  console.log(`All ${results.length} steps exited 0. Summary: ${path.join(directory, 'summary.json')}`);
}
