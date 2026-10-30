import type { ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ATLAS_LIMITS } from '../src/lib/atlasTypes';
import { createAtlasJob, getAtlasJob, linkAtlasTask, listAtlasJobs, readAtlasFile } from './atlasStore';

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > ATLAS_LIMITS.totalBytes * 1.34 + 2 * 1024 * 1024) throw new Error('图集上传请求超限');
    chunks.push(bytes);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求必须为对象');
  return body as Record<string, unknown>;
}
function send(res: ServerResponse, code: number, value: unknown): void {
  res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(value));
}
/** Main-thread integration: call once from the existing Vite API plugin. */
export function registerAtlasApi(server: ViteDevServer): void {
  server.middlewares.use(async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!/^\/api\/atlas-jobs(?:\/|$)/.test(url.pathname)) { next(); return; }
    try {
      const parts = url.pathname.split('/').slice(3);
      if (req.method === 'GET' && !parts[0]) { send(res, 200, await listAtlasJobs()); return; }
      if (req.method === 'POST' && !parts[0]) { send(res, 201, await createAtlasJob(await readBody(req))); return; }
      if (req.method === 'GET' && parts.length === 1) { send(res, 200, await getAtlasJob(parts[0])); return; }
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'link') {
        const body = await readBody(req); send(res, 200, await linkAtlasTask(parts[0], body.packTaskId)); return;
      }
      if (req.method === 'GET' && parts.length === 3 && parts[1] === 'files' && /^\d+$/.test(parts[2])) {
        const file = await readAtlasFile(parts[0], Number(parts[2]));
        res.setHeader('Content-Type', file.png ? 'image/png' : 'application/octet-stream');
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
        res.end(file.bytes); return;
      }
      send(res, 405, { error: '不支持的图集操作' });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400;
      send(res, code, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}
