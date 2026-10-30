import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const evidence = path.resolve('.data', `drawing-schema-${Date.now()}.json`);
await fs.mkdir(path.dirname(evidence), { recursive: true });
const child = spawn(process.env.MAGPIE_BIN ?? 'magpie', ['mcp', 'image'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buffer = '';
let diagnostics = '';
child.stderr.on('data', (chunk) => { diagnostics += chunk.toString(); });
const timer = setTimeout(() => { console.error('tools/list timed out'); child.kill(); process.exitCode = 1; }, 30000);
child.on('error', (error) => { clearTimeout(timer); console.error(error.message); process.exitCode = 1; });
child.stdout.on('data', async (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === 1) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    }
    if (message.id === 2) {
      clearTimeout(timer);
      await fs.writeFile(evidence, JSON.stringify({ response: message, diagnostics }, null, 2));
      const tool = message.result?.tools?.find((tool) => tool.name === 'generate_image');
      console.log(JSON.stringify({ evidence, name: tool?.name, inputSchema: tool?.inputSchema, error: message.error }));
      if (!tool) process.exitCode = 1;
      child.kill();
    }
  }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'drawing-schema-check', version: '1' } } }) + '\n');
