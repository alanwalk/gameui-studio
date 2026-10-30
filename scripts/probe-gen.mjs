// One-shot probe: prints the raw `generate_image` answer, then polls
// `generation_result` with the id parsed the way the server parses it.
// Costs one image generation; kept out of the normal build.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BIN = process.env.MAGPIE_BIN ?? 'magpie';
const child = spawn(BIN, ['mcp', 'image'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

let nextId = 1;
const pending = new Map();
let buffer = '';

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    handleLine(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
  }
});
child.stderr.on('data', (chunk) => console.log('ERR ' + chunk.toString().slice(0, 500)));

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    console.log('RAW ' + trimmed.slice(0, 500));
    return;
  }
  if (typeof message.id !== 'number') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry.resolve(message.result);
}

function request(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function collectContent(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text ?? ''))
    .join('\n')
    .trim();
  let base64;
  for (const part of content) {
    if (part?.type === 'image' && typeof part.data === 'string') {
      base64 = part.data;
      break;
    }
  }
  const pathMatch = text.match(/([A-Za-z]:\\[^\s"']+\.(?:png|jpg|jpeg|webp))/i);
  const idMatch = text.match(/\b([0-9a-f]{8,}|[a-z0-9_-]{12,})\b/i);
  return {
    path: pathMatch?.[1],
    base64,
    pendingId: text.toLowerCase().includes('wait') && !pathMatch && !base64 ? idMatch?.[1] : undefined,
    text,
    isError: Boolean(result?.isError),
  };
}

await request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '0' },
});
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gameui-probe-'));
const outPath = path.join(outDir, 'screen.png');
console.log('outPath=' + outPath);

const first = collectContent(
  await request('tools/call', {
    name: 'generate_image',
    arguments: {
      prompt: 'A simple blue game UI button, flat vector style, centered on white background.',
      path: outPath,
      quality: 'low',
      background: 'opaque',
      n: 1,
      size: '1024x1024',
    },
  }, 120_000),
);
console.log('FIRST ' + JSON.stringify({ ...first, base64: first.base64 ? '<base64>' : undefined }, null, 2));

if (first.pendingId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, 3000));
    const polled = collectContent(
      await request('tools/call', {
        name: 'generation_result',
        arguments: { id: first.pendingId },
      }),
    );
    console.log('POLL' + attempt + ' ' + JSON.stringify({ ...polled, base64: polled.base64 ? '<base64>' : undefined }, null, 2));
    if (polled.path || polled.base64) break;
  }
}

const files = await fs.readdir(outDir).catch(() => []);
console.log('outDirFiles=' + JSON.stringify(files));
child.kill();
process.exit(0);
