import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import { collectContent, type GeneratedAsset } from '../src/lib/mcpReply';

/**
 * A persistent stdio client for `magpie mcp image`.
 *
 * Persistent on purpose: the MCP handshake costs about a second, and a page can need a
 * dozen repaints, so spawning a process per call would dominate the runtime. One child
 * is started lazily on first use and reused for the life of the dev server.
 */

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const MCP_COMMAND = process.env.MAGPIE_BIN ?? 'magpie';

let child: ChildProcess | null = null;
let nextId = 1;
let buffer = '';
const pending = new Map<number, Pending>();
let ready: Promise<void> | null = null;

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  let message: { id?: number; result?: unknown; error?: { message?: string } };
  try {
    message = JSON.parse(trimmed);
  } catch {
    // The host writes non-JSON diagnostics to stdout; ignore them.
    return;
  }

  if (typeof message.id !== 'number') return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);

  if (message.error) {
    entry.reject(new Error(message.error.message ?? 'magpie mcp 调用失败'));
    return;
  }
  entry.resolve(message.result);
}

function request(method: string, params: unknown, timeoutMs = 120_000): Promise<any> {
  if (!child || child.exitCode !== null) {
    throw new Error('magpie mcp 进程未运行');
  }
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`magpie mcp ${method} 超时`));
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

    child?.stdin?.write(`${payload}\n`);
  });
}

async function start(): Promise<void> {
  child = spawn(MCP_COMMAND, ['mcp', 'image'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      handleLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
    }
  });

  child.on('exit', () => {
    child = null;
    ready = null;
    for (const entry of pending.values()) {
      entry.reject(new Error('magpie mcp 进程退出'));
    }
    pending.clear();
  });

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'gameui-studio', version: '0.1.0' },
  });
  child?.stdin?.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );
}

export async function ensureMcp(): Promise<void> {
  if (!ready) {
    ready = start().catch((error) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

export function stopMcp(): void {
  child?.kill();
  child = null;
  ready = null;
}

export type GenerateImageArgs = {
  prompt: string;
  /** Absolute paths to reference images on this machine. */
  referenceImages?: string[];
  path?: string;
  size?: string;
  quality?: string;
  background?: 'transparent' | 'opaque' | 'auto';
  n?: number;
};

export type { GeneratedAsset };

export async function generateImage(args: GenerateImageArgs): Promise<GeneratedAsset> {
  await ensureMcp();

  const params: Record<string, unknown> = { prompt: args.prompt };
  if (args.referenceImages?.length) params.reference_images = args.referenceImages;
  if (args.path) params.path = args.path;
  if (args.size) params.size = args.size;
  if (args.quality) params.quality = args.quality;
  if (args.background) params.background = args.background;
  if (args.n) params.n = args.n;

  const result = await request('tools/call', {
    name: 'generate_image',
    arguments: params,
  });

  const asset = collectContent(result);
  // Surface the tool's own words - quota and provider errors explain themselves.
  if (asset.isError) throw new Error(asset.text || 'magpie 生图失败');
  return asset;
}

export type WaitForGenerationArgs = {
  /** Id Magpie handed back when the first answer said work was still running. */
  pendingId?: string;
  /**
   * File the generation was told to write. Polling it is the reliable signal:
   * the id is parsed out of prose and can be misread, while the file is real.
   */
  watchPath?: string;
  timeoutMs?: number;
};

type FileSnapshot = { size: number; mtimeMs: number };

/**
 * A file is done when it exists, is non-empty, and has not changed since the
 * previous poll - one size reading alone can catch a half-written PNG.
 */
async function fileSettled(
  filePath: string,
  seen: Map<string, FileSnapshot>,
): Promise<boolean> {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || stat.size === 0) return false;

  const previous = seen.get(filePath);
  seen.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs });
  if (!previous) return false;

  return previous.size === stat.size && previous.mtimeMs === stat.mtimeMs;
}

/**
 * Magpie keeps a generation running past the ~20s MCP window and hands back an id.
 * This waits on the output file first and on that id second, until the image shows up.
 */
export async function waitForGeneration(args: WaitForGenerationArgs): Promise<GeneratedAsset> {
  await ensureMcp();
  const timeoutMs = args.timeoutMs ?? 240_000;
  const deadline = Date.now() + timeoutMs;
  const seen = new Map<string, FileSnapshot>();
  let lastText = '';

  while (Date.now() < deadline) {
    if (args.watchPath && (await fileSettled(args.watchPath, seen))) {
      return { path: args.watchPath, text: lastText, isError: false };
    }

    if (args.pendingId) {
      const result = await request('tools/call', {
        name: 'generation_result',
        arguments: { id: args.pendingId },
      });
      const asset = collectContent(result);
      // Magpie answers with isError when it knows nothing about the id; keep going
      // while the work is still running, or while a known output file is present
      // and waiting for the second stability poll.
      if (asset.isError && !/wait|not ready|still/i.test(asset.text)) {
        const output = args.watchPath ? await fs.stat(args.watchPath).catch(() => null) : null;
        if (!output?.size) throw new Error(asset.text || '生图失败');
        lastText = asset.text;
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
      if (asset.path || asset.base64) return asset;
      if (asset.text) lastText = asset.text;
    }

    await new Promise((r) => setTimeout(r, 3000));
  }

  throw new Error(lastText ? `生图未完成：${lastText}` : '生图超时');
}
