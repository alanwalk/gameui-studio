import type { Project, Screen } from '../types';
import { useRef, useState } from 'react';
import { imageUrl } from '../lib/magpie';
import { StudioDialog } from './StudioDialog';
import { ToastQueue } from './ToastQueue';

type Props = {
  projects: Project[];
  activeProjectId: string | null;
  activeScreenId: string | null;
  onSelectProject: (id: string) => void;
  onSelectScreen: (id: string) => void;
  onAddScreen: () => void;
  onDeleteProject: (id: string) => void;
  onDeleteScreen: (id: string) => Promise<void>;
  onRenameScreen: (projectId:string,screenId:string,name:string) => Promise<void>;
  onCopyProject?: (projectId: string) => void;
  onCopyScreen?: (projectId: string, screenId: string) => void;
  busy?: boolean;
};

/** The thumbnail a screen shows: its newest generated version, if it has one. */
function screenThumb(screen: Screen): string | null {
  const withImage = screen.versions.filter((v) => v.image);
  if (withImage.length === 0) return null;
  const active = withImage.find((v) => v.id === screen.activeVersionId) ?? withImage[withImage.length - 1];
  return active?.image ? imageUrl(active.image) : null;
}

export function ProjectSidebar({
  projects,
  activeProjectId,
  activeScreenId,
  onSelectProject,
  onSelectScreen,
  onAddScreen,
  onDeleteProject,
  onDeleteScreen,
  onRenameScreen,
  onCopyProject,
  onCopyScreen,
  busy = false,
}: Props) {
  const [pendingDelete, setPendingDelete] = useState<{projectId:string;screen:Screen} | null>(null);
  const [pendingRename, setPendingRename] = useState<{projectId:string;screen:Screen} | null>(null);
  const [name,setName] = useState('');
  const [renaming,setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleteInFlight = useRef(false);
  const renameInFlight = useRef(false);
  async function confirmRename() {
    if (!pendingRename || busy || renameInFlight.current) return;
    renameInFlight.current = true;
    setRenaming(true);
    try {
      await onRenameScreen(pendingRename.projectId,pendingRename.screen.id,name);
      setPendingRename(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally {
      renameInFlight.current = false;
      setRenaming(false);
    }
  }
  async function confirmDelete() {
    if (!pendingDelete || busy || deleteInFlight.current) return;
    if (pendingDelete.projectId !== activeProjectId) {
      setError('项目已切换，请重新选择要删除的界面。');
      return;
    }
    deleteInFlight.current = true;
    setDeleting(true);
    try {
      await onDeleteScreen(pendingDelete.screen.id);
      setPendingDelete(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      deleteInFlight.current = false;
      setDeleting(false);
    }
  }
  const visibleProjects = projects.filter(project => project.id === activeProjectId);
  return (
    <aside className="sidebar">
      <button className="primary sidebar-add-screen" disabled={busy} onClick={onAddScreen}>＋ 添加节点</button>

      <div className="sidebar-body">
        {projects.length === 0 && (
          <p className="empty">
            还没有项目。
            <br />
            点击工作区的「新建项目」开始，
            <br />
            一个项目是一套统一风格的界面。
          </p>
        )}

        {visibleProjects.map((project) => {
          const open = project.id === activeProjectId;
          return (
            <section key={project.id} className={`proj ${open ? 'open' : ''}`}>
              <div className="proj-head">
                <button
                  className="proj-name"
                  onClick={() => onSelectProject(project.id)}
                  title={project.name}
                >
                  <span className="proj-dot" />
                  {project.name}
                </button>
                <span className="proj-count">{project.screens.length}</span>
                {onCopyProject && (
                  <button
                    className="tiny ghost"
                    onClick={() => onCopyProject(project.id)}
                    disabled={busy}
                    aria-label={`复制项目：${project.name}`}
                    title={`复制项目：${project.name}`}
                  >
                    复制
                  </button>
                )}
                <button
                  className="tiny ghost"
                  onClick={() => onDeleteProject(project.id)}
                  title="删除项目"
                >
                  ×
                </button>
              </div>

              {open && (
                <div className="screen-list">
                  {project.screens.map((screen) => {
                    const thumb = screenThumb(screen);
                    return (
                      <div
                        key={screen.id}
                        className={`screen-row ${screen.id === activeScreenId ? 'active' : ''}`}
                      >
                        <button
                          className="screen-pick"
                          onClick={() => onSelectScreen(screen.id)}
                          title={screen.name}
                        >
                          {thumb ? (
                            <img src={thumb} alt="" className="screen-thumb" />
                          ) : (
                            <span className="screen-thumb blank" />
                          )}
                          <span className="screen-meta">
                            <span className="screen-name">{screen.name}</span>
                            <span className="screen-ver">
                              {screen.versions.length === 0
                                ? '未生成'
                                : `${screen.versions.length} 个版本`}
                            </span>
                          </span>
                        </button>
                        <details className="home-item-menu screen-actions-menu" data-dropdown-menu><summary aria-label={`界面操作：${screen.name}`}>···</summary><div>
                          {onCopyScreen && <button disabled={busy} aria-label={`复制界面：${screen.name}`} title={`复制界面：${screen.name}`} onClick={event=>{
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            onCopyScreen(project.id,screen.id);
                          }}>复制界面</button>}
                          <button disabled={busy} onClick={event=>{
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            setError(null);
                            setName(screen.name);
                            setPendingRename({projectId:project.id,screen});
                          }}>重命名</button>
                          <button disabled={busy || project.screens.length <= 1} title={project.screens.length <= 1 ? '至少保留一个界面' : '删除界面'}
                            aria-label={`删除界面：${screen.name}`} onClick={event=>{
                              event.currentTarget.closest('details')?.removeAttribute('open');
                              setError(null);
                              setPendingDelete({projectId:project.id,screen});
                            }}>删除界面</button>
                        </div></details>
                      </div>
                    );
                  })}

                </div>
              )}
            </section>
          );
        })}
      </div>
      {pendingDelete && <StudioDialog title="删除界面" locked={busy || deleting} onClose={() => setPendingDelete(null)}>
        <div className="retry-confirmation"><p>确认删除界面「{pendingDelete.screen.name}」及其版本记录？</p>
          <div className="btn-row"><button disabled={busy || deleting} onClick={() => setPendingDelete(null)}>取消</button>
            <button className="danger" disabled={busy || deleting} onClick={() => void confirmDelete()}>{deleting ? '删除中…' : '确认删除'}</button></div>
        </div>
      </StudioDialog>}
      {pendingRename && <StudioDialog title="重命名界面" locked={busy || renaming} onClose={()=>setPendingRename(null)}>
        <form className="retry-confirmation rename-form" onSubmit={event=>{event.preventDefault();void confirmRename();}}>
          <label htmlFor="screen-rename-name">界面名称</label><input id="screen-rename-name" value={name} maxLength={120} autoFocus
            onFocus={event=>event.currentTarget.select()} disabled={busy || renaming} onChange={event=>setName(event.target.value)}/>
          <div className="btn-row"><button type="button" disabled={busy || renaming} onClick={()=>setPendingRename(null)}>取消</button>
            <button type="submit" className="primary" disabled={busy || renaming || !name.trim()}>{renaming ? '保存中…' : '保存名称'}</button></div>
        </form>
      </StudioDialog>}
      <ToastQueue message={error}>{null}</ToastQueue>
    </aside>
  );
}
