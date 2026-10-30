import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { saveImage, readImage } from './store';
import type { DrawingState, DrawingTask, DrawingImage } from '../src/lib/drawingTypes';

export const drawingRoot = path.resolve(process.env.GAMEUI_DATA ?? '.data', 'drawing');
const indexPath = path.join(drawingRoot, 'index.json');
type StoredImage = DrawingImage & { file: string };
type Index = { tasks: DrawingTask[]; images: StoredImage[] };
let writes: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation);
  writes = result.catch(() => undefined);
  return result;
}

async function readIndex(): Promise<Index> {
  try {
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as Index;
    if (!Array.isArray(index.tasks) || !Array.isArray(index.images)) throw new Error('画图索引损坏');
    return index;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tasks: [], images: [] };
    throw error;
  }
}

async function writeIndex(index: Index): Promise<void> {
  await fs.mkdir(drawingRoot, { recursive: true });
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(index));
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(temporary, indexPath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function getDrawingState(): Promise<DrawingState> {
  return enqueue(async () => {
    const index = await readIndex();
    // Server paths are recovery details, never browser-provided file access.
    const tasks = index.tasks.map(({ watchPath: _watchPath, pendingId: _pendingId, ...task }) => task);
    const images = index.images.map(({ file: _file, ...image }) => image);
    return { tasks, images };
  });
}

export function getDrawingTasks(): Promise<DrawingTask[]> {
  return enqueue(async () => (await readIndex()).tasks);
}

export function addDrawingTask(task: DrawingTask): Promise<void> {
  return enqueue(async () => {
    const index = await readIndex();
    index.tasks.push(task);
    await writeIndex(index);
  });
}

export function updateDrawingTask(id: string, change: (task: DrawingTask) => void): Promise<void> {
  return enqueue(async () => {
    const index = await readIndex();
    const task = index.tasks.find((entry) => entry.id === id);
    if (!task) throw new Error('画图记录不存在');
    change(task);
    task.updatedAt = Date.now();
    await writeIndex(index);
  });
}

export function saveDrawingImage(dataUrl: string, name: string, size: { width: number; height: number }, sourceImages?: string[]): Promise<DrawingImage> {
  return enqueue(async () => {
    const index = await readIndex();
    const image = { id: randomUUID(), name, mime: 'image/png', ...size, createdAt: Date.now(), sourceImages };
    const file = await saveImage(dataUrl, `drawing-${image.id}`);
    index.images.push({ ...image, file });
    await writeIndex(index);
    return image;
  });
}

export function readDrawingImage(id: string): Promise<{ image: DrawingImage; bytes: Buffer }> {
  return enqueue(async () => {
    const index = await readIndex();
    const image = index.images.find((entry) => entry.id === id);
    if (!image) throw new Error('画图图片不存在');
    const dataUrl = await readImage(image.file);
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
    return { image, bytes };
  });
}
