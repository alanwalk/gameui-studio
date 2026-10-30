import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProjectRenderTask } from '../src/lib/projectRenderTypes';

export type StoredProjectRender = ProjectRenderTask & {
  digest: string;
  references: string[];
  submitted?: boolean;
  pendingId?: string;
  watchPath?: string;
};

export const projectRenderRoot = path.resolve(process.env.GAMEUI_DATA ?? '.data', 'project-render');
const indexPath = path.join(projectRenderRoot, 'tasks.json');
let writes: Promise<unknown> = Promise.resolve();

async function read(): Promise<StoredProjectRender[]> {
  try {
    const tasks = JSON.parse(await fs.readFile(indexPath, 'utf8'));
    if (!Array.isArray(tasks)) throw new Error('项目生成任务索引损坏');
    return tasks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export function projectRenderTransaction<T>(change: (tasks: StoredProjectRender[]) => Promise<T>): Promise<T> {
  const result = writes.then(async () => {
    const tasks = await read();
    const value = await change(tasks);
    await fs.mkdir(projectRenderRoot, { recursive: true });
    const temporary = `${indexPath}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(tasks));
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, indexPath); break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code ?? '';
          if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
          await delay(20 * (attempt + 1));
        }
      }
    } finally { await fs.rm(temporary, { force: true }); }
    return value;
  });
  writes = result.catch(() => undefined);
  return result;
}

export function readProjectRenders(): Promise<StoredProjectRender[]> {
  const result = writes.then(read);
  writes = result.catch(() => undefined);
  return result;
}

export function publicProjectRender(task: StoredProjectRender): ProjectRenderTask {
  const { digest: _digest, references: _references, submitted: _submitted, pendingId: _pendingId, watchPath: _watchPath, ...value } = task;
  return value;
}
