import { useRef, useState } from 'react';
import type { Project, Style } from '../types';
import { imageUrl } from '../lib/magpie';
import { StyleGenerator } from './StyleGenerator';
import { StudioDialog } from './StudioDialog';
import { ToastQueue } from './ToastQueue';
import { StyleDetails } from './StyleDetails';
import { StyleLibrary } from './StyleLibrary';

type Props = {
  projects: Project[];
  styles: Style[];
  busy: boolean;
  visionModel: string;
  onBusyChange: (busy: boolean) => void;
  onCreateStyle: (style: Style) => Promise<void>;
  onDeleteStyle: (id: string) => Promise<void>;
  onOpenProject: (id: string) => void;
  onAddProject: () => void;
  onCopyProject: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onRenameProject: (id:string,name:string) => Promise<void>;
  onOpenSlicer: () => void;
  onOpenDrawing: () => void;
};

export function HomePage(props: Props) {
  const [tab, setTab] = useState<'projects' | 'styles'>('projects');
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(null);
  const [editingSelectedStyle, setEditingSelectedStyle] = useState(false);
  const [deletingStyle, setDeletingStyle] = useState<Style | null>(null);
  const [pendingRename,setPendingRename] = useState<{kind:'project'|'style';id:string}|null>(null);
  const [name,setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const styleActionPending = useRef(false);
  const renameInFlight = useRef(false);

  async function confirmRename() {
    if (!pendingRename || props.busy || renameInFlight.current) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNotice('名称不能为空');
      return;
    }
    renameInFlight.current = true;
    props.onBusyChange(true);
    setNotice(null);
    try {
      if (pendingRename.kind === 'project') {
        await props.onRenameProject(pendingRename.id,trimmedName);
      } else {
        const style = props.styles.find(entry=>entry.id===pendingRename.id);
        if (!style) throw new Error('要重命名的画风不存在');
        await props.onCreateStyle({...style,name:trimmedName,updatedAt:Date.now()});
      }
      setPendingRename(null);
      setNotice('名称已保存');
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      renameInFlight.current = false;
      props.onBusyChange(false);
    }
  }

  async function changeStyle(style: Style, action: 'copy' | 'delete') {
    if (props.busy || styleActionPending.current) return;
    styleActionPending.current = true;
    props.onBusyChange(true);
    try {
      if (action === 'copy') {
        const now = Date.now();
        const copy: Style = {...structuredClone(style), id: `style-${crypto.randomUUID()}`, name: `${style.name} 副本`, createdAt: now, updatedAt: now};
        await props.onCreateStyle(copy);
        setNotice(`已复制画风「${style.name}」`);
      } else {
        await props.onDeleteStyle(style.id);
        setDeletingStyle(null);
        setNotice(`已删除画风「${style.name}」`);
      }
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      styleActionPending.current = false;
      props.onBusyChange(false);
    }
  }
  const selectedStyle = props.styles.find(style => style.id === selectedStyleId);
  if (selectedStyle && editingSelectedStyle) return <StyleLibrary key={selectedStyle.id} styles={props.styles}
    initialEditingId={selectedStyle.id} onEditorClose={() => setEditingSelectedStyle(false)} busy={props.busy}
    onBusyChange={props.onBusyChange} onCreate={props.onCreateStyle} onDelete={props.onDeleteStyle} />;
  if (selectedStyle) return <StyleDetails key={selectedStyle.id} style={selectedStyle} busy={props.busy}
    onEdit={() => setEditingSelectedStyle(true)} onBack={() => setSelectedStyleId(null)} />;

  return <main className="home-page" aria-label="首页">
    <aside className="home-sidebar">
      <div className="home-sidebar-tabs" role="tablist" aria-label="我的内容">
        <button role="tab" aria-selected={tab === 'projects'} onClick={() => setTab('projects')}>我的项目</button>
        <button role="tab" aria-selected={tab === 'styles'} onClick={() => setTab('styles')}>我的画风</button>
      </div>
      <div className="home-item-list">
        {tab === 'projects' && props.projects.map(project => {
          const cover = project.screens.flatMap(screen => screen.versions).reverse().find(version => version.image)?.image;
          return <div className="home-project-row" key={project.id}>
            <button className="home-project-open" onClick={() => props.onOpenProject(project.id)} title={project.name}>
              {cover ? <img src={imageUrl(cover)} alt="" /> : <span className="home-item-placeholder">▧</span>}
              <span><strong>{project.name}</strong><small>{project.screens.length} 个界面</small></span>
            </button>
            <details className="home-item-menu" data-dropdown-menu><summary aria-label={`项目操作：${project.name}`}>···</summary>
              <div><button disabled={props.busy} onClick={event=>{
                event.currentTarget.closest('details')?.removeAttribute('open');
                props.onCopyProject(project.id);
              }}>复制项目</button>
                <button disabled={props.busy} onClick={event=>{
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  setName(project.name);
                  setPendingRename({kind:'project',id:project.id});
                }}>重命名</button>
                <button disabled={props.busy} onClick={event=>{
                  event.currentTarget.closest('details')?.removeAttribute('open');
                  props.onDeleteProject(project.id);
                }}>删除项目</button></div>
            </details>
          </div>;
        })}
        {tab === 'projects' && props.projects.length === 0 && <p className="home-empty">还没有项目</p>}
        {tab === 'styles' && props.styles.map(style => <div className="home-project-row" key={style.id}>
          <button className="home-style-open" onClick={() => setSelectedStyleId(style.id)} title={style.name}>
          {style.image ? <img src={imageUrl(style.image)} alt="" /> : <span className="home-item-placeholder">✧</span>}
          <span>{style.name}</span>
          </button>
          <details className="home-item-menu" data-dropdown-menu><summary aria-label={`画风操作：${style.name}`}>···</summary>
            <div><button disabled={props.busy} onClick={event => {
              event.currentTarget.closest('details')?.removeAttribute('open');
              void changeStyle(style, 'copy');
            }}>复制画风</button>
              <button disabled={props.busy} onClick={event=>{
                event.currentTarget.closest('details')?.removeAttribute('open');
                setName(style.name);
                setPendingRename({kind:'style',id:style.id});
              }}>重命名</button>
              <button disabled={props.busy} onClick={event => {
                event.currentTarget.closest('details')?.removeAttribute('open');
                setDeletingStyle(style);
              }}>删除画风</button></div>
          </details>
        </div>)}
      </div>
      <nav className="home-shortcuts" aria-label="便捷功能"><span>便捷功能</span>
        <button onClick={props.onOpenSlicer}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 3v14a3 3 0 0 0 3 3h14M2 7h15a2 2 0 0 1 2 2v13M8 3v13h13" /></svg><span>切图工具</span></button>
        <button onClick={props.onOpenDrawing}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14zM4 14l5 5" /></svg><span>画图工具</span></button>
      </nav>
    </aside>
    <section className="home-creation">
      <button className="home-new-project" disabled={props.busy} onClick={props.onAddProject}>＋ 新建项目</button>
      <div className="home-hero">
        <span className="home-eyebrow">● 锁定你的风格</span>
        <p>详细描述你想制作的游戏类型、题材、色调、画风与目标人群，AI 将为你创建可复用的风格。<br />锁定风格，让整套 UI 资源在同一美学下产出。</p>
        <StyleGenerator home visionModel={props.visionModel} busy={props.busy} onBusyChange={props.onBusyChange} onCreate={props.onCreateStyle} />
      </div>
    </section>
    {deletingStyle && <StudioDialog title="删除画风" locked={props.busy} onClose={() => setDeletingStyle(null)}>
      <div className="retry-confirmation"><p>删除画风「{deletingStyle.name}」？已应用它的项目和版本不受影响。</p>
        <div className="btn-row"><button disabled={props.busy} onClick={() => setDeletingStyle(null)}>取消</button>
          <button className="danger" disabled={props.busy} onClick={() => void changeStyle(deletingStyle, 'delete')}>确认删除</button></div>
      </div>
    </StudioDialog>}
    {pendingRename && <StudioDialog title={pendingRename.kind === 'project' ? '重命名项目' : '重命名画风'} locked={props.busy} onClose={()=>setPendingRename(null)}>
      <form className="retry-confirmation rename-form" onSubmit={event=>{event.preventDefault();void confirmRename();}}>
        <label htmlFor="home-rename-name">{pendingRename.kind === 'project' ? '项目名称' : '画风名称'}</label>
        <input id="home-rename-name" value={name} maxLength={120} autoFocus onFocus={event=>event.currentTarget.select()}
          disabled={props.busy} onChange={event=>setName(event.target.value)}/>
        <div className="btn-row"><button type="button" disabled={props.busy} onClick={()=>setPendingRename(null)}>取消</button>
          <button type="submit" className="primary" disabled={props.busy || !name.trim()}>{props.busy ? '保存中…' : '保存名称'}</button></div>
      </form>
    </StudioDialog>}
    <ToastQueue message={notice}>{null}</ToastQueue>
  </main>;
}
