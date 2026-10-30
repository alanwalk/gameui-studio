#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseCommand, CliError } from '../cli/options.mjs';
import { execute } from '../cli/commands.mjs';

// No logs or progress on stdout: one machine-readable result per invocation.
const argv = process.argv.slice(2);
const machine = argv.includes('--json');
try {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new CliError('CLI 需要 Node.js 20 或更新版本', 'RUNTIME', 2);
  const parsed = parseCommand(argv);
  if (parsed.help) {
    process.stdout.write(machine ? `${JSON.stringify({ ok: true, help: parsed.help })}\n` : `${parsed.help}\n`);
  } else if (parsed.version) {
    const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(machine ? `${JSON.stringify({ ok: true, version: pkg.version })}\n` : `${pkg.version}\n`);
  } else {
    const data = await execute(parsed.command, parsed.options);
    process.stdout.write(`${JSON.stringify({ ok: true, command: parsed.command, data }, null, machine ? undefined : 2)}\n`);
  }
} catch (error) {
  const code = error instanceof CliError ? error.code : 'OPERATION_FAILED';
  const exitCode = error instanceof CliError ? error.exitCode : 1;
  const message = error instanceof Error ? error.message : String(error);
  const failure = { ok: false, error: { code, message, details: error?.details }, exitCode };
  if (machine) process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.stderr.write(`gameui: ${message}\n`);
  process.exitCode = exitCode;
}
