import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Settings, SliceTask, SliceTaskSource, UiElement } from '../types';
import { buildZip, downloadBlob } from '../lib/export';
import { imageUrl } from '../lib/magpie';
import { createSliceAtlas } from '../lib/sliceAtlas';
import { extractSliceTask, newSliceTask, repaintTask, uploadSliceImage, type SliceSourceImage, type SliceTaskSession } from '../lib/sliceTasks';
import { AssetsStage } from './AssetsStage';
import { SliceAtlasPreview } from './SliceAtlasPreview';
import { StudioDialog } from './StudioDialog';
import { ToastQueue } from './ToastQueue';
import './slicer-tasks.css';

type Props = {
  extractionMethod?: 'segmentation' | 'color-key';
  settings: Settings;
  session: SliceTaskSession;
  onSelectSource: (source: SliceTaskSource | null) => void;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
};

const TASK_STATUS: Record<SliceTask['status'],string> = {idle:'待处理',running:'处理中',done:'已完成',interrupted:'待重试'};

function taskProgress(task: SliceTask): number {
  if (task.status === 'done') return 100;
  if (!task.elements.length) return 0;
  const processed = task.elements.filter(element => element.processingStatus === 'done' || element.processingStatus === 'failed' || !!element.slice).length;
  return Math.round(processed / task.elements.length * 100);
}

export function SlicerTool({extractionMethod='segmentation',settings,busy,onBusyChange,session,onSelectSource}:Props) {
  const {source,elements,task} = session;
  const restoring = !session.loaded || (!!task && (!source || elements === null));
  const blocked = busy || restoring || session.hasUnsaved;
  const tasks = session.tasks.filter(entry => entry.source.kind === 'standalone').sort((a,b) => b.createdAt-a.createdAt);
  const [editorOpen,setEditorOpen] = useState(false);
  const [deleting,setDeleting] = useState<SliceTask|null>(null);
  const [progress,setProgress] = useState<string|null>(null);
  const [status,setStatus] = useState<string|null>(null);
  const [error,setError] = useState<string|null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef(false);

  useEffect(() => {
    if (session.loaded && !task && tasks.length && !busy && !session.hasUnsaved) onSelectSource(tasks[0].source);
  },[session.loaded,task,tasks,busy,session.hasUnsaved,onSelectSource]);

  async function run(action:()=>Promise<void>,needsLoadedSource=true) {
    if (busy || !session.loaded || session.hasUnsaved || pending.current) return;
    if (needsLoadedSource && restoring) return;
    pending.current = true;
    onBusyChange(true);
    setError(null);
    setStatus(null);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      pending.current = false;
      onBusyChange(false);
      setProgress(null);
    }
  }

  async function processTask(target:SliceTask,items:UiElement[],image:SliceSourceImage) {
    session.assertCanProcess();
    await extractSliceTask(session,target,items,image,settings,message => {
      if (session.isCurrent(target.source)) setProgress(message);
    },extractionMethod);
  }

  const onPick = (file:File) => run(async () => {
    session.assertCanProcess();
    if (!['image/png','image/jpeg','image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片');
    if (file.size > 20*1024*1024) throw new Error('单张图片不能超过 20 MB');
    const dataUrl = await readFileAsDataUrl(file);
    const image = new Image();
    image.src = dataUrl;
    await image.decode();
    const sourceImage = await uploadSliceImage(dataUrl);
    const target = newSliceTask({kind:'standalone',sourceImage},file.name,image.naturalWidth,image.naturalHeight);
    await session.save(target,[]);
    onSelectSource(target.source);
    setProgress('任务已创建，正在处理…');
    const sourceImageData = {dataUrl,width:image.naturalWidth,height:image.naturalHeight};
    await processTask(target,[],sourceImageData);
    setStatus('切图处理结束，结果已保存');
  },false);

  const onAnalyze = () => run(async () => {
    if (!task || !elements || !source) return;
    await processTask(task,elements,source);
    setStatus('切图处理结束，结果已保存');
  });

  const onPlate = () => run(async () => {
    if (!task || !elements || !source) return;
    await repaintTask(session,task,elements,source,setProgress);
    setStatus('补图处理完成');
  });

  const onExportZip = () => run(async () => {
    if (!elements) return;
    const result = await buildZip(elements,settings);
    downloadBlob(result.blob,result.fileName);
    setStatus('素材 ZIP 已下载');
  });

  const onExportAtlas = () => run(async () => {
    if (!elements || !task) return;
    const atlas = createSliceAtlas(elements);
    const blob = await new Promise<Blob>((resolve,reject) => atlas.toBlob(result => {
      if (result) resolve(result);else reject(new Error('图集导出失败'));
    },'image/png'));
    downloadBlob(blob,`ui-atlas-${task.id}.png`);
    setStatus('图集已下载');
  });

  const onDelete = () => run(async () => {
    if (!deleting) return;
    await session.removeTask(deleting.id);
    const next = tasks.find(entry => entry.id !== deleting.id);
    onSelectSource(next?.source ?? null);
    setDeleting(null);
    setStatus('任务已删除');
  },false);

  const onToggleElement = (id:string) => {
    if (blocked || !elements) return;
    session.changeElements(elements.map(element => element.id === id ? {...element,approved:!element.approved} : element));
  };

  const hasExportable = elements?.some(element => element.approved && element.slice) ?? false;
  const percentage = task ? taskProgress(task) : 0;
  const sourceVersion = task ? {id:task.id,image:task.source.sourceImage,prompt:'',createdAt:task.createdAt} : null;
  const panelProps = {elements,busy,blocked,source:source ?? undefined,sourceImage:task?.source.sourceImage,settings,
    onAnalyze:()=>void onAnalyze(),onPlate:()=>void onPlate(),onExport:()=>void onExportZip(),onToggle:onToggleElement,
    onChangeElements:(updated:UiElement[])=>{if(!blocked)session.changeElements(updated);}};
  let preview: ReactNode = <div className="slicer-empty">选择任务查看切图结果</div>;
  if (task && restoring) preview = <div className="slicer-empty">正在加载任务…</div>;
  else if (task && hasExportable && elements) preview = <SliceAtlasPreview elements={elements}/>;
  else if (task) preview = <div className="slicer-source-preview"><img src={imageUrl(task.source.sourceImage)} alt="任务原图"/>
    <span>{busy ? '正在处理…' : '尚无切图结果，可在资源编辑器中开始处理。'}</span></div>;

  return <main className="slicer-task-page" aria-label="切图工具">
    <header className="slicer-task-heading"><div><h1>Game UI Slicer - 从任意截图提取 UI 素材</h1>
      <p>上传游戏截图或界面图片，提取图标、按钮和底框，结果自动保存在任务列表。</p></div>
      <button aria-label="刷新切图任务" title="刷新任务" disabled={busy || session.hasUnsaved} onClick={()=>void session.reload()}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M20 12a8 8 0 1 1-2-6"/></svg>
      </button>
    </header>
    <div className="slicer-task-columns">
      <section className="slicer-task-list" aria-label="任务列表">
        <header><h2>任务列表</h2><span>{tasks.length} 条</span></header>
        <div>{tasks.map(entry => <button key={entry.id} className={`slicer-task-row ${entry.id === task?.id ? 'active' : ''}`}
          disabled={busy || session.hasUnsaved} onClick={()=>onSelectSource(entry.source)} aria-pressed={entry.id === task?.id}>
          <img src={imageUrl(entry.source.sourceImage)} alt=""/>
          <span className="slicer-task-summary"><strong title={entry.name}>{entry.name}</strong><span className={`slicer-status ${entry.status}`}>{TASK_STATUS[entry.status]}</span>
            <small>创建时间：{new Date(entry.createdAt).toLocaleString()}</small><small>进度 {taskProgress(entry)}% · 切图 {entry.elements.filter(element=>element.slice).length}</small></span>
        </button>)}</div>
        {session.loaded && !tasks.length && <p className="slicer-empty">还没有任务，上传图片开始切图。</p>}
      </section>
      <section className="slicer-task-detail" aria-label="任务详情">
        <header><div><h2>任务详情</h2>{task && <p>状态：<span className={`slicer-status ${task.status}`}>{TASK_STATUS[task.status]}</span>　进度：{percentage}%　创建时间：{new Date(task.createdAt).toLocaleString()}</p>}</div>
          {task && <div className="slicer-detail-actions">
            <button aria-label="删除切图任务" title="删除任务" disabled={busy || session.hasUnsaved} onClick={()=>setDeleting(task)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/></svg>
            </button>
            <button disabled={blocked || !source} onClick={()=>setEditorOpen(true)}>资源编辑</button>
            <button className="slicer-download" disabled={blocked || !hasExportable} onClick={()=>void onExportAtlas()}>下载图集</button>
            <details className="slicer-more-actions" data-dropdown-menu><summary aria-label="切图任务选项">···</summary><div>
              <button disabled={blocked || !hasExportable} onClick={()=>void onExportZip()}>下载素材 ZIP</button>
              <button disabled={blocked || !source} onClick={()=>void onAnalyze()}>重试切图</button>
            </div></details>
          </div>}
        </header>
        {task ? <>
          <div className="slicer-task-progress"><div><span>状态</span><span className={`slicer-status ${task.status}`}>{TASK_STATUS[task.status]}</span></div>
            <div><span>进度</span><span>{percentage}%</span></div><progress value={percentage} max={100}/>
          </div>
        </> : null}
        {preview}
      </section>
    </div>
    <button className="slicer-create-task" disabled={busy || !session.loaded || session.hasUnsaved} onClick={()=>fileRef.current?.click()}>{busy ? '正在处理…' : '上传图片并创建任务'}</button>
    <p className="slicer-upload-note">支持 PNG、JPG、WebP，单张最多 20 MB。建议上传清晰的 UI 截图。</p>
    <input ref={fileRef} className="file-input-hidden" type="file" accept="image/png,image/jpeg,image/webp" aria-label="上传切图图片" disabled={busy || !session.loaded || session.hasUnsaved} onChange={event=>{
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void onPick(file);
    }}/>
    {editorOpen && task && <StudioDialog fullScreen title="资源编辑器" locked={busy || session.hasUnsaved} onClose={()=>setEditorOpen(false)}
      actions={<button disabled={blocked || !hasExportable} onClick={()=>void onExportZip()}>下载素材 ZIP</button>}>
      <div className="assets-editor-page"><main className="col center"><div className="stage-content stage-assets">
        <AssetsStage screenName={task.name} version={sourceVersion} busy={blocked} onImport={()=>fileRef.current?.click()} panelProps={panelProps}/>
      </div></main></div>
    </StudioDialog>}
    {deleting && <StudioDialog title="删除切图任务" locked={busy} onClose={()=>setDeleting(null)}>
      <div className="retry-confirmation"><p>删除任务「{deleting.name}」及其任务记录？</p><div className="btn-row">
        <button disabled={busy} onClick={()=>setDeleting(null)}>取消</button><button className="danger" disabled={busy || session.hasUnsaved} onClick={()=>void onDelete()}>确认删除</button>
      </div></div>
    </StudioDialog>}
    <ToastQueue message={error || status}>
      {progress && <p role="status">{progress}</p>}
      {session.error && <p role="alert">{session.error}<button onClick={()=>void session.retrySave().catch(()=>undefined)} disabled={!session.hasUnsaved}>重试保存</button></p>}
      {session.hasUnsaved && <p role="status">正在保存素材修改…</p>}
    </ToastQueue>
  </main>;
}

function readFileAsDataUrl(file:File):Promise<string> {
  return new Promise((resolve,reject)=>{
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}
