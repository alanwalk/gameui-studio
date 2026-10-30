import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, required, protocol } from './options.mjs';
import { createClient } from './client.mjs';
import { ROOT, jsonText, readJson, readLimited, readImage, imagePlan, resultImage, decodeImage,
  preflightFile, preflightDirectory, writeFile, writeDirectory, sharpModule } from './io.mjs';
import { DETECT_PROMPT, SHEET_PROMPT, KINDS, parseElements, parseStyle, wireframe } from './vision.mjs';
import { splitSheet, saveSegment, exportTask } from './assets.mjs';

async function promptText(options, fallback) {
  let prompt = options.prompt ?? fallback;
  if (options['prompt-file']) prompt = (await readLimited(options['prompt-file'], 48_000)).toString('utf8');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12_000) throw new CliError('提示词需为 1–12000 字符', 'USAGE', 2);
  return prompt.trim();
}

function imageSize(value, fallback) {
  const size = value ?? fallback;
  if (!/^[1-9]\d{0,3}x[1-9]\d{0,3}$/.test(size)) throw new CliError('--size 格式应为 WIDTHxHEIGHT', 'USAGE', 2);
  const [width, height] = size.split('x').map(Number);
  if (width > 8192 || height > 8192 || width * height > 40_000_000) throw new CliError('尺寸不得超过 8192 单边或 4000 万像素', 'USAGE', 2);
  return size;
}

async function outputFile(options, extension) {
  const file = required(options, 'out');
  if (extension && path.extname(file).toLowerCase() !== extension) throw new CliError(`--out 需要 ${extension} 扩展名`, 'USAGE', 2);
  return preflightFile(file, options.force);
}

async function optionalJson(data, options) {
  if (options.out) return { ...data, outputFile: await writeFile(options.out, jsonText(data), options.force) };
  return data;
}

async function uploaded(image, client) {
  const result = await client.request('/api/upload', { body: { image: image.dataUrl, prefix: 'cli' } });
  protocol(typeof result?.fileName === 'string' && /^[A-Za-z0-9_-]+\.png$/.test(result.fileName), '上传响应缺少有效图片文件名');
  return result.fileName;
}

async function taskList(client) {
  const response = await client.request('/api/slice-tasks');
  protocol(Array.isArray(response?.tasks), '切图任务响应缺少 tasks');
  return response.tasks;
}

async function taskById(client, id) {
  const task = (await taskList(client)).find((entry) => entry.id === id);
  if (!task) throw new CliError(`没有找到切图任务：${id}`, 'TASK_NOT_FOUND', 3);
  return task;
}

function modelOption(options) {
  if (options.model !== undefined && (!options.model.trim() || options.model.length > 200)) throw new CliError('--model 无效', 'USAGE', 2);
  return options.model;
}

async function detect(image, options, getClient) {
  const request = { image: image.dataUrl, width: image.width, height: image.height,
    system: DETECT_PROMPT, model: modelOption(options) };
  const response = options.response ? await readJson(options.response) : await getClient().request('/api/detect', { body: request, paid: true });
  return { width: image.width, height: image.height, source: imagePlan(image),
    provenance: options.response ? 'external-analysis' : 'service-analysis', elements: parseElements(response, image.width, image.height) };
}

function plan(route, body, references) {
  return { mode: 'request-plan', modelCalled: false, route, body, references,
    note: '仅输出计划，未上传、未调用服务、未生成图片。外部模型结果可用 --response 导入。' };
}

async function runStyle(options, getClient) {
  const description = options.description ?? '';
  if (description.length > 8000) throw new CliError('画风描述最长 8000 字符', 'USAGE', 2);
  const files = [...(options.input ? [options.input] : []), ...(options.reference ?? [])];
  if (files.length > 12 || (!files.length && !description.trim())) throw new CliError('请提供参考图片或 --description；参考图最多 12 张', 'USAGE', 2);
  const images = [];
  for (const file of files) {
    const image = await readImage(file);
    if (image.width * image.height > 16_777_216) throw new CliError('画风参考图不能超过 16777216 像素', 'INVALID_IMAGE', 2);
    images.push(image);
  }
  const model = modelOption(options);
  if (options['dry-run']) return plan('/api/style-generation/analyze', { description, model, referenceImages: '<uploaded reference filenames>' }, images.map(imagePlan));
  if (options.out) await preflightFile(options.out, options.force);
  let response;
  if (options.response) response = await readJson(options.response);
  else {
    const referenceImages = [];
    for (const image of images) {
      const reference = await getClient().request('/api/style-generation/reference', { body: { dataUrl: image.dataUrl } });
      protocol(typeof reference?.fileName === 'string' && /^[A-Za-z0-9_-]+\.png$/.test(reference.fileName), '画风参考上传响应无效');
      referenceImages.push(reference.fileName);
    }
    response = await getClient().request('/api/style-generation/analyze', { body: { description, referenceImages, model }, paid: true });
  }
  return optionalJson({ ...parseStyle(response), references: images.map(imagePlan),
    provenance: options.response ? 'external-analysis' : 'service-analysis' }, options);
}

async function runGeneration(command, options, getClient) {
  const isSheet = command === 'ai-sheet';
  const primary = await readImage(required(options, isSheet ? 'input' : 'wireframe'));
  let style;
  if (options.style) style = parseStyle(await readJson(options.style));
  const styleImage = options['style-image'] ? await readImage(options['style-image']) : undefined;
  const size = imageSize(options.size, `${primary.width}x${primary.height}`);
  let prompt = await promptText(options, isSheet ? SHEET_PROMPT :
    'Render a complete game UI using the first reference as the wireframe. Preserve its canvas, positions and proportions. Use the selected art style; the second reference, when present, is style only.');
  if (style) prompt += `\nArt style: ${style.prompt}`;
  if (prompt.length > 12_000) throw new CliError('合并画风后的提示词超过 12000 字符', 'USAGE', 2);
  const route = isSheet ? '/api/ai-slice-sheet' : '/api/generate';
  if (options['dry-run']) return plan(route, { prompt, size, operation: isSheet ? 'ai-repaint-sheet' : 'generate-screen' },
    [imagePlan(primary), ...(styleImage ? [imagePlan(styleImage)] : [])]);
  const destination = await outputFile(options, '.png');
  let image;
  let response;
  if (options.response) image = await readImage(options.response);
  else {
    const body = isSheet ? { reference: primary.dataUrl, prompt, size } : {
      wireframe: primary.dataUrl, styleImage: styleImage ? await uploaded(styleImage, getClient()) : undefined, prompt, size,
    };
    response = await getClient().request(route, { body, paid: true });
    try { image = await resultImage(response?.dataUrl); }
    catch (error) {
      error.details = { ...error.details, mayHaveBeenSubmitted: true, responseReceived: true, serverFile: response?.fileName, retried: false };
      throw error;
    }
  }
  try { await writeFile(destination, image.png, options.force); }
  catch (error) {
    error.details = { ...error.details, serverFile: response?.fileName, modelRequestCompleted: !options.response,
      note: '图片已返回，但本地写入失败；不要为重试写文件而再次提交生图。' };
    throw error;
  }
  const actualSize = `${image.width}x${image.height}`;
  return { outputFile: destination, requestedSize: size, actualSize, serverFile: response?.fileName,
    provenance: options.response ? 'external-image' : isSheet ? 'ai-repaint-sheet' : 'ai-generated-screen',
    modelCalled: !options.response, warnings: actualSize === size ? [] : ['实际尺寸不同于请求；保留模型原图，未强行拉伸或裁剪。'] };
}

async function runSegment(options, getClient) {
  const image = await readImage(required(options, 'input'));
  const values = required(options, 'rect').split(',');
  if (values.length !== 4 || values.some((value) => !/^\d+$/.test(value))) throw new CliError('--rect 需要四个整数：x,y,w,h', 'USAGE', 2);
  const [x, y, w, h] = values.map(Number);
  if (![x, y, w, h].every(Number.isSafeInteger) || w < 1 || h < 1 || x + w > image.width || y + h > image.height) {
    throw new CliError('--rect 超出规范化图片范围或宽高无效', 'USAGE', 2);
  }
  const kind = options.kind ?? 'icon';
  if (!KINDS.includes(kind)) throw new CliError('--kind 不是支持的素材类型', 'USAGE', 2);
  const points = options.points ? await readJson(options.points) : undefined;
  if (points !== undefined && (!Array.isArray(points) || points.length > 256 || points.some((point) =>
    !point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 ||
    point.x >= image.width || point.y >= image.height || ![0, 1].includes(point.label)))) {
    throw new CliError('--points 必须是原图范围内最多 256 个 {x,y,label:0|1}', 'USAGE', 2);
  }
  const rect = { x, y, w, h };
  if (options['dry-run']) return plan('/api/segment', { sourceImage: '<uploaded source filename>', rect, points, kind }, [imagePlan(image)]);
  const directory = await preflightDirectory(required(options, 'out'));
  const sourceImage = await uploaded(image, getClient());
  const result = await getClient().request('/api/segment', { body: { sourceImage, rect, points, kind } });
  return saveSegment(image, rect, result, directory);
}

async function serve(options) {
  const port = Number(options.port ?? 5173);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new CliError('--port 必须为 1–65535 的整数', 'USAGE', 2);
  const host = options.host ?? '127.0.0.1';
  if (!host.trim()) throw new CliError('--host 不能为空', 'USAGE', 2);
  // Keep the existing Vite configuration and API middleware; do not invent a second server.
  // vite.config.ts and the existing stores resolve environment/data from cwd.
  process.chdir(fileURLToPath(ROOT));
  const { createServer } = await import('vite');
  const server = await createServer({ root: fileURLToPath(ROOT), logLevel: 'error', server: { host, port, strictPort: true, open: false } });
  try {
    await server.listen();
    process.stderr.write(`gameui: 服务已启动 ${server.resolvedUrls?.local?.[0] ?? `${host}:${port}`}；Ctrl+C 停止。\n`);
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) process.stderr.write('gameui: 注意：现有服务没有 CLI 提供的用户认证；仅绑定可信网络，不要直接暴露公网。\n');
    await new Promise((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return { stopped: true, host, port };
  } finally { await server.close(); }
}

export async function execute(command, options) {
  let client;
  const getClient = () => client ??= createClient(options);
  switch (command) {
    case 'health': {
      const health = await getClient().request('/api/health');
      protocol(typeof health?.gateway === 'boolean', '健康检查响应无效');
      const segmentation = options.segment ? await getClient().request('/api/segment-health', { accepted: [503] }) : undefined;
      if (options.segment && segmentation?.available !== true) throw new CliError('SAM runtime 不可用', 'DEPENDENCY_UNAVAILABLE', 3, { health, segmentation });
      return { serviceReachable: true, health, segmentation };
    }
    case 'models': {
      const result = await getClient().request('/api/models');
      protocol(Array.isArray(result?.models) && result.models.every((model) => typeof model === 'string'), '模型列表协议无效');
      return result;
    }
    case 'upload': {
      const image = await readImage(required(options, 'input'));
      return { fileName: await uploaded(image, getClient()), width: image.width, height: image.height };
    }
    case 'style': return runStyle(options, getClient);
    case 'detect':
    case 'layout': {
      const image = await readImage(required(options, 'input'));
      if (options['dry-run']) return plan('/api/detect', { width: image.width, height: image.height, system: DETECT_PROMPT, model: modelOption(options) }, [imagePlan(image)]);
      if (command === 'layout') await preflightDirectory(required(options, 'out'));
      else if (options.out) await preflightFile(options.out, options.force);
      const result = await detect(image, options, getClient);
      if (command === 'detect') return optionalJson(result, options);
      const rendered = wireframe(result.elements, image.width, image.height);
      const sharp = await sharpModule();
      const png = await sharp(Buffer.from(rendered.svg), { limitInputPixels: 40_000_000 }).png().toBuffer();
      return writeDirectory(options.out, async (stage) => {
        const layout = { schemaVersion: 1, width: image.width, height: image.height, nodes: rendered.nodes, source: result.source };
        await fs.writeFile(path.join(stage, 'layout.json'), jsonText(layout));
        await fs.writeFile(path.join(stage, 'elements.json'), jsonText(result));
        await fs.writeFile(path.join(stage, 'wireframe.svg'), rendered.svg);
        await fs.writeFile(path.join(stage, 'wireframe.png'), png);
        return { count: rendered.nodes.length, provenance: result.provenance, width: image.width, height: image.height };
      });
    }
    case 'generate':
    case 'ai-sheet': return runGeneration(command, options, getClient);
    case 'slice-sheet': {
      const directory = await preflightDirectory(required(options, 'out'));
      return splitSheet(await readImage(required(options, 'input')), directory, options.zip);
    }
    case 'segment': return runSegment(options, getClient);
    case 'tasks': return options.id ? taskById(getClient(), options.id) : { tasks: await taskList(getClient()) };
    case 'export': {
      const id = required(options, 'task');
      await outputFile(options, '.zip');
      return exportTask(await taskById(getClient(), id), getClient(), options);
    }
    case 'download': {
      const name = required(options, 'name');
      if (!/^[A-Za-z0-9_-]+\.png$/.test(name)) throw new CliError('--name 必须是服务端 PNG 文件名，不是路径', 'USAGE', 2);
      const file = await outputFile(options, '.png');
      const bytes = await getClient().request(`/api/image?name=${encodeURIComponent(name)}`, { binary: true, maxBytes: 20 * 1024 * 1024 });
      const image = await decodeImage(bytes);
      await writeFile(file, bytes, options.force);
      return { outputFile: file, width: image.width, height: image.height };
    }
    case 'serve': return serve(options);
    default: throw new CliError(`未实现的命令：${command}`, 'USAGE', 2);
  }
}
