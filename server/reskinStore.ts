import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PackTask } from '../src/lib/packTypes';

export const reskinRoot = path.resolve(process.env.GAMEUI_DATA ?? '.data', 'reskin');
const indexPath = path.join(reskinRoot, 'tasks.json');
let writes: Promise<unknown> = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.then(operation);
  writes = result.catch(() => undefined);
  return result;
}
async function readTasks(): Promise<PackTask[]> {
  try {
    const tasks = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    if (!Array.isArray(tasks)) throw new Error('换肤任务索引损坏');
    return tasks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
async function writeTasks(tasks: PackTask[]): Promise<void> {
  await fs.mkdir(reskinRoot, { recursive: true });
  const temporary = `${indexPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(tasks));
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, indexPath); break; }
      catch (error) {
        if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(20 * (attempt + 1));
      }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}
export function listReskinTasks(): Promise<PackTask[]> { return enqueue(readTasks); }
export function createReskinTask(task: PackTask): Promise<PackTask> {
  return enqueue(async () => {
    const tasks = await readTasks();
    tasks.push(task);
    await writeTasks(tasks);
    return task;
  });
}
export function updateReskinTask(id: string, change: (task: PackTask) => void): Promise<PackTask> {
  return enqueue(async () => {
    const tasks = await readTasks();
    const task = tasks.find((entry) => entry.id === id);
    if (!task) throw new Error('换肤任务不存在');
    change(task);
    task.updatedAt = Date.now();
    await writeTasks(tasks);
    return task;
  });
}
export async function recoverReskinTasks(): Promise<void> {
  return enqueue(async () => {
    const tasks = await readTasks();
    for (const task of tasks) {
      if (task.status !== 'running') continue;
      task.status = 'interrupted';
      for (const item of task.items) {
        if (item.status !== 'running') continue;
        item.status = 'interrupted';
        item.error = item.pendingId ? '服务重启：可继续等待已有生成任务' : '服务重启：提交结果未知；请先检查费用，确认后才能重新生成';
      }
    }
    await writeTasks(tasks);
  });
}
export function reskinImagePath(name: string): string {
  if (!/^[a-f0-9-]+\.(png|jpeg|webp)$/.test(name)) throw new Error('无效的换肤图片引用');
  return path.join(reskinRoot, 'images', name);
}
export async function saveReskinImage(bytes: Uint8Array, format: string): Promise<string> {
  const name = `${randomUUID()}.${format}`;
  const target = reskinImagePath(name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' });
  return name;
}
