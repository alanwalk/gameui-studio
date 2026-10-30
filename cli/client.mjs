import { CliError } from './options.mjs';

const MAX_RESPONSE = 64 * 1024 * 1024;

export function createClient(options, env = process.env) {
  let base;
  try { base = new URL(options.url ?? env.GAMEUI_URL ?? 'http://127.0.0.1:5173'); }
  catch { throw new CliError('服务地址不是有效 URL', 'USAGE', 2); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new CliError('服务 URL 仅接受 HTTP(S)，不能包含凭据、查询或片段', 'USAGE', 2);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.protocol === 'http:' && !loopback && !options['allow-http']) {
    throw new CliError('远端服务请使用 HTTPS；可信网络的明文 HTTP 需显式 --allow-http', 'USAGE', 2);
  }

  async function request(route, { body, binary = false, paid = false, accepted = [], maxBytes = MAX_RESPONSE } = {}) {
    const target = new URL(`${base.pathname.replace(/\/$/, '')}${route}`, base.origin);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout);
    const headers = { Accept: binary ? 'image/png' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (env.GAMEUI_TOKEN) headers.Authorization = `Bearer ${env.GAMEUI_TOKEN}`;
    const redact = (value) => env.GAMEUI_TOKEN ? value.replaceAll(env.GAMEUI_TOKEN, '[REDACTED]') : value;
    try {
      const response = await fetch(target, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, redirect: 'error',
      });
      if (Number(response.headers.get('content-length')) > maxBytes) throw new CliError('服务响应过大', 'RESPONSE_TOO_LARGE', 3);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > maxBytes) throw new CliError('服务响应过大', 'RESPONSE_TOO_LARGE', 3);
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      let value;
      if (!binary || !response.ok) {
        try { value = JSON.parse(bytes.toString('utf8')); }
        catch { throw new CliError('服务未返回 JSON；请确认地址提供 /api，而不是仅静态页面', 'INVALID_RESPONSE', 3); }
      }
      if (!response.ok && !accepted.includes(response.status)) {
        const detail = typeof value?.error === 'string' ? redact(value.error.slice(0, 1500)) : response.statusText;
        throw new CliError(`HTTP ${response.status}: ${detail}`, 'HTTP_ERROR', 3, { status: response.status });
      }
      return binary && response.ok ? bytes : value;
    } catch (error) {
      if (error instanceof CliError) {
        if (paid) error.details = { ...error.details, mayHaveBeenSubmitted: true, retried: false };
        throw error;
      }
      const timedOut = controller.signal.aborted;
      const message = timedOut ? `请求超过 ${options.timeout}ms` : '无法完成服务请求；请检查服务地址、网络和服务日志';
      throw new CliError(`${message}${paid ? '。生成请求可能已受理或计费，请先检查服务端结果，不要直接重复提交' : ''}`,
        timedOut ? 'TIMEOUT' : 'CONNECTION_FAILED', timedOut ? 4 : 3,
        { mayHaveBeenSubmitted: paid, retried: false });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  return { request, baseUrl: base.toString() };
}
