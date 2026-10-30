import { useEffect, useRef, useState } from 'react';
import type { Project, Screen, ScreenVersion } from '../types';
import { renderWireframe } from '../lib/layout';
import { imageUrl } from '../lib/magpie';
import type { ProjectRenderTask } from '../lib/projectRenderTypes';
import { versionName } from '../lib/versions';
import { StudioDialog } from './StudioDialog';
import { ToastQueue } from './ToastQueue';

type Props = {
  project: Project;
  selectedScreenId: string | null;
  disabled: boolean;
  onSelect: (screenId: string) => void;
  onEdit: (screen: Screen, editor: 'layout' | 'assets' | 'refine') => void;
  onGenerate: (screen: Screen) => void;
  onVersion: (screen: Screen, versionId: string) => void;
  renderTasks: ProjectRenderTask[];
  onRemoveVersion: (projectId: string, screenId: string, versionId: string) => Promise<void>;
  onAddProject: () => void;
  onRename: (screen: Screen, name: string) => Promise<void>;
};

function DraftPreview({ project, screen }: { project: Project; screen: Screen }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!canvas.current) return;
    const scale = 600 / Math.max(project.size.w, project.size.h);
    const wire = renderWireframe(screen.layout, Math.round(project.size.w * scale), Math.round(project.size.h * scale));
    canvas.current.width = wire.width;
    canvas.current.height = wire.height;
    canvas.current.getContext('2d')?.drawImage(wire, 0, 0);
  }, [project.size.w, project.size.h, screen.layout]);
  return <canvas ref={canvas} aria-label={`${screen.name}草稿`} />;
}

export function currentScreenVersion(screen: Screen): ScreenVersion | undefined {
  return screen.versions.find((version) => version.id === screen.activeVersionId) ?? screen.versions.at(-1);
}

function previewStatus(version: ScreenVersion | undefined, task: ProjectRenderTask | undefined): string {
  if (!version) return '尚未生成';
  switch (task?.status) {
    case 'queued': return '等待生成结果';
    case 'running': return '正在生成结果';
    case 'interrupted': return '生成已中断';
    case 'failed': return '生成失败';
    case 'done': return '结果正在保存';
    case 'discarded': return '生成已停止';
    default: return '等待生成结果';
  }
}

function CardVersions({screen,version,disabled,onVersion}: {
  screen: Screen; version: ScreenVersion | undefined; disabled: boolean; onVersion: Props['onVersion'];
}) {
  const tabs = useRef<HTMLDivElement>(null);
  const index = screen.versions.findIndex(entry => entry.id === version?.id);
  const canCycle = screen.versions.length > 1;
  const previousIndex = index <= 0 ? screen.versions.length - 1 : index - 1;
  const nextIndex = index < 0 || index === screen.versions.length - 1 ? 0 : index + 1;
  const previous = canCycle ? screen.versions[previousIndex] : undefined;
  const next = canCycle ? screen.versions[nextIndex] : undefined;
  useEffect(() => {
    const list = tabs.current;
    const selected = list?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    if (!list || !selected) return;
    list.scrollLeft = selected.offsetLeft - (list.clientWidth - selected.offsetWidth) / 2;
  }, [version?.id]);

  return <div className="card-versions" aria-label={`${screen.name}结果版本`}>
    <button className="version-arrow" aria-label="上一个版本" title="上一个版本" disabled={disabled || !canCycle}
      onClick={() => { if (previous) onVersion(screen, previous.id); }}>‹</button>
    <div className="card-version-tabs" ref={tabs}>
      {screen.versions.map((entry, index) => <button key={entry.id} disabled={disabled}
        className={`ver-dot ${entry.id === version?.id ? 'active' : ''}`}
        aria-pressed={entry.id === version?.id} onClick={() => onVersion(screen, entry.id)}>{versionName(entry, index)}</button>)}
      {!screen.versions.length && <span>暂无版本</span>}
    </div>
    <button className="version-arrow" aria-label="下一个版本" title="下一个版本" disabled={disabled || !canCycle}
      onClick={() => { if (next) onVersion(screen, next.id); }}>›</button>
  </div>;
}

function EditableScreenTitle({screen,disabled,onRename,onError}: {
  screen: Screen; disabled: boolean; onRename: Props['onRename']; onError: (message:string)=>void;
}) {
  const [editing,setEditing] = useState(false);
  const [name,setName] = useState(screen.name);
  const [saving,setSaving] = useState(false);
  const pending = useRef(false);
  const cancelled = useRef(false);
  const originalName = useRef(screen.name);

  async function save() {
    if (pending.current || cancelled.current) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      onError('界面名称不能为空');
      return;
    }
    if (trimmedName === originalName.current) {
      setEditing(false);
      return;
    }
    pending.current = true;
    setSaving(true);
    try {
      await onRename(screen,trimmedName);
      setEditing(false);
    } catch (reason) { onError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      pending.current = false;
      setSaving(false);
    }
  }

  if (editing) return <input className="card-screen-name-input" aria-label="界面名称" value={name} maxLength={120}
    autoFocus onFocus={event=>event.currentTarget.select()} disabled={saving} onChange={event=>setName(event.target.value)}
    onBlur={()=>void save()} onKeyDown={event=>{
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter') {
        event.preventDefault();
        void save();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelled.current = true;
        setEditing(false);
      }
    }}/>;
  return <button className="card-screen-name" title="点击重命名" aria-label={`重命名界面：${screen.name}`} disabled={disabled} onClick={()=>{
    originalName.current=screen.name;
    cancelled.current=false;
    setName(screen.name);
    setEditing(true);
  }}>{screen.name}</button>;
}

export function ProjectOverview({ project, selectedScreenId, disabled, onSelect, onEdit, onGenerate, onVersion,
  renderTasks, onRemoveVersion, onAddProject, onRename }: Props) {
  const [notice,setNotice] = useState<string|null>(null);
  const [stoppingVersionId,setStoppingVersionId] = useState<string|null>(null);
  const [deletingVersionId,setDeletingVersionId] = useState<string|null>(null);
  const [pendingVersionDelete,setPendingVersionDelete] = useState<{screen:Screen;version:ScreenVersion}|null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [camera, setCamera] = useState({ x: 24, y: 24, zoom: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const drag = useRef<{ pointerId: number; x: number; y: number; cameraX: number; cameraY: number } | null>(null);
  useEffect(() => {
    const host = viewport.current;
    const card = document.getElementById(`overview-${selectedScreenId}`);
    if (!host || !card) return;
    const bounds = host.getBoundingClientRect();
    const target = card.getBoundingClientRect();
    if (target.right < bounds.left || target.left > bounds.right || target.bottom < bounds.top || target.top > bounds.bottom) {
      const current = cameraRef.current;
      setCamera({ ...current, x: host.clientWidth / 2 - (card.offsetLeft + card.offsetWidth / 2) * current.zoom,
        y: host.clientHeight / 2 - (card.offsetTop + card.offsetHeight / 2) * current.zoom });
    }
  }, [selectedScreenId]);
  useEffect(() => {
    const host = viewport.current;
    if (!host) return;
    const zoomAtPointer = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = host.getBoundingClientRect();
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;
      let delta = event.deltaY;
      if (event.deltaMode === 1) delta *= 16;
      else if (event.deltaMode === 2) delta *= host.clientHeight;
      setCamera(current => {
        const zoom = Math.max(0.15, Math.min(2.5, current.zoom * Math.exp(-delta * 0.0015)));
        const ratio = zoom / current.zoom;
        return { zoom, x: pointerX - (pointerX - current.x) * ratio, y: pointerY - (pointerY - current.y) * ratio };
      });
    };
    host.addEventListener('wheel', zoomAtPointer, { passive: false });
    return () => host.removeEventListener('wheel', zoomAtPointer);
  }, []);

  async function stopGeneration(screen: Screen, version: ScreenVersion) {
    if (disabled || stoppingVersionId || deletingVersionId) return;
    setStoppingVersionId(version.id);
    setNotice(null);
    try {
      await onRemoveVersion(project.id, screen.id, version.id);
      setNotice('已停止生成并移除未完成版本');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStoppingVersionId(null);
    }
  }

  async function confirmVersionDelete() {
    if (!pendingVersionDelete || disabled || deletingVersionId) return;
    const { screen, version } = pendingVersionDelete;
    setDeletingVersionId(version.id);
    setNotice(null);
    try {
      await onRemoveVersion(project.id, screen.id, version.id);
      setPendingVersionDelete(null);
      setNotice('版本已删除');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDeletingVersionId(null);
    }
  }

  const pendingVersionIndex = pendingVersionDelete
    ? pendingVersionDelete.screen.versions.findIndex((version) => version.id === pendingVersionDelete.version.id)
    : -1;
  const pendingVersionName = pendingVersionDelete
    ? versionName(pendingVersionDelete.version, pendingVersionIndex)
    : '';
  const pendingRenderTask = pendingVersionDelete
    ? renderTasks.find((task) => task.id === pendingVersionDelete.version.id &&
      task.projectId === project.id && task.screenId === pendingVersionDelete.screen.id)
    : undefined;
  const pendingHasRenderTask = !!pendingRenderTask &&
    !['acknowledged', 'discarded'].includes(pendingRenderTask.status);

  return <main className="project-overview" aria-label="项目总览">
    <button className="primary canvas-create-project" disabled={disabled} onClick={onAddProject}>＋ 新建项目</button>
    <button className="canvas-reset-view" aria-label="重置画布视图" title="重置缩放与位置"
      onClick={() => setCamera({ x: 24, y: 24, zoom: 1 })}>{Math.round(camera.zoom * 100)}%</button>
    <div className="overview-scroll infinite-viewport" ref={viewport} aria-label="无限画布"
      style={{ backgroundSize: `${64 * camera.zoom}px ${64 * camera.zoom}px`, backgroundPosition: `${camera.x}px ${camera.y}px` }}
      onPointerDown={event => {
        if (event.button !== 0 && event.button !== 1) return;
        if (event.button === 0 && (event.target as HTMLElement).closest('.screen-card')) return;
        event.preventDefault();
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, cameraX: camera.x, cameraY: camera.y };
        event.currentTarget.setPointerCapture(event.pointerId);
      }} onPointerMove={event => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        setCamera(current => ({ ...current, x: start.cameraX + event.clientX - start.x, y: start.cameraY + event.clientY - start.y }));
      }} onPointerUp={event => {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <div className="screen-cards canvas-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`,
        '--preview-height': `${Math.min(460, Math.max(170, 226 * project.size.h / project.size.w))}px` } as React.CSSProperties}>
        {project.screens.map((screen) => {
          const version = currentScreenVersion(screen);
          const versionIndex = version ? screen.versions.findIndex((entry) => entry.id === version.id) : -1;
          const selectedVersionName = version ? versionName(version, versionIndex) : '';
          const renderTask = version
            ? renderTasks.find((task) => task.id === version.id && task.projectId === project.id && task.screenId === screen.id)
            : undefined;
          const isGenerating = renderTask?.status === 'queued' || renderTask?.status === 'running';
          const renderFailureReason = renderTask?.error &&
            (renderTask.status === 'failed' || renderTask.status === 'interrupted')
            ? renderTask.error
            : undefined;
          let generateButtonLabel = '生成界面';
          if (isGenerating) generateButtonLabel = '生成中…';
          else if (version) generateButtonLabel = '重新生成';
          return <article key={screen.id} id={`overview-${screen.id}`} data-screen-id={screen.id}
            className={`screen-card ${screen.id === selectedScreenId ? 'is-selected' : ''}`}
            onPointerDown={event => { if (event.button === 0) onSelect(screen.id); }}>
            <header className="screen-card-heading"><h2><i /><EditableScreenTitle screen={screen} disabled={disabled} onRename={onRename} onError={setNotice}/><small>界面</small></h2>
            </header>
            <div className="screen-card-pair">
              <div className="screen-preview"><span className="preview-label">布局</span>
                <div className="screen-preview-frame">
                  <DraftPreview project={project} screen={screen} />
                  <div className="preview-hover-actions"><button disabled={disabled} onClick={() => onEdit(screen, 'layout')}>编辑布局</button></div>
                </div>
              </div>
              <div className="screen-preview"><span className="preview-label">结果图</span>
                <div className="screen-preview-frame">
                  {version?.image
                    ? <img src={imageUrl(version.image)} alt={`${screen.name}生成图`} />
                    : <div className="preview-placeholder">
                      <span>{previewStatus(version, renderTask)}</span>
                      {version && isGenerating && <button type="button" className="preview-stop-generation"
                        disabled={disabled || stoppingVersionId === version.id || deletingVersionId === version.id}
                        onClick={() => void stopGeneration(screen, version)}>
                        {stoppingVersionId === version.id ? '停止中…' : '停止生成'}
                      </button>}
                    </div>}
                  {version && <button type="button" className="version-delete-button"
                    aria-label={`删除版本：${selectedVersionName}`} title="删除当前版本"
                    disabled={disabled || stoppingVersionId === version.id || deletingVersionId === version.id}
                    onClick={() => setPendingVersionDelete({ screen, version })}>×</button>}
                  {renderFailureReason && <p className="preview-failure-reason" role="alert" aria-label="生成失败原因">
                    <strong>失败原因：</strong>{renderFailureReason}
                  </p>}
                  {version?.image && !isGenerating && <div className="preview-hover-actions">
                    <button disabled={disabled} onClick={() => onEdit(screen, 'refine')}>微调结果</button>
                    <button disabled={disabled} onClick={() => onEdit(screen, 'assets')}>编辑资源</button>
                  </div>}
                </div>
              </div>
            </div>
            <footer className="screen-card-footer">
              <CardVersions screen={screen} version={version} disabled={disabled} onVersion={onVersion} />
              <button className="primary" disabled={disabled || isGenerating} onClick={() => onGenerate(screen)}>
                ✧　{generateButtonLabel}
              </button>
            </footer>
          </article>;
        })}
      </div>
    </div>
    <ToastQueue message={notice}>{null}</ToastQueue>
    {pendingVersionDelete && <StudioDialog title="删除版本" locked={disabled || !!deletingVersionId}
      onClose={() => { if (!deletingVersionId) setPendingVersionDelete(null); }}>
      <div className="retry-confirmation">
        <p>确认删除「{pendingVersionDelete.screen.name}」的 {pendingVersionName}？其他版本不会受到影响。</p>
        {pendingHasRenderTask && <p className="muted">该版本关联的生成任务会停止，已提交的远端请求可能仍会计费。</p>}
        <div className="btn-row">
          <button disabled={disabled || !!deletingVersionId} onClick={() => setPendingVersionDelete(null)}>取消</button>
          <button className="danger" disabled={disabled || !!deletingVersionId}
            onClick={() => void confirmVersionDelete()}>
            {deletingVersionId ? '删除中…' : '确认删除'}
          </button>
        </div>
      </div>
    </StudioDialog>}
  </main>;
}
