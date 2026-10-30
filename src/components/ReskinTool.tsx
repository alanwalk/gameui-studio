import { useEffect, useRef, useState } from 'react';
import type { Settings, Style, UiElement } from '../types';
import type { PackInput, PackStyle, PackTask } from '../lib/packTypes';
import { importPack, readPackImage } from '../lib/packImport';
import { createPackTask, getPackTask, listPackTasks, packImageUrl, startPackTask } from '../lib/packApi';
import { exportPack } from '../lib/packExport';
import { nameExportElements, downloadBlob } from '../lib/export';
import './ReskinTool.css';

type Props = {
  settings: Settings;
  elements: UiElement[] | null;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  styles?: Style[];
  sourceTaskId?: string;
};
type Redraw = { elementId: string; fileName: string; dataUrl: string; w: number; h: number };
const selectionKey = 'gameui-reskin-selected-task';

export function ReskinTool({ settings, elements, busy, onBusyChange, styles = [], sourceTaskId }: Props) {
  const [tasks, setTasks] = useState<PackTask[]>([]);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(selectionKey) || '');
  const [draft, setDraft] = useState<PackInput[]>([]);
  const [draftSource, setDraftSource] = useState<string>();
  const [name, setName] = useState('素材包换肤');
  const [styleId, setStyleId] = useState('');
  const [stylePrompt, setStylePrompt] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const active = tasks.find((task) => task.id === selectedId);
  const running = active?.status === 'running';
  const locked = working || busy;

  useEffect(() => { folderInput.current?.setAttribute('webkitdirectory', ''); }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const saved = await listPackTasks();
        if (!stopped) setTasks(saved.sort((a, b) => b.updatedAt - a.updatedAt));
      } catch (failure) { if (!stopped) setError((failure as Error).message); }
      if (!stopped) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, []);

  function selectTask(id: string) {
    setSelectedId(id);
    localStorage.setItem(selectionKey, id);
    setNotice('');
  }
  function updateTask(task: PackTask) {
    setTasks((current) => [task, ...current.filter((entry) => entry.id !== task.id)]);
  }
  async function perform(operation: () => Promise<void>) {
    setWorking(true);
    onBusyChange(true);
    setError('');
    setNotice('');
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally {
      setWorking(false);
      onBusyChange(false);
    }
  }
  async function loadFiles(files: File[]) {
    if (!files.length) return;
    await perform(async () => {
      const imported = await importPack(files);
      setDraft(imported);
      setDraftSource(undefined);
      setName(files[0].name.replace(/\.zip$/i, '') || '素材包换肤');
      selectTask('');
      setNotice(`已导入 ${imported.length} 项；填写目标风格并保存任务后开始换肤。`);
    });
  }
  async function fromCurrent() {
    await perform(async () => {
      const imported: PackInput[] = [];
      for (const { element, fileName, moduleDir } of nameExportElements(elements ?? [], settings)) {
        const slice = element.slice!;
        if (slice.canvas.width !== slice.width || slice.canvas.height !== slice.height) throw new Error(`${element.label} 的切图尺寸不一致`);
        const blob = await new Promise<Blob>((resolve, reject) => slice.canvas.toBlob((value) => {
          if (value) resolve(value); else reject(new Error(`无法读取 ${element.label}`));
        }, 'image/png'));
        imported.push(await readPackImage(`${moduleDir}/${fileName}`, blob));
      }
      if (!imported.length) throw new Error('当前没有可导出的已确认素材');
      setDraft(imported);
      setDraftSource(sourceTaskId);
      setName('当前素材换肤');
      selectTask('');
      setNotice(`已从当前素材创建 ${imported.length} 项草稿；请保存任务。`);
    });
  }
  async function saveDraft() {
    await perform(async () => {
      const selectedStyle = styles.find((style) => style.id === styleId);
      const style: PackStyle = { id: selectedStyle?.id, name: selectedStyle?.name || '自定义风格', prompt: stylePrompt.trim(), image: selectedStyle?.image };
      const task = await createPackTask(name.trim(), draft, style, draftSource);
      updateTask(task);
      selectTask(task.id);
      setDraft([]);
      setNotice('任务已保存。目标风格已固定，可开始换肤。');
    });
  }
  async function runTask(itemIds?: string[], confirmRegenerate = false) {
    if (!active) return;
    await perform(async () => { updateTask(await startPackTask(active.id, itemIds, confirmRegenerate)); });
  }
  async function download() {
    if (!active) return;
    await perform(async () => {
      const task = await getPackTask(active.id);
      updateTask(task);
      if (task.status === 'running') throw new Error('任务仍在生成，请等待完成后导出');
      const { blob, report } = await exportPack(task);
      downloadBlob(blob, `${task.name.replace(/[\\/:*?"<>|]/g, '_')}.zip`);
      setNotice(report);
    });
  }
  const completed = active?.items.filter((item) => item.status === 'done').length ?? 0;
  const retryItems = active?.items.filter((item) => item.status === 'failed' || item.status === 'interrupted') ?? [];
  const keptOriginals = active?.items.filter((item) => item.status !== 'done') ?? [];
  return (
    <main className="reskin-tool">
      <header><h2>整包换肤</h2><p className="muted">导入 PNG、JPG、JPEG、WebP 散图，保持原目录、文件名与像素尺寸。任务保存后可刷新恢复。</p></header>
      <section className="reskin-toolbar" aria-label="导入素材包">
        <label>导入文件夹<input ref={folderInput} type="file" multiple disabled={locked} onChange={(event) => { void loadFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
        <label>导入 ZIP<input type="file" accept=".zip" disabled={locked} onChange={(event) => { void loadFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
        <button disabled={locked || !elements?.length} onClick={() => void fromCurrent()}>从当前素材创建换肤任务</button>
        <span className="muted">最多 300 张，单张 20 MB，整包 100 MB；ZIP 内仅接受散图文件。</span>
      </section>
      <div className="reskin-workspace">
        <aside className="reskin-task-list"><h3>已保存任务</h3>
          {draft.length > 0 && <button aria-pressed={!selectedId} onClick={() => selectTask('')}>导入草稿 · {draft.length} 项</button>}
          {tasks.map((task) => <button key={task.id} aria-pressed={selectedId === task.id} onClick={() => selectTask(task.id)}>
            <strong>{task.name}</strong><span>{task.style.name} · {task.items.filter((item) => item.status === 'done').length}/{task.items.length} · {task.status === 'running' ? '生成中' : '已保存'}</span>
          </button>)}
          {!tasks.length && <p className="muted">保存后在这里恢复任务。</p>}
        </aside>
        <section className="reskin-content">
          {!selectedId && <div className="reskin-draft">
            <label>任务名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>选择已有风格<select value={styleId} onChange={(event) => {
              const id = event.target.value;
              setStyleId(id);
              setStylePrompt(styles.find((style) => style.id === id)?.prompt ?? '');
            }}><option value="">手动填写风格</option>{styles.map((style) => <option key={style.id} value={style.id}>{style.name}</option>)}</select></label>
            <label>目标风格描述<textarea rows={3} value={stylePrompt} onChange={(event) => setStylePrompt(event.target.value)} placeholder="例如：冰川题材，手绘厚涂，冷蓝与暖橙对比" /></label>
            <button className="primary" disabled={locked || !draft.length || !stylePrompt.trim() || !name.trim()} onClick={() => void saveDraft()}>保存换肤任务（{draft.length} 项）</button>
            <div className="reskin-draft-files">{draft.map((item) => <span key={item.originalPath}>{item.originalPath} · {item.width}×{item.height}</span>)}</div>
          </div>}
          {active && <>
            <h3>{active.name}</h3><p>风格快照：{active.style.name} · {active.style.prompt}</p>
            {active.style.image && <img className="reskin-style-preview" src={`/api/image?name=${encodeURIComponent(active.style.image)}`} alt="目标风格参考" />}
            <p role="status">{running ? '服务端生成中，关闭或刷新页面后仍会继续。' : '任务已保存。'} 完成 {completed}/{active.items.length} · 失败/中断 {retryItems.length}</p>
            <progress max={active.items.length} value={active.items.filter((item) => ['done', 'failed', 'interrupted'].includes(item.status)).length} />
            <div className="reskin-actions">
              <button className="primary" disabled={locked || running || completed === active.items.length} onClick={() => void runTask()}>开始 / 继续未完成项</button>
              <button disabled={locked || running || !retryItems.length} onClick={() => void runTask(retryItems.map((item) => item.id))}>重试失败 / 中断项</button>
              <button disabled={locked || running} onClick={() => void download()}>导出原结构 ZIP{keptOriginals.length > 0 ? `（${keptOriginals.length} 项保留原图）` : ''}</button>
            </div>
            {keptOriginals.length > 0 && <details className="reskin-fallback"><summary>部分导出说明：成功 {completed} 项，以下 {keptOriginals.length} 项保留原图</summary>
              <ul>{keptOriginals.map((item) => <li key={item.id}>{item.originalPath} · {item.status} · {item.error || '尚未完成'}</li>)}</ul>
            </details>}
            <div className="reskin-pack-grid">{active.items.map((item) => <article key={item.id}>
              <h4 title={item.originalPath}>{item.originalPath}</h4>
              <div className="reskin-comparison"><figure><img loading="lazy" src={packImageUrl(item.originalImage)} alt={`原图 ${item.originalPath}`} /><figcaption>原图</figcaption></figure>
                <figure>{item.resultImage ? <img loading="lazy" src={packImageUrl(item.resultImage)} alt={`结果 ${item.originalPath}`} /> : <span>等待结果</span>}<figcaption>换肤结果</figcaption></figure></div>
              <p>展示 {item.width}×{item.height} · 编码 {item.encodedWidth ?? item.width}×{item.encodedHeight ?? item.height} · EXIF {item.orientation ?? 1} · {item.format.toUpperCase()} · {item.status}</p>
              {item.error && <p className="err">{item.error}</p>}
              {['failed', 'interrupted'].includes(item.status) && <div className="reskin-actions">
                <button disabled={locked || running} onClick={() => void runTask([item.id])}>{item.submitted ? '恢复等待已有生成' : '重试此项'}</button>
                {item.submitted && <button disabled={locked || running} onClick={() => {
                  if (window.confirm(`${item.originalPath} 的已有生成可能仍在进行。重新生成可能再次计费，确认已检查原任务并重新生成？`)) void runTask([item.id], true);
                }}>确认费用后重新生成</button>}
              </div>}
            </article>)}</div>
          </>}
          {selectedId && !active && <p>正在恢复任务；若任务已被移除，请选择其他任务或重新导入。</p>}
        </section>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
      {notice && <pre className="reskin-notice" role="status">{notice}</pre>}
      <p className="muted">结果按原展示尺寸换肤，JPEG 导出保留原编码尺寸与 EXIF 方向，透明区域填充白色。无法解码的历史结果会保留原图并列入导出报告；带方向的 PNG/WebP 暂保留原文件。</p>
    </main>
  );
}
export async function rebuildSlices(
  elements: UiElement[],
  byId: Map<string, Redraw>,
): Promise<UiElement[]> {
  const loadImage = async (dataUrl: string): Promise<HTMLImageElement> => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    return image;
  };

  const result: UiElement[] = [];
  for (const element of elements) {
    const redraw = byId.get(element.id);
    if (!element.approved || !redraw || !element.slice) {
      result.push(element);
      continue;
    }
    if (redraw.elementId !== element.id ||
        !Number.isSafeInteger(redraw.w) || !Number.isSafeInteger(redraw.h) ||
        redraw.w <= 0 || redraw.h <= 0 ||
        redraw.w !== element.slice.width || redraw.h !== element.slice.height ||
        element.slice.canvas.width !== element.slice.width || element.slice.canvas.height !== element.slice.height) {
      throw new Error(`换肤尺寸或元素 ID 不一致：${element.label}`);
    }

    const image = await loadImage(redraw.dataUrl);
    const canvas = document.createElement('canvas');
    canvas.width = element.slice.width;
    canvas.height = element.slice.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布上下文');
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    result.push({
      ...element,
      slice: { ...element.slice, canvas },
      repainted: true,
      extractionMethod: 'repaint',
      processingStatus: 'done',
      processingError: undefined,
    });
  }
  return result;
}
