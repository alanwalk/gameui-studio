import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { copyProjectTransaction, ProjectCopyError } from './store';

const MAX_BODY_BYTES = 2048;
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

async function readCopyBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const declaredSize = Number(req.headers['content-length']);
  if (declaredSize > MAX_BODY_BYTES) throw new ProjectCopyError('请求体过大', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  // Drain oversized bodies so the client receives a JSON error over the same connection.
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(Buffer.from(chunk));
  }
  if (size > MAX_BODY_BYTES) throw new ProjectCopyError('请求体过大', 413);
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProjectCopyError('请求体不是合法 JSON', 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProjectCopyError('请求体必须是对象', 400);
  }
  return body as Record<string, unknown>;
}

export function registerProjectCopyApi(server: ViteDevServer): void {
  server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/api/projects/copy' && pathname !== '/api/screens/copy') { next(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new ProjectCopyError('仅支持 POST', 405);
      }
      const body = await readCopyBody(req);
      const copyingScreen = pathname === '/api/screens/copy';
      const allowedKeys = copyingScreen ? ['projectId', 'screenId', 'newId'] : ['projectId', 'newId'];
      if (Object.keys(body).some((key) => !allowedKeys.includes(key)) || !validId(body.projectId) ||
          (copyingScreen && !validId(body.screenId)) || (body.newId !== undefined && !validId(body.newId))) {
        throw new ProjectCopyError('仅接受有效的源 ID 与可选目标 newId（1–128 位字母、数字、下划线或短横线）', 400);
      }
      const request = {
        projectId: body.projectId,
        screenId: copyingScreen ? body.screenId as string : undefined,
        newId: body.newId as string | undefined,
      };
      const result = await copyProjectTransaction(request);
      res.statusCode = 200;
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error instanceof ProjectCopyError ? error.status : 500;
      const message = error instanceof Error ? error.message : '复制失败';
      res.end(JSON.stringify({ error: message }));
    }
  });
}
