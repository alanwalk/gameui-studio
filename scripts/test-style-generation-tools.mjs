import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Read-only inspection: never changes Magpie configuration or invokes generation.
const directory = await fs.mkdtemp(path.resolve('.data/style-generation-tools-'));
const child = spawn(process.env.MAGPIE_BIN ?? 'magpie', ['mcp', 'image'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const errors = await fs.open(path.join(directory, 'stderr.log'), 'a');
child.stderr.on('data', chunk => void errors.write(chunk));
let buffer = '';
let nextId = 1;
const requests = new Map();
child.stdout.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let message; try { message = JSON.parse(line); } catch { continue; }
    const request = requests.get(message.id);
    if (!request) continue;
    requests.delete(message.id);
    if (message.error) request.reject(Error(message.error.message));
    else request.resolve(message.result);
  }
});
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  requests.set(id, { resolve, reject });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
child.on('error', error => { for (const entry of requests.values()) entry.reject(error); });
const timeout = setTimeout(() => { for (const entry of requests.values()) entry.reject(Error('tools/list timeout')); }, 30000);
try {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'style-generation-schema-check', version: '1.0' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
  const result = await request('tools/list', {});
  const image = result.tools.find(tool => tool.name === 'generate_image');
  assert.ok(image, 'generate_image is available');
  const properties = Object.keys(image.inputSchema.properties);
  assert.ok(!properties.includes('model') && !properties.includes('provider'), 'no invented model/provider override');
  await fs.writeFile(path.join(directory, 'generate-image-schema.json'), JSON.stringify(image, null, 2));
  console.log(`PASS real Magpie tools/list: generate_image parameters=${properties.join(',')}; no model/provider overrides; no generation invoked; artifacts=${directory}`);
} finally { clearTimeout(timeout); child.kill(); await errors.close(); }
