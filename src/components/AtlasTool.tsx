import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Style } from '../types';
import type { PackTask } from '../lib/packTypes';
import type { AtlasImport, AtlasJob } from '../lib/atlasTypes';
import { atlasDataUrl, atlasPackInputs, importAtlas } from '../lib/atlasImport';
import { atlasFileUrl, exportAtlas, readAtlasJob } from '../lib/atlasExport';
import { createPackTask, getPackTask, listPackTasks, packImageUrl, startPackTask } from '../lib/packApi';
import { downloadBlob } from '../lib/export';
import './AtlasTool.css';

export type AtlasToolProps = { styles?: Style[]; busy: boolean; onBusyChange: (busy: boolean) => void };
const selectionKey = 'gameui-atlas-selected-job';
async function atlasRequest<T>(suffix = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/atlas-jobs${suffix}`, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '图集请求失败');
  return result as T;
}

/** Embedded under the existing whole-pack tool's atlas mode; no global navigation entry. */
export function AtlasTool({ styles = [], busy, onBusyChange }: AtlasToolProps) {
  const [jobs, setJobs] = useState<AtlasJob[]>([]);
  const [selected, setSelected] = useState(() => localStorage.getItem(selectionKey) || '');
  const [draft, setDraft] = useState<AtlasImport>();
  const [name, setName] = useState('图集换肤');
  const [descriptions, setDescriptions] = useState('');
  const [styleId, setStyleId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState<PackTask>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [edge, setEdge] = useState(0);
  const [preview, setPreview] = useState<{ path: string; url: string }[]>([]);
  const folder = useRef<HTMLInputElement>(null);
  const selection = useRef(selected);
  const active = jobs.find(j => j.id === selected);
  const manifest = draft?.manifest ?? active?.manifest;
  const locked = busy || working;

  useEffect(() => { folder.current?.setAttribute('webkitdirectory', ''); }, []);
  useEffect(() => () => { preview.forEach(p => URL.revokeObjectURL(p.url)); }, [preview]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const saved = await atlasRequest<AtlasJob[]>();
        if (stopped) return;
        setJobs(saved);
        const job = saved.find(j => j.id === selection.current);
        if (job) {
          let packId = job.packTaskId;
          if (!packId) {
            // A crash between C creation and link is recoverable by the persisted source ID.
            const candidates = (await listPackTasks()).filter(t => t.sourceTaskId === job.id);
            if (candidates.length > 1) throw new Error('此图集关联多个候选任务，请检查任务来源');
            if (candidates[0]) {
              const linked = await atlasRequest<AtlasJob>(`/${job.id}/link`, { packTaskId: candidates[0].id });
              packId = linked.packTaskId;
              if (!stopped) setJobs(current => current.map(j => j.id === linked.id ? linked : j));
            }
          }
          const restored = packId ? await getPackTask(packId) : undefined;
          if (!stopped && selection.current === job.id) setTask(restored);
        }
      } catch (failure) { if (!stopped) setError((failure as Error).message); }
      if (!stopped) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [selected]);

  function select(id: string) {
    selection.current = id;
    setSelected(id);
    localStorage.setItem(selectionKey, id);
    setDraft(undefined);
    setTask(undefined);
    setPreview([]);
    setNotice('');
    setError('');
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
  async function load(files: File[]) {
    if (!files.length) return;
    await perform(async () => {
      const paths = descriptions.trim() ? descriptions.split(',').map(p => p.trim()) : undefined;
      const imported = await importAtlas(files, paths);
      select('');
      setDraft(imported);
      setName(files[0].name.replace(/\.zip$/i, '') || '图集换肤');
      setNotice(`导入 ${imported.manifest.pages.length} 页、${imported.manifest.regions.length} 个独立 region；请先保存原图集。`);
    });
  }
  async function save() {
    if (!draft) return;
    await perform(async () => {
      const files = [...draft.files].map(([path, bytes]) => ({ path, base64: atlasDataUrl(bytes).split(',')[1] }));
      const job = await atlasRequest<AtlasJob>('', { name, files, descriptions: draft.manifest.descriptions });
      setJobs(current => [job, ...current]);
      select(job.id);
      setNotice('原文件和 region 映射已保存，可刷新恢复。');
    });
  }
  async function run(itemIds?: string[], confirmRegenerate = false) {
    if (!active) return;
    await perform(async () => {
      let current = task;
      if (!current) {
        const candidates = (await listPackTasks()).filter(t => t.sourceTaskId === active.id);
        if (candidates.length > 1) throw new Error('图集存在多个 Pack 候选任务，请检查来源');
        current = candidates[0];
        if (!current) {
          const libraryStyle = styles.find(style => style.id === styleId);
          const targetPrompt = libraryStyle?.prompt ?? prompt;
          if (!targetPrompt.trim()) throw new Error('请选择目标风格或填写换肤描述');
          const inputs = await atlasPackInputs(await readAtlasJob(active));
          const style = libraryStyle ?? { name: '自定义风格', prompt: targetPrompt };
          current = await createPackTask(active.name, inputs, style, active.id);
        }
        const linked = await atlasRequest<AtlasJob>(`/${active.id}/link`, { packTaskId: current.id });
        setJobs(jobs => jobs.map(job => job.id === linked.id ? linked : job));
        setTask(current);
      }
      const updated = await startPackTask(current.id, itemIds, confirmRegenerate);
      setTask(updated);
      setNotice('已交给整包换肤服务；关闭或刷新页面后可继续查看与恢复。');
    });
  }
  async function output(download: boolean) {
    if (!active && !draft) return;
    await perform(async () => {
      const imported = draft ?? await readAtlasJob(active!);
      const latest = active?.packTaskId ? await getPackTask(active.packTaskId) : task;
      const result = await exportAtlas(imported, latest, edge);
      setPreview([...result.pages].map(([path, blob]) => ({ path, url: URL.createObjectURL(blob) })));
      setNotice(result.report);
      if (download) downloadBlob(result.blob, `${active?.name ?? name}-atlas.zip`);
    });
  }
  const resumeIds = task?.items.filter(item => item.status !== 'done').map(item => item.id) ?? [];
  const unknownIds = task?.items.filter(item => (item.status === 'failed' || item.status === 'interrupted') && item.submitted && !item.pendingId).map(item => item.id) ?? [];

  function onImportFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void load(files);
  }

  function regenerateUnknownItems() {
    const confirmed = window.confirm('这些项的提交结果未知，重新生成可能重复计费。已检查费用并确认重新生成？');
    if (confirmed) void run(unknownIds, true);
  }

  return <section className="atlas-tool" aria-label="图集换肤">
    <p>按 region 拆图换肤，保留原页尺寸、路径和描述字节。支持 TexturePacker JSON、Cocos XML plist 2/3、Spine 0/90° 多页，图集页为非交错 8-bit PNG。</p>
    <div className="atlas-import">
      <label>描述相对路径（逗号分隔，可选）<input value={descriptions} disabled={locked} onChange={e => setDescriptions(e.target.value)} placeholder="留空解析所有 json/plist/atlas；有其它 JSON 时请指定" /></label>
      <label>导入文件夹<input ref={folder} type="file" multiple disabled={locked} onChange={onImportFiles} /></label>
      <label>导入 ZIP 或素材与描述<input type="file" multiple disabled={locked} onChange={onImportFiles} /></label>
    </div>
    <label>已保存图集<select value={selected} disabled={locked} onChange={e => select(e.target.value)}>
      <option value="">新导入</option>{jobs.map(j => <option key={j.id} value={j.id}>{j.name} · {j.manifest.regions.length} 项</option>)}
    </select></label>
    {draft && <div className="atlas-actions"><label>任务名称<input value={name} onChange={e => setName(e.target.value)} disabled={locked} /></label><button disabled={locked} onClick={() => void save()}>保存原图集</button></div>}
    {manifest && <>
      <h3>{active?.name ?? name}</h3>
      <p>{manifest.pages.length} 页 · {manifest.regions.length} 个独立 region · {manifest.files.length} 个原文件{task && ` · ${task.status} · Pack ${task.id}`}</p>
      <div className="atlas-actions">
        <label>目标风格<select disabled={locked || !!task} value={styleId} onChange={e => setStyleId(e.target.value)}><option value="">自定义</option>{styles.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        {!styleId && <label>换肤描述<textarea value={prompt} disabled={locked || !!task} onChange={e => setPrompt(e.target.value)} /></label>}
        <button disabled={locked || !active || task?.status === 'running' || !!task && !resumeIds.length} onClick={() => void run(task ? resumeIds : undefined)}>{task ? '继续未完成项 / 重试失败项' : '开始 region 换肤'}</button>
        {!!unknownIds.length && <button disabled={locked || task?.status === 'running'} onClick={regenerateUnknownItems}>确认重新生成未知项（可能计费）</button>}
      </div>
      <div className="atlas-actions"><label>边缘像素<select value={edge} disabled={locked} onChange={e => setEdge(Number(e.target.value))}><option value={0}>保留原边缘（不修改 padding/extrude）</option>{[1, 2, 4].map(n => <option key={n} value={n}>复制新边缘 {n} px（碰邻区则拒绝）</option>)}</select></label>
        <button disabled={locked} onClick={() => void output(false)}>检查回填页</button><button disabled={locked} onClick={() => void output(true)}>导出原结构 ZIP</button></div>
      <p>默认保留页外边缘，换色后可能有旧色边；已知 extrude 宽度时请选择复制新边缘。所有失败、未完成或无法读取的结果保留原像素。</p>
      <div className="atlas-pages">{manifest.pages.map(page => {
        const index = active?.files.findIndex(file => file.path === page.path) ?? -1;
        let original: string | undefined;
        if (active && index >= 0) original = atlasFileUrl(active.id, index);
        else if (draft) original = atlasDataUrl(draft.files.get(page.path)!);
        const result = preview.find(p => p.path === page.path);
        return <article key={page.path}><h4>{page.path} · {page.width} × {page.height}</h4><div className="atlas-comparison"><figure><figcaption>原页</figcaption><a href={original} target="_blank" rel="noreferrer"><img src={original} alt={`原页 ${page.path}`} /></a></figure>{result && <figure><figcaption>回填页</figcaption><a href={result.url} target="_blank" rel="noreferrer"><img src={result.url} alt={`回填页 ${page.path}`} /></a></figure>}</div></article>;
      })}</div>
      <div className="atlas-regions">{manifest.regions.map(region => {
        const item = task?.items.find(item => item.originalPath === region.inputPath);
        return <article key={region.inputPath}><strong>{region.names.join(' / ')}</strong><small>{region.pagePath} ({region.x}, {region.y}) · {region.width} × {region.height} · {region.rotation} · trim ({region.left}, {region.top}) / {region.sourceWidth} × {region.sourceHeight}</small><span>{item?.status ?? '尚未运行'} {item?.error}</span>{item && <div className="atlas-comparison"><figure><figcaption>复原原图</figcaption><img src={packImageUrl(item.originalImage)} alt={region.names[0]} /></figure>{item.resultImage && <figure><figcaption>结果</figcaption><img src={packImageUrl(item.resultImage)} alt={`${region.names[0]} 换肤结果`} /></figure>}</div>}</article>;
      })}</div>
    </>}
    {error && <p role="alert" className="atlas-error">{error}</p>}
    {notice && <pre role="status" className="atlas-notice">{notice}</pre>}
  </section>;
}
