import { parseArgs } from 'node:util';

export class CliError extends Error {
  constructor(message, code = 'OPERATION_FAILED', exitCode = 1, details) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

const text = { type: 'string' };
const flag = { type: 'boolean' };
const common = {
  help: { ...flag, short: 'h' }, json: flag, url: text, timeout: text,
  force: flag, 'allow-http': flag,
};
const model = { model: text, 'dry-run': flag, response: text };
const prompt = { prompt: text, 'prompt-file': text };

export const COMMANDS = {
  health: { options: { segment: flag }, usage: 'health [--segment]', description: '检查服务、模型网关；可选检查 SAM runtime' },
  models: { options: {}, usage: 'models', description: '列出服务已配置的视觉模型' },
  upload: { options: { input: text }, usage: 'upload --input image.png', description: '上传并规范化图片，返回服务端文件引用' },
  style: { options: { input: text, reference: { ...text, multiple: true }, description: text, out: text, ...model },
    usage: 'style --input style.png [--reference extra.png] [--out style.json]', description: '提取画风（不自动创建项目或保存风格库）' },
  detect: { options: { input: text, out: text, ...model }, usage: 'detect --input screen.png [--out elements.json]', description: '识别可复用素材与原图像素坐标' },
  layout: { options: { input: text, out: text, ...model }, usage: 'layout --input screen.png --out layout-dir', description: '由截图识别节点，输出布局 JSON 和线稿 PNG/SVG' },
  generate: { options: { wireframe: text, style: text, 'style-image': text, size: text, out: text, ...prompt, 'dry-run': flag, response: text },
    usage: 'generate --wireframe layout.png [--style style.json] --out screen.png', description: '以线稿和风格生成效果图（新图像请求，可能计费）' },
  'ai-sheet': { options: { input: text, size: text, out: text, ...prompt, 'dry-run': flag, response: text },
    usage: 'ai-sheet --input screen.png --out sheet.png', description: 'AI 重绘无字透明素材表；不是原像素切图' },
  'slice-sheet': { options: { input: text, out: text, zip: flag }, usage: 'slice-sheet --input sheet.png --out assets-dir [--zip]', description: '离线算法拆分真实透明图集，不调用模型' },
  segment: { options: { input: text, rect: text, points: text, kind: text, out: text, 'dry-run': flag },
    usage: 'segment --input screen.png --rect x,y,w,h --out cutout-dir', description: '调用 SAM 分割一个目标，保留实际输出边界及诊断' },
  tasks: { options: { id: text }, usage: 'tasks [--id task-id]', description: '查看已保存的切图任务（只读）' },
  export: { options: { task: text, out: text, module: text, 'include-text': flag },
    usage: 'export --task task-id --out assets.zip [--include-text]', description: '只导出已审核素材；保留来源、重绘与坐标空间信息' },
  download: { options: { name: text, out: text }, usage: 'download --name server-file.png --out local.png', description: '下载服务端已保存的图片' },
  serve: { options: { host: text, port: text }, usage: 'serve [--host 127.0.0.1] [--port 5173]', description: '前台启动现有 Vite/API 服务；不是生产部署或守护进程' },
};

export function usage(command) {
  const lines = ['GameUI Studio CLI', '用法：node scripts/gameui.mjs <command> [options]', ''];
  const selected = command ? [[command, COMMANDS[command]]] : Object.entries(COMMANDS);
  for (const [name, spec] of selected) {
    if (!spec) throw new CliError(`未知命令：${name}`, 'USAGE', 2);
    lines.push(`  ${spec.usage}`, `    ${spec.description}`);
  }
  lines.push('', '通用选项：--url URL  --timeout 毫秒  --json  --force  --allow-http  --help',
    'URL 默认 GAMEUI_URL 或 http://127.0.0.1:5173；远端 HTTP 需显式 --allow-http。',
    '--json 只在 stdout 输出一个 JSON 对象；诊断写入 stderr。',
    'AI 命令支持 --dry-run 导出请求计划，--response 导入外部结果（segment 除外）。',
    '不自动重试任何请求；--force 仅覆盖普通输出文件，不覆盖目录。',
    '详见 docs/cli.md。');
  return lines.join('\n');
}

export function parseCommand(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { help: usage() };
  if (command === '--version') return { version: true };
  if (command === 'help') {
    if (rest.length > 1) throw new CliError('help 最多接受一个命令名', 'USAGE', 2);
    return { help: usage(rest[0]) };
  }
  const spec = COMMANDS[command];
  if (!spec) throw new CliError(`未知命令：${command}；使用 help 查看用法`, 'USAGE', 2);
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...common, ...spec.options }, strict: true, allowPositionals: false, tokens: true });
  } catch (error) {
    throw new CliError(error.message, 'USAGE', 2);
  }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name) && !spec.options[token.name]?.multiple) {
      throw new CliError(`选项 --${token.name} 不能重复`, 'USAGE', 2);
    }
    seen.add(token.name);
  }
  const options = parsed.values;
  if (options.help) return { help: usage(command), json: options.json };
  if (options.response && options['dry-run']) throw new CliError('--response 和 --dry-run 不能同时使用', 'USAGE', 2);
  if (options.prompt !== undefined && options['prompt-file'] !== undefined) throw new CliError('--prompt 和 --prompt-file 只能选择一个', 'USAGE', 2);
  const timeout = options.timeout === undefined ? 300_000 : Number(options.timeout);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000) throw new CliError('--timeout 必须为 1–3600000 毫秒的整数', 'USAGE', 2);
  return { command, options: { ...options, timeout } };
}

export function required(options, name) {
  const value = options[name];
  if (typeof value !== 'string' || !value.trim()) throw new CliError(`缺少 --${name}`, 'USAGE', 2);
  return value;
}

export function protocol(condition, message) {
  if (!condition) throw new CliError(message, 'INVALID_RESPONSE', 3);
}
