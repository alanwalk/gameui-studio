import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ViteDevServer } from 'vite';
import { createProjectRenderService } from './projectRender';

/** Project-only task routes coexist with the legacy generate/refine endpoints. */
export function createProjectRenderHandler(service = createProjectRenderService()) {
  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const route = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!route.startsWith('/api/project-render/')) { next(); return; }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      let result: unknown;
      if (req.method === 'GET' && route === '/api/project-render/tasks') result = await service.list();
      else if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 29 * 1024 * 1024) throw new Error('项目生图请求过大');
          chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (route === '/api/project-render/tasks') {
          result = await service.submit(body);
          res.statusCode = 202;
        } else {
          const match = route.match(/^\/api\/project-render\/tasks\/((?:v-)?[0-9a-f-]{36})\/(resume|ack|discard|cancel|retry)$/);
          if (!match) { res.statusCode = 404; res.end(JSON.stringify({ error: '生成任务接口不存在' })); return; }
          if (match[2] === 'retry') {
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('重新生成请求无效');
            const retry = body as Record<string, unknown>;
            result = await service.retry(match[1], retry.newId, retry.confirmNewCharge);
          } else result = await service.action(match[1], match[2] as 'resume' | 'ack' | 'discard' | 'cancel');
        }
      } else { res.statusCode = 404; res.end(JSON.stringify({ error: '生成任务接口不存在' })); return; }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }));
    }
  }
  return { handle, stop: service.stop, idle: service.idle };
}

export function registerProjectRenderApi(server: ViteDevServer): void {
  const handler = createProjectRenderHandler();
  server.middlewares.use((req, res, next) => { void handler.handle(req, res, next); });
  server.httpServer?.once('close', handler.stop);
}
