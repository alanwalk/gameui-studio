import { AddLayoutNode } from './components/AddLayoutNode';
import { normalizeHierarchy, descendantIds, transformLayoutGroup } from './lib/layoutStructure';
import { LayoutTree } from './components/LayoutTree';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtractionMethod } from './components/ExtractionSelector';
import { AssetsStage } from './components/AssetsStage';
import { ToastQueue } from './components/ToastQueue';
import { ResolutionForm } from './components/ResolutionForm';
import { ProjectOverview } from './components/ProjectOverview';
import { ProjectStyleGallery } from './components/ProjectStyleGallery';
import { StudioDialog } from './components/StudioDialog';
import { RefineDialog } from './components/RefineDialog';
import './components/studio-overview.css';
import { LayoutStagePanel } from './components/LayoutStagePanel';
import { GenerationStagePanel } from './components/GenerationStagePanel';
import { GenerationResults } from './components/GenerationResults';
import { PageExportPanel } from './components/PageExportPanel';
import { appendVersion, deleteVersion, updateVersionScreen } from './lib/versions';
import { type StudioStage } from './components/StudioStages';
import { SettingsPage } from './components/SettingsPage';
import { LayoutHistory } from './lib/layoutHistory';
import { LayoutEditor } from './components/LayoutEditor';
import { HomePage } from './components/HomePage';
import { ProjectSidebar } from './components/ProjectSidebar';
import { SlicerTool } from './components/SlicerTool';
import { copyProject, copyScreen } from './lib/projectCopy';
import { ackProjectRender, applyProjectRender, cancelProjectRender, discardProjectRender, listProjectRenders, reserveProjectRender, resumeProjectRender, retryProjectRender, submitProjectRender } from './lib/projectRender';
import { sliceAlphaSheet } from './lib/alphaSheet';
import type { ProjectRenderInput, ProjectRenderTask } from './lib/projectRenderTypes';
import { loadImageElement } from './lib/image';
import { DrawingTool } from './components/DrawingTool';
import { StyleLibrary } from './components/StyleLibrary';
import {
  newProject,
  newScreen,
  newNode,
  renderWireframe,
  buildGenerationPrompt,
} from './lib/layout';
import {
  fetchHealth,
  fetchModels,
  fetchProjects,
  fetchStyles,
  imageUrl,
  planLayout,
  removeProject,
  removeStyle,
  saveProject,
  saveStyle,
  type MagpieHealth,
} from './lib/magpie';
import { buildZip, downloadBlob } from './lib/export';
import { findMatchingStyle } from './lib/styles';
import type { SliceTaskSource } from './types';
import { extractSliceTask, newSliceTask, repaintTask, useSliceTasks } from './lib/sliceTasks';
import type { LayoutKind, LayoutNode, Project, Screen, ScreenVersion, Settings, Style } from './types';
import { createUuid } from './lib/uuid';

const DEFAULT_SETTINGS: Settings = {
  visionModel: 'codex/gpt-6.1-terra',
  imageModel: '',
  module: 'Common',
  tolerance: 12,
  softness: 8,
  hardEdge: false,
  fringeFix: true,
  includeTextAsImage: false,
};

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [renderTasks, setRenderTasks] = useState<ProjectRenderTask[]>([]);
  const [styles, setStyles] = useState<Style[]>([]);
  const [styleReferenceImage, setStyleReferenceImage] = useState<string>();
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeScreenId, setActiveScreenId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const [health, setHealth] = useState<MagpieHealth | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const [toolBusy, setBusy] = useState(false);
  const [versionBusy, setVersionBusy] = useState(false);
  const busy = toolBusy || versionBusy;
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryRequest, setRetryRequest] = useState<{task: ProjectRenderTask; versionId: string} | null>(null);
  const retryInFlight = useRef(false);
  const [dismissedRenderNotices, setDismissedRenderNotices] = useState<Set<string>>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem('gameui-dismissed-render-notices') ?? '[]');
      if (Array.isArray(saved)) return new Set(saved.filter((entry): entry is string => typeof entry === 'string'));
    } catch { /* Dismissing still works when browser storage is unavailable. */ }
    return new Set();
  });
  useEffect(() => {
    try { sessionStorage.setItem('gameui-dismissed-render-notices', JSON.stringify([...dismissedRenderNotices])); }
    catch { /* The current session can still dismiss notifications. */ }
  }, [dismissedRenderNotices]);
  const dismissRenderNotice = (task: ProjectRenderTask) => {
    setDismissedRenderNotices(current => new Set([...current, renderNoticeKey(task)]));
  };
  const [standaloneSource, setStandaloneSource] = useState<SliceTaskSource | null>(null);
  const [sliceProgress, setSliceProgress] = useState<string | null>(null);
  /** 'studio' is the wireframe -> art flow; the other views are independent tools. */
  const [view, setView] = useState<'home' | 'studio' | 'slicer' | 'drawing' | 'styles' | 'settings'>('home');
  const [homeVisit, setHomeVisit] = useState(0);

  const extractionMethod: ExtractionMethod = 'segmentation';
  const [stage, setStage] = useState<StudioStage>('layout');
  const [editorOpen, setEditorOpen] = useState(false);
  const [layoutDraft, setLayoutDraft] = useState<{projectId:string;screen:Screen} | null>(null);
  const layoutDraftRef = useRef(layoutDraft);
  const [layoutSaving,setLayoutSaving] = useState(false);
  const publishLayoutDraft = useCallback((draft: typeof layoutDraft) => {
    layoutDraftRef.current = draft;
    setLayoutDraft(draft);
  }, []);
  const [floatingPanel, setFloatingPanel] = useState<'refine' | 'project' | 'export' | null>(null);
  const [refineSource, setRefineSource] = useState<ScreenVersion | null>(null);
  const [operation, setOperation] = useState('');
  const projectsRef = useRef<Project[]>([]);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const unsavedProjects = useRef(new Map<string, Project>());
  const [pendingSaves, setPendingSaves] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const history = useRef(new LayoutHistory());
  const [, refreshHistory] = useState(0);
  const runAction = (action: Promise<unknown>) => {
    void action.catch((reason) => setError(String(reason)));
  };

  const styleInputRef = useRef<HTMLInputElement>(null);
  const versionInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const closeOutsideMenus = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const menus = document.querySelectorAll<HTMLDetailsElement>('details[data-dropdown-menu][open]');
      for (const menu of menus) {
        if (!menu.contains(event.target)) menu.open = false;
      }
    };
    const closeMenusOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      const menus = document.querySelectorAll<HTMLDetailsElement>('details[data-dropdown-menu][open]');
      if (!menus.length) return;
      event.preventDefault();
      event.stopPropagation();
      for (const menu of menus) {
        const restoreFocus = menu.contains(document.activeElement);
        menu.open = false;
        if (restoreFocus) menu.querySelector('summary')?.focus();
      }
    };
    // Capture also reaches menus inside dialog portals and canvases that stop bubbling.
    document.addEventListener('pointerdown', closeOutsideMenus, true);
    document.addEventListener('keydown', closeMenusOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutsideMenus, true);
      document.removeEventListener('keydown', closeMenusOnEscape, true);
    };
  }, []);

  useEffect(() => {
    void fetchHealth()
      .then((result) => {
        setHealth(result);
      })
      .catch(() => setHealth(null));

    void fetchModels()
      .then(setModels)
      .catch(() => setModels([]));

    void fetchProjects()
      .then((loaded) => {
        const normalized = loaded.map(project => ({...project, screens: project.screens.map(screen => ({...screen, layout: normalizeHierarchy(screen.layout)}))}));
        projectsRef.current = normalized;
        setProjects(normalized);
        setProjectsLoaded(true);
        if (loaded.length > 0) {
          setActiveProjectId(loaded[0]?.id ?? null);
          setActiveScreenId(loaded[0]?.screens[0]?.id ?? null);
        }
      })
      .catch((reason) => setError(`加载项目失败：${String(reason)}`));

    void fetchStyles()
      .then(setStyles)
      .catch(() => setStyles([]));
  }, []);



  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const activeScreen = useMemo(
    () => {
      if (layoutDraft?.projectId === activeProjectId && layoutDraft.screen.id === activeScreenId) return layoutDraft.screen;
      return activeProject?.screens.find((s) => s.id === activeScreenId) ?? null;
    },
    [activeProject, activeScreenId, activeProjectId, layoutDraft],
  );

  const selectedNode = useMemo(
    () => activeScreen?.layout.find((n) => n.id === selectedNodeId) ?? null,
    [activeScreen, selectedNodeId],
  );

  const activeVersion = useMemo(() => {
    if (!activeScreen || activeScreen.versions.length === 0) return null;
    const found = activeScreen.versions.find((v) => v.id === activeScreen.activeVersionId);
    return found ?? activeScreen.versions[activeScreen.versions.length - 1] ?? null;
  }, [activeScreen]);

  const projectSource: SliceTaskSource | null = activeProject && activeScreen && activeVersion?.image ? {
    kind: 'project', projectId: activeProject.id, screenId: activeScreen.id,
    versionId: activeVersion.id, sourceImage: activeVersion.image,
  } : null;
  const assetSettings = { ...settings, ...activeScreen?.assetSettings };
  const sliceSession = useSliceTasks(projectSource);
  const standaloneSession = useSliceTasks(standaloneSource);
  const sliceElements = sliceSession.elements;
  const sliceSource = sliceSession.source;
  const sliceRestoring = !sliceSession.loaded || (!!sliceSession.task && (!sliceSource || sliceElements === null));

  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      if (!unsavedProjects.current.size && !sliceSession.hasUnsaved && !standaloneSession.hasUnsaved && !layoutDraftRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [sliceSession.hasUnsaved, standaloneSession.hasUnsaved]);


  const appliedStyleId = useMemo(() => {
    if (!activeProject) return '';
    const matched = findMatchingStyle(styles, activeProject.stylePrompt, activeProject.styleImage);
    return matched?.id ?? '';
  }, [styles, activeProject]);

  // The server returns the whole list. Never replace newer optimistic edits with that response.
  const commit = useCallback((next: Project): Promise<Project[]> => {
    setStatus(null);
    const current = projectsRef.current;
    const exists = current.some((project) => project.id === next.id);
    let updated = current.map((project) => project.id === next.id ? next : project);
    if (!exists) updated = [...current, next];
    projectsRef.current = updated;
    setProjects(updated);
    unsavedProjects.current.set(next.id, next);
    setPendingSaves((count) => count + 1);
    const saving = saveQueue.current.then(() => saveProject(next));
    saveQueue.current = saving.catch(() => undefined);
    return saving.then(() => {
      if (unsavedProjects.current.get(next.id) === next) unsavedProjects.current.delete(next.id);
      if (!unsavedProjects.current.size) setSaveError(null);
      return projectsRef.current;
    }).catch((reason) => {
      setSaveError(`项目「${next.name}」保存失败，本地修改保留，请重试：${String(reason)}`);
      throw reason;
    }).finally(() => setPendingSaves((count) => count - 1));
  }, []);

  useEffect(() => {
    if (!projectsLoaded) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const recover = async () => {
      try {
        const tasks = await listProjectRenders();
        if (cancelled) return;
        setRenderTasks(tasks);
        for (const task of tasks) {
          if (cancelled || task.status !== 'done') continue;
          await saveQueue.current;
          if (cancelled) return;
          const project = projectsRef.current.find((entry) => entry.id === task.projectId);
          // Failed optimistic saves must be retried explicitly through the existing save UI.
          if (unsavedProjects.current.has(task.projectId)) continue;
          const next = applyProjectRender(project, task);
          if (next) await commit(next);
          if (cancelled) return;
          const latest = projectsRef.current.find((entry) => entry.id === task.projectId);
          const version = latest?.screens.find((entry) => entry.id === task.screenId)?.versions.find((entry) => entry.id === task.id);
          if (version?.image === task.result) {
            await saveQueue.current;
            if (unsavedProjects.current.has(task.projectId)) continue;
            await ackProjectRender(task.id);
            setStatus('生成结果已保存，刷新后也可继续查看。');
          } else await discardProjectRender(task.id);
        }
      } catch (reason) {
        if (!cancelled) setError(`恢复生成任务失败：${String(reason)}`);
      } finally {
        if (!cancelled) timer = setTimeout(() => { void recover(); }, 1000);
      }
    };
    void recover();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [projectsLoaded, commit]);

  const patchProject = useCallback(async (patch: Partial<Project>) => {
    const project = projectsRef.current.find((entry) => entry.id === activeProjectId);
    if (project) await commit({ ...project, ...patch });
  }, [activeProjectId, commit]);

  const patchScreen = useCallback(async (patch: Partial<Screen>, recordHistory = true) => {
    const project = projectsRef.current.find((entry) => entry.id === activeProjectId);
    const draft = layoutDraftRef.current;
    const editing = draft?.projectId === activeProjectId && draft.screen.id === activeScreenId;
    const screen = editing ? draft.screen : project?.screens.find((entry) => entry.id === activeScreenId);
    if (!project || !screen) return;
    if (patch.layout) patch = {...patch, layout: normalizeHierarchy(patch.layout)};
    if (patch.layout && recordHistory) {
      history.current.record(`${project.id}/${screen.id}`, screen.layout, patch.layout);
      refreshHistory((value) => value + 1);
    }
    if (editing) {
      publishLayoutDraft({projectId:project.id,screen:{...screen,...patch}});
      return;
    }
    const screens = project.screens.map((entry) => entry.id === screen.id ? { ...entry, ...patch } : entry);
    await commit({ ...project, screens });
  }, [activeProjectId, activeScreenId, commit, publishLayoutDraft]);

  const onChangeLayout = useCallback(async (nodes: LayoutNode[]) => {
    await patchScreen({ layout: nodes });
  }, [patchScreen]);

  const moveHistory = (direction: 'undo' | 'redo') => {
    if (!activeProject || !activeScreen) return;
    const layout = history.current[direction](`${activeProject.id}/${activeScreen.id}`);
    if (layout) runAction(patchScreen({ layout }, false));
    refreshHistory((value) => value + 1);
  };
  const historyState = history.current.state(`${activeProjectId}/${activeScreenId}`);

  const onAddProject = useCallback(async () => {
      if (busy || sliceSession.hasUnsaved) {
        setError('请先完成处理并保存素材修改。');
        return;
      }
    setStatus(null);
    const project = newProject(`风格项目 ${projects.length + 1}`);
    await commit(project);
    setActiveProjectId(project.id);
    setView('studio');
    setActiveScreenId(project.screens[0]?.id ?? null);
    setSelectedNodeId(null);
    setStatus(`已创建项目 ${project.name}`);
  }, [projects.length, commit, busy, sliceSession.hasUnsaved]);

  const onAddScreen = useCallback(async () => {
      if (busy || sliceSession.hasUnsaved) {
        setError('请先完成处理并保存素材修改。');
        return;
      }
    if (!activeProject) return;
    setStatus(null);
    const screen = newScreen(`界面 ${activeProject.screens.length + 1}`);
    await commit({ ...activeProject, screens: [...activeProject.screens, screen] });
    setActiveScreenId(screen.id);
    setSelectedNodeId(null);
  }, [activeProject, commit, busy, sliceSession.hasUnsaved]);

  const onDeleteProject = useCallback(
    async (id: string) => {
      if (busy || sliceSession.hasUnsaved) {
        setError('请先完成处理并保存素材修改。');
        return;
      }
      setStatus(null);
      if (!window.confirm('删除这个项目及界面记录？')) return;
      const deleting = saveQueue.current.then(() => removeProject(id));
      saveQueue.current = deleting.catch(() => undefined);
      // Block further writes to the removed project while deletion is in flight.
      const deletedProject = projectsRef.current.find((project) => project.id === id);
      const remaining = projectsRef.current.filter((project) => project.id !== id);
      projectsRef.current = remaining;
      setProjects(remaining);
      if (activeProjectId === id) {
        setActiveProjectId(remaining[0]?.id ?? null);
        setActiveScreenId(remaining[0]?.screens[0]?.id ?? null);
      }
      try {
        await deleting;
        unsavedProjects.current.delete(id);
      } catch (reason) {
        if (deletedProject) {
          projectsRef.current = [...projectsRef.current, deletedProject];
          setProjects(projectsRef.current);
        }
        setSaveError(`删除项目失败，请重新加载核对：${String(reason)}`);
        throw reason;
      }
    },
    [activeProjectId, busy, sliceSession.hasUnsaved],
  );

  const onCopy = async (projectId: string, screenId?: string) => {
    if (busy || pendingSaves > 0 || unsavedProjects.current.size || sliceSession.hasUnsaved) {
      setError('请先完成处理并保存项目和素材修改，再复制。');
      return;
    }
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await saveQueue.current;
      let result;
      if (screenId) result = await copyScreen(projectId, screenId);
      else result = await copyProject(projectId);
      const otherProjects = projectsRef.current.filter((project) => project.id !== result.project.id);
      projectsRef.current = [...otherProjects, result.project];
      setProjects(projectsRef.current);
      setActiveProjectId(result.project.id);
      setView('studio');
      setActiveScreenId(result.screenId ?? result.project.screens[0]?.id ?? null);
      setSelectedNodeId(null);
      setStatus(screenId ? '已复制界面及已保存素材' : '已复制项目及已保存素材');
      runAction(sliceSession.reload());
    } catch (reason) {
      setError(`复制失败：${String(reason)}`);
    } finally {
      setBusy(false);
    }
  };

  const onCreateStyle = useCallback(async (style: Style) => {
    const saved = await saveStyle(style);
    setStyles(saved);
  }, []);

  const onExtractStyle = () => {
    if (busy || !activeVersion?.image) return;
    setStatus(null);
    setError(null);
    setStyleReferenceImage(activeVersion.image);
    setView('styles');
  };

  const onDeleteStyle = useCallback(async (id: string) => {
    const saved = await removeStyle(id);
    setStyles(saved);
  }, []);

  const onApplyStyle = useCallback(
    async (id: string) => {
      const style = styles.find((entry) => entry.id === id);
      if (!style) return;
      await patchProject({ stylePrompt: style.prompt, styleImage: style.image });
      setStatus(`已应用风格「${style.name}」`);
    },
    [styles, patchProject],
  );

  const onSelectProject = useCallback(
    (id: string) => {
      if (busy || sliceSession.hasUnsaved) {
        setError('请等待处理完成，并先保存当前素材修改，再切换项目。');
        return;
      }
      setStatus(null);
      setActiveProjectId(id);
      setView('studio');
      const project = projects.find((p) => p.id === id);
      setActiveScreenId(project?.screens[0]?.id ?? null);
      setSelectedNodeId(null);
    },
    [projects, busy, sliceSession.hasUnsaved],
  );

  const onSelectScreen = useCallback((id: string) => {
    if (busy || sliceSession.hasUnsaved) {
      setError('请等待处理完成，并先保存当前素材修改，再切换界面。');
      return;
    }
    setStatus(null);
    setActiveScreenId(id);
    setSelectedNodeId(null);
  }, [busy, sliceSession.hasUnsaved]);

  const onToggleSlice = (id: string) => {
    if (busy || sliceSession.hasUnsaved || sliceRestoring || !sliceElements) return;
    sliceSession.changeElements(sliceElements.map((element) => element.id === id ? { ...element, approved: !element.approved } : element));
  };

  const onDeleteScreen = useCallback(
    async (id: string) => {
      if (busy || sliceSession.hasUnsaved) {
        throw new Error('请先完成处理并保存素材修改。');
      }
      const project = projectsRef.current.find(entry => entry.id === activeProjectId);
      if (!project || !project.screens.some(screen => screen.id === id)) throw new Error('要删除的界面不存在');
      if (project.screens.length <= 1) throw new Error('至少保留一个界面');
      const screens = project.screens.filter((screen) => screen.id !== id);
      await commit({ ...project, screens });
      if (activeScreenId === id) setActiveScreenId(screens[0]?.id ?? null);
      setSelectedNodeId(null);
    },
    [activeProjectId, activeScreenId, commit, busy, sliceSession.hasUnsaved],
  );

  const onAddNode = useCallback(
    async (kind: LayoutKind) => {
      if (!activeScreen) return;
      const draft = layoutDraftRef.current;
      const editing = draft?.projectId === activeProjectId && draft.screen.id === activeScreenId;
      const screen = editing ? draft.screen : projectsRef.current.find((entry) => entry.id === activeProjectId)?.screens.find((entry) => entry.id === activeScreenId);
      if (!screen) return;
      const node = newNode(kind);
      const parent = screen.layout.find(entry => entry.id === selectedNodeId);
      node.parentId = null;
      if (parent) node.parentId = parent.id;
      const saving = patchScreen({ layout: [...screen.layout, node] });
      setSelectedNodeId(node.id);
      await saving;
    },
    [activeScreen, activeProjectId, activeScreenId, selectedNodeId, patchScreen, busy, sliceSession.hasUnsaved],
  );

  const onDeleteNode = useCallback(async () => {
    if (!activeScreen || !selectedNodeId) return;
    await patchScreen({
      layout: activeScreen.layout.filter((node) => !descendantIds(activeScreen.layout, selectedNodeId).has(node.id)),
    });
    setSelectedNodeId(null);
  }, [activeScreen, selectedNodeId, patchScreen]);

  const onPatchNode = useCallback(
    async (patch: Partial<LayoutNode>) => {
      if (!activeScreen || !selectedNodeId) return;
      const draft = layoutDraftRef.current;
      const editing = draft?.projectId === activeProjectId && draft.screen.id === activeScreenId;
      const screen = editing ? draft.screen : projectsRef.current.find((entry) => entry.id === activeProjectId)?.screens.find((entry) => entry.id === activeScreenId);
      if (!screen) return;
      if (patch.parentId && descendantIds(screen.layout, selectedNodeId).has(patch.parentId)) throw Error('不能将节点放入自身或子节点');
      let nodes = screen.layout;
      if (patch.rect) nodes = transformLayoutGroup(nodes, selectedNodeId, patch.rect);
      const layout = nodes.map(node => node.id === selectedNodeId ? {...node,...patch} : node);
      await patchScreen({ layout });
    },
    [activeScreen, selectedNodeId, patchScreen],
  );

  const onUploadStyle = useCallback(
    async (file: File) => {
      if (!activeProject || busy) return;
      setStatus(null);
      setOperation('upload-style');
    setBusy(true);
      setError(null);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl, prefix: 'style' }),
        });
        const payload = (await response.json()) as { fileName?: string; error?: string };
        if (!response.ok || payload.error) throw new Error(payload.error ?? '上传失败');
        await patchProject({ styleImage: payload.fileName });
        setStatus('风格参考图已保存');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setOperation('');
      setBusy(false);
      }
    },
    [activeProject, patchProject, busy],
  );

  const onPlanLayout = useCallback(async () => {
    if (busy) return;
    if (!activeProject || !activeScreen) return;
    if (!activeScreen.usage.trim()) {
      setError('先填写这个界面的用途，模型才知道要摆什么');
      return;
    }
    setStatus(null);
    setOperation('plan');
    setBusy(true);
    setError(null);
    setStatus('模型正在规划线稿…');
    try {
      const nodes = await planLayout({
        usage: `${activeScreen.usage}\nScreen orientation: ${activeProject.orientation}.`,
        model: settings.visionModel,
      });
      await patchScreen({ layout: nodes });
      setSelectedNodeId(null);
      setStatus(`已生成 ${nodes.length} 个线稿节点，可以继续手动调整`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperation('');
      setBusy(false);
    }
  }, [activeProject, activeScreen, settings.visionModel, patchScreen, busy]);

  const saveVersionScreen = useCallback(async (
    projectId: string, screenId: string, update: (screen: Screen) => Screen,
  ) => {
    const project = updateVersionScreen(projectsRef.current, projectId, screenId, update);
    if (!project) throw new Error('目标项目或界面已不存在，未写入其他界面');
    await commit(project);
  }, [commit]);

  async function removeScreenVersion(
    projectId: string,
    screenId: string,
    versionId: string,
  ) {
    if (busy || sliceSession.hasUnsaved) {
      throw new Error('请先完成处理并保存素材修改。');
    }
    const project = projectsRef.current.find((entry) => entry.id === projectId);
    const screen = project?.screens.find((entry) => entry.id === screenId);
    if (!screen?.versions.some((version) => version.id === versionId)) {
      throw new Error('要删除的版本不存在');
    }

    const renderTask = renderTasks.find((task) =>
      task.id === versionId && task.projectId === projectId && task.screenId === screenId);
    setOperation('remove-version');
    setVersionBusy(true);
    setError(null);
    try {
      await saveVersionScreen(projectId, screenId, (currentScreen) =>
        deleteVersion(currentScreen, versionId));
      if (renderTask && !['acknowledged', 'discarded'].includes(renderTask.status)) {
        try {
          const cancelledTask = await cancelProjectRender(renderTask.id);
          setRenderTasks((tasks) =>
            tasks.map((task) => task.id === cancelledTask.id ? cancelledTask : task));
          dismissRenderNotice(renderTask);
        } catch (reason) {
          const detail = reason instanceof Error ? reason.message : String(reason);
          setError(`版本已移除，但停止生成任务失败：${detail}`);
        }
      }
    } finally {
      setOperation('');
      setVersionBusy(false);
    }
  }

  const onRenameScreen = async (projectId: string, screenId: string, name: string) => {
    if (busy || sliceSession.hasUnsaved) throw new Error('请先完成处理并保存素材修改。');
    const screenName = name.trim();
    if (!screenName) throw new Error('界面名称不能为空');
    if (screenName.length > 120) throw new Error('界面名称最多 120 个字符');
    await saveVersionScreen(projectId, screenId, screen => ({...screen, name: screenName}));
  };

  const onRenameProject = async (id: string, name: string) => {
    if (busy || sliceSession.hasUnsaved || standaloneSession.hasUnsaved) throw new Error('请先完成处理并保存素材修改。');
    const projectName = name.trim();
    if (!projectName) throw new Error('项目名称不能为空');
    if (projectName.length > 120) throw new Error('项目名称最多 120 个字符');
    const project = projectsRef.current.find(entry => entry.id === id);
    if (!project) throw new Error('要重命名的项目不存在');
    await commit({...project,name:projectName});
  };

  const appliedStyle = styles.find(style => style.id === appliedStyleId);
  let projectStyleName = appliedStyle?.name;
  if (!projectStyleName) {
    projectStyleName = activeProject?.stylePrompt ? '自定义风格' : '未设置';
  }
  const styleSnapshot = activeProject ? {
    id: appliedStyleId || undefined,
    name: appliedStyle?.name,
    prompt: activeProject.stylePrompt,
    image: activeProject.styleImage,
  } : undefined;

  const startProjectRender = async (input: ProjectRenderInput) => {
    const tasks = await listProjectRenders();
    const project = projectsRef.current.find((entry) => entry.id === input.projectId);
    if (!project) throw new Error('生成目标项目已删除');
    const screen = project.screens.find((entry) => entry.id === input.screenId);
    const unfinished = screen?.versions.some((version) => !version.image &&
      (version.operation === 'generate' || version.operation === 'refine'));
    const unsettledRequest = tasks.some((task) => task.projectId === input.projectId && task.screenId === input.screenId &&
      ['queued', 'running', 'interrupted'].includes(task.status));
    if ((unfinished || unsettledRequest) && !window.confirm('此界面已有未完成的生成记录，可能已经计费。确定提交新的付费请求？已有请求可使用“继续等待”。')) return;
    await commit(reserveProjectRender(project, input));
    const task = await submitProjectRender(input);
    setRenderTasks((tasks) => [...tasks.filter((entry) => entry.id !== task.id), task]);
    setStatus('生成任务已保存，可刷新页面，完成后自动保存结果。');
  };

  const onRetryProjectRender = async () => {
    if (!retryRequest || retryInFlight.current || busy) return;
    if (sliceSession.hasUnsaved) {
      setError('请先保存当前素材修改，再重新生成。');
      return;
    }
    retryInFlight.current = true;
    const { task, versionId } = retryRequest;
    setVersionBusy(true);
    setError(null);
    try {
      const project = projectsRef.current.find((entry) => entry.id === task.projectId);
      if (!project) throw new Error('原项目已删除，未提交新请求');
      const input: ProjectRenderInput = {
        id: versionId, projectId: task.projectId, screenId: task.screenId,
        operation: task.operation, sourceVersionId: task.sourceVersionId, sourceImage: task.sourceImage,
        prompt: task.prompt, styleSnapshot: task.styleSnapshot, size: task.size,
      };
      const screen = project.screens.find(entry => entry.id === task.screenId);
      if (!screen) throw new Error('原界面已删除，未提交新请求');
      if (!screen.versions.some(version => version.id === input.id)) {
        await commit(reserveProjectRender(project, input));
      } else {
        // Reuse the reservation after a lost retry response instead of adding another version.
        await saveQueue.current;
        if (unsavedProjects.current.has(project.id)) throw new Error('项目尚未保存成功，请先重试项目保存');
      }
      const retried = await retryProjectRender(task.id, input.id);
      setRenderTasks((tasks) => [...tasks.filter((entry) => entry.id !== retried.id), retried]);
      setStatus('已确认重新生成，使用原任务快照。');
      dismissRenderNotice(task);
      setRetryRequest(null);
    } catch (reason) { setError(`重新生成失败：${String(reason)}`); }
    finally { retryInFlight.current = false; setVersionBusy(false); }
  };

  const onRefine = async (prompt: string, sourceVersion = activeVersion) => {
    if (busy || sliceSession.hasUnsaved || !activeProject || !activeScreen || !sourceVersion?.image || !prompt.trim()) return;
    const projectId = activeProject.id;
    const screenId = activeScreen.id;
    const sourceImage = sourceVersion.image;
    setStatus(null);
    setOperation('refine');
    setVersionBusy(true);
    setError(null);
    try {
      const source = await loadImageElement(imageUrl(sourceImage));
      await startProjectRender({
        id: `v-${createUuid()}`, projectId, screenId, operation: 'refine',
        sourceVersionId: sourceVersion.id, sourceImage, prompt, styleSnapshot,
        size: `${source.naturalWidth}x${source.naturalHeight}`,
      });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`${activeProject.name} / ${activeScreen.name}：${detail}`);
    } finally {
      setOperation('');
      setVersionBusy(false);
    }
  };

  const onGenerate = async (targetScreen = activeScreen) => {
    if (busy || sliceSession.hasUnsaved) return;
    if (!activeProject || !targetScreen) return;
    setOperation('generate');
    setVersionBusy(true);
    setError(null);
    setStatus(null);

    try {
      // The wireframe is rendered at the generation resolution: this PNG is the layout
      // contract handed to the image model.
      const parts = [activeProject.size.w, activeProject.size.h];
      const genW = Number(parts[0]);
      const genH = Number(parts[1]);
      const wire = renderWireframe(targetScreen.layout, genW, genH);

      await startProjectRender({
        id: `v-${createUuid()}`, projectId: activeProject.id, screenId: targetScreen.id,
        operation: 'generate', styleSnapshot,
        prompt: buildGenerationPrompt(activeProject, targetScreen),
        wireframe: wire.toDataURL('image/png'),
        size: `${activeProject.size.w}x${activeProject.size.h}`,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`${activeProject.name} / ${targetScreen.name}：${detail}`);
    } finally {
      setOperation('');
      setVersionBusy(false);
    }
  };

  const onAnalyze = useCallback(async (redetect = false) => {
    if (busy) return;
    if (!activeProject || !activeScreen || !activeVersion || !projectSource) return;
    if (sliceRestoring) {
      setError('素材任务正在恢复中，请等待原图和素材加载完成。');
      return;
    }
    if (sliceSession.hasUnsaved) {
      setError('素材有未保存的修改，请先重试保存，再分析或补图。');
      return;
    }
    if (redetect && !window.confirm('重新识别会添加新发现的元素，已有 id 的名称、审核、手修和产物全部保留。继续？')) return;
    setOperation('analyze');
    setBusy(true);
    setError(null);
    try {
      sliceSession.assertCanProcess();
      let source = sliceSource;
      if (!source) {
        const image = new Image();
        image.src = imageUrl(projectSource.sourceImage);
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('无法创建 2D 画布上下文');
        ctx.drawImage(image, 0, 0);
        source = { dataUrl: canvas.toDataURL('image/png'), width: image.naturalWidth, height: image.naturalHeight };
      }
      const target = sliceSession.task ?? newSliceTask(projectSource, `${activeProject.name} / ${activeScreen.name} / ${activeVersion.id}`, source.width, source.height);
      const reportProgress = (message: string) => {
        if (sliceSession.isCurrent(target.source)) {
          setSliceProgress(message);
          setStatus(message);
        }
      };
      await extractSliceTask(sliceSession, target, sliceElements ?? [], source, settings, reportProgress, extractionMethod, redetect);
    } catch (err) {
      if (sliceSession.isCurrent(projectSource)) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperation('');
      setBusy(false);
      setSliceProgress(null);
    }
  }, [activeProject, activeScreen, activeVersion, settings, projectSource, sliceSession, sliceElements, sliceSource, sliceRestoring, busy, extractionMethod]);

  const onPlate = async () => {
    if (busy) return;
    if (sliceRestoring) {
      setError('素材任务正在恢复中，请等待原图和素材加载完成。');
      return;
    }
    if (sliceSession.hasUnsaved) {
      setError('素材有未保存的修改，请先重试保存，再分析或补图。');
      return;
    }
    const task = sliceSession.task;
    if (!sliceElements || !sliceSource || !task) return;
    setOperation('plate');
    setBusy(true);
    setError(null);
    try {
      await repaintTask(sliceSession, task, sliceElements, sliceSource, setSliceProgress);
      if (sliceSession.isCurrent(task.source)) setStatus('补图处理完成，失败项可重试');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperation('');
      setBusy(false);
      setSliceProgress(null);
    }
  };

  const onExport = useCallback(async () => {
    if (!sliceElements) return;
    setOperation('export');
    setBusy(true);
    setError(null);
    setStatus('正在打包导出…');
    try {
      const { blob, fileName } = await buildZip(sliceElements, assetSettings);
      downloadBlob(blob, fileName);
      setStatus('导出完成');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setOperation('');
      setBusy(false);
    }
  }, [sliceElements, assetSettings]);

  const onSwitchVersion = useCallback(
    async (id: string) => {
      if (busy || sliceSession.hasUnsaved) {
        setError('请等待处理完成，并先保存当前素材修改，再切换版本。');
        return;
      }
      // Elements belong to one picture, so they must not outlive the switch.
      setStatus(null);
      await patchScreen({ activeVersionId: id });
    },
    [patchScreen, busy, sliceSession.hasUnsaved],
  );

  /**
   * Imports a finished picture as a version. Image quotas run out, and an artist
   * often has the art already; slicing must not be gated on generating it here.
   */

  const onImportVersion = useCallback(
    async (file: File) => {
      if (!activeProject || !activeScreen) return;
      if (busy || sliceSession.hasUnsaved) {
        setError('请先完成处理并保存素材修改。');
        return;
      }
      setStatus(null);
      setOperation('import');
      setVersionBusy(true);
      setError(null);
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl, prefix: 'screen' }),
        });
        const payload = (await response.json()) as { fileName?: string; error?: string };
        if (!response.ok || payload.error) throw new Error(payload.error ?? '导入失败');

        if (!payload.fileName) throw new Error('导入未返回已保存的图片');
        const version: ScreenVersion = {
          operation: 'import', styleSnapshot, name: file.name,
          id: `v-${createUuid()}`,
          image: payload.fileName,
          prompt: '导入的结果图',
          createdAt: Date.now(),
        };
        await saveVersionScreen(activeProject.id, activeScreen.id, (screen) => appendVersion(screen, version));
        setStatus(`${activeProject.name} / ${activeScreen.name}：已把这张图作为新版本导入`);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setError(`${activeProject.name} / ${activeScreen.name}：${detail}`);
      } finally {
        setOperation('');
        setVersionBusy(false);
      }
    },
    [activeProject, activeScreen, saveVersionScreen, styleSnapshot, busy, sliceSession.hasUnsaved],
  );

  const onImportAiSliceElements = useCallback(
    async (dataUrl: string, prompt: string) => {
      if (!activeProject || !activeScreen || !activeVersion || !projectSource) {
        throw new Error('当前没有可切图的界面版本');
      }
      if (busy || sliceSession.hasUnsaved) throw new Error('请先完成处理并保存素材修改');
      setOperation('ai-slice-import');
      setVersionBusy(true);
      setError(null);
      try {
        const { width, height, elements } = await sliceAlphaSheet(dataUrl);
        let source = sliceSource;
        if (!source) {
          const image = new Image();
          image.src = imageUrl(projectSource.sourceImage);
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          const context = canvas.getContext('2d', { willReadFrequently: true });
          if (!context) throw new Error('无法读取当前界面画布');
          context.drawImage(image, 0, 0);
          source = { dataUrl: canvas.toDataURL('image/png'), width: image.naturalWidth, height: image.naturalHeight };
        }
        const task = sliceSession.task ?? newSliceTask(
          projectSource,
          `${activeProject.name} / ${activeScreen.name} / ${activeVersion.id}`,
          source.width,
          source.height,
        );
        const merged = [...sliceElements ?? [], ...elements];
        await sliceSession.save(task, merged);
        if (sliceSession.isCurrent(projectSource)) {
          setSliceProgress(`AI 拆图完成：拆出 ${elements.length} 个组件，已写入当前素材任务`);
          setStatus(`AI 拆图完成：${elements.length} 个组件，来源画布 ${width}×${height}，要求：${prompt}`);
        }
      } finally {
        setOperation('');
        setVersionBusy(false);
      }
    },
    [activeProject, activeScreen, activeVersion, busy, projectSource, sliceElements, sliceSession, sliceSource],
  );

  const onSetResolution = useCallback(
    async (size: Project['size']) => {
      await patchProject({ orientation: size.w > size.h ? 'landscape' : 'portrait', size });
    },
    [patchProject],
  );

  const assetPanelProps = {
    sourceImage: projectSource?.sourceImage,
    source: sliceSource ?? undefined,
    settings: assetSettings,
    onChangeElements: (elements: NonNullable<typeof sliceElements>) => {
      if (busy || sliceSession.hasUnsaved || sliceRestoring) return;
      sliceSession.changeElements(elements);
    },
    elements: sliceElements,
    busy,
    blocked: sliceSession.hasUnsaved || sliceRestoring,
    progress: sliceProgress,
    onAnalyze: () => runAction(onAnalyze()),
    onPlate: () => runAction(onPlate()),
    onExport: () => runAction(onExport()),
    onToggle: onToggleSlice,
  };

  const discardLayout = () => {
    if (!window.confirm('放弃本次线稿修改并退出？')) return;
    publishLayoutDraft(null);
    setSelectedNodeId(null);
    setEditorOpen(false);
  };
  const useLayout = async () => {
    const draft = layoutDraftRef.current;
    if (!draft || busy || layoutSaving) return;
    setLayoutSaving(true);
    try {
      const saving = saveQueue.current.then(async () => {
        const project = projectsRef.current.find(project=>project.id===draft.projectId);
        if (!project || !project.screens.some(screen=>screen.id===draft.screen.id)) throw Error('项目或界面已删除，未保存线稿');
        const edited = draft.screen;
        const screens = project.screens.map(screen=>screen.id===edited.id ? {...screen,layout:edited.layout,usage:edited.usage,name:edited.name,layoutReferenceImage:edited.layoutReferenceImage} : screen);
        const next = {...project,screens};
        // Publish only after persistence succeeds, so a failed save can still be discarded.
        await saveProject(next);
        projectsRef.current = projectsRef.current.map(project=>project.id===next.id ? next : project);
        setProjects(projectsRef.current);
      });
      saveQueue.current = saving.catch(()=>undefined);
      await saving;
      publishLayoutDraft(null);
      setSelectedNodeId(null);
      setEditorOpen(false);
      setStatus('线稿已保存');
    } catch(reason) {setError('保存线稿失败：'+String(reason));}
    finally {setLayoutSaving(false);}
  };

  const gatewayOk = health?.gateway ?? false;

  return (
    <div className={`app view-${view}`}>
      <header className="topbar">
        <button className="brand" aria-label="返回首页" title="返回首页" disabled={busy || sliceSession.hasUnsaved} onClick={() => {
          setView('home');
          setHomeVisit(current => current + 1);
        }}>
          <span className="brand-mark" aria-hidden="true">G</span>GameUI Studio
        </button>

        <button className={`view-tab ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>设置</button>
        <div className="spacer" />

        <div className={`conn ${gatewayOk ? 'ok' : 'bad'}`}>
          <i />
          {health ? health.status : '检查 Magpie…'}
        </div>
      </header>

      <ToastQueue message={status}><div className="app-feedback" aria-live="polite">
      {pendingSaves > 0 && <p role="status">正在保存项目修改…</p>}
      {busy && <p role="status">{operationLabel(operation)}</p>}
      {renderTasks.filter((task) => task.projectId === activeProjectId && task.screenId === activeScreenId &&
        !['acknowledged', 'discarded'].includes(task.status) && !dismissedRenderNotices.has(renderNoticeKey(task))).map((task) => <div className="toast-item render-task-notice" key={task.id} role="status">
        <button className="toast-close" aria-label="关闭任务通知" onClick={() => dismissRenderNotice(task)}>×</button>
        {task.operation === 'refine' ? '微调' : '生成'} · {projectRenderStatus(task.status)}{task.error && `：${task.error}`}
        <div className="toast-actions">{task.status === 'interrupted' && <button disabled={busy} onClick={() => runAction(resumeProjectRender(task.id).then((resumed) => {
          setRenderTasks((tasks) => tasks.map((entry) => entry.id === resumed.id ? resumed : entry));
        }))}>继续等待</button>}
        {(task.status === 'interrupted' || task.status === 'failed') && <button disabled={busy} onClick={() => {
          setRetryRequest({task, versionId: `v-${createUuid()}`});
          setError(null);
        }}>重新生成</button>}</div>
      </div>)}
      {saveError && <p className="err" role="alert">{saveError}<button onClick={() => {
        for (const project of unsavedProjects.current.values()) runAction(commit(project));
      }}>重试项目保存</button></p>}
      {error && <p className="err" role="alert">{error}<button onClick={() => setError(null)}>关闭</button></p>}
      </div>
      {view === 'studio' && sliceSession.error && <p className="err" role="alert">{sliceSession.error}<button onClick={() => runAction(sliceSession.retrySave())} disabled={!sliceSession.hasUnsaved}>重试保存</button><button disabled={sliceSession.hasUnsaved} onClick={() => runAction(sliceSession.reload())}>重新加载素材</button></p>}
      {view === 'studio' && sliceSession.hasUnsaved && <p role="status">素材更改正在保存或等待重试，请在保存完成后刷新。</p>}
      {view === 'studio' && projectSource && sliceRestoring && <p role="status">素材任务正在恢复中，请等待原图和素材加载完成。</p>}
      {view === 'studio' && sliceSession.task?.status === 'interrupted' && <p role="status">素材处理有未完成项，已保存项保留；分析重试未完成分割，补图仅重绘遮挡项。</p>}
      </ToastQueue>
      <div className={`main studio-main ${view !== 'studio' ? 'tool-main' : ''}`}>
        {view === 'home' && <HomePage key={homeVisit} projects={projects} styles={styles} visionModel={settings.visionModel}
          busy={busy} onBusyChange={setBusy} onCreateStyle={onCreateStyle} onDeleteStyle={onDeleteStyle} onOpenProject={onSelectProject}
          onAddProject={() => runAction(onAddProject())} onCopyProject={id => runAction(onCopy(id))}
          onRenameProject={onRenameProject}
          onDeleteProject={id => runAction(onDeleteProject(id))}
          onOpenSlicer={() => setView('slicer')} onOpenDrawing={() => setView('drawing')} />}
        {view === 'slicer' && <section className="standalone-stage">
          <SlicerTool extractionMethod={extractionMethod} settings={settings} busy={busy} onBusyChange={setBusy} session={standaloneSession} onSelectSource={setStandaloneSource} />
        </section>}
        {view === 'drawing' && <DrawingTool styles={styles} busy={busy} onBusyChange={setBusy} />}
        {view === 'styles' && (
          <StyleLibrary
            visionModel={settings.visionModel}
            initialReferenceImage={styleReferenceImage}
            styles={styles}
            busy={busy}
            onBusyChange={setBusy}
            onCreate={onCreateStyle}
            onDelete={onDeleteStyle}
          />
        )}
        {view === 'settings' && <SettingsPage settings={settings} models={models} health={health} onChange={setSettings} />}
        {view === 'studio' && (
          <>
        <div className="project-area">

        <fieldset className="proj-title stage-fields" disabled={busy}>
          {activeProject ? (
            <>
              <div className="project-identity"><span className="project-avatar">▦</span><strong title={activeProject.name}>{activeProject.name}</strong>
                <button className="project-settings-gear" aria-label="项目设置" title="项目设置" onClick={() => setFloatingPanel('project')}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 3-.7 2.2-2 .9-2.2-.5-2.1 3.6L4 11v2l-1.5 1.8 2.1 3.6 2.2-.5 2 .9.7 2.2h5l.7-2.2 2-.9 2.2.5 2.1-3.6L20 13v-2l1.5-1.8-2.1-3.6-2.2.5-2-.9-.7-2.2z"/><circle cx="12" cy="12" r="3"/></svg>
                </button>
              </div>
              <span className="muted">分辨率：{activeProject.size.w} × {activeProject.size.h}</span>
              <span className="project-style-readout">风格：{projectStyleName}</span>
            </>
          ) : (
            <span className="muted">没有项目</span>
          )}
        </fieldset>

        <ProjectSidebar
          projects={projects}
          activeProjectId={activeProjectId}
          activeScreenId={activeScreenId}
          onSelectProject={onSelectProject}
          onSelectScreen={onSelectScreen}
          onAddScreen={() => runAction(onAddScreen())}
          onDeleteProject={(id) => runAction(onDeleteProject(id))}
          onDeleteScreen={onDeleteScreen}
          onRenameScreen={onRenameScreen}
          busy={busy || pendingSaves > 0 || !!saveError || sliceSession.hasUnsaved}
          onCopyProject={(id) => runAction(onCopy(id))}
          onCopyScreen={(projectId, screenId) => runAction(onCopy(projectId, screenId))}
        />
        </div>


        {activeProject && activeScreen ? <ProjectOverview key={activeProject.id} project={activeProject} selectedScreenId={activeScreenId}
          onRename={(screen,name) => onRenameScreen(activeProject.id,screen.id,name)}
          renderTasks={renderTasks}
          disabled={busy || sliceSession.hasUnsaved} onSelect={onSelectScreen}
          onEdit={(screen, editor) => {
            if (busy || sliceSession.hasUnsaved) return;
            onSelectScreen(screen.id);
            setError(null);
            if (editor === 'layout') {
              history.current = new LayoutHistory();
              publishLayoutDraft({projectId:activeProject.id,screen:structuredClone(screen)});
              setSelectedNodeId(null);
            }
            if (editor === 'layout' || editor === 'assets') {
              setStage(editor);
              setEditorOpen(true);
            } else {
              if (editor === 'refine') setRefineSource(screen.versions.find(v => v.id === screen.activeVersionId) ?? screen.versions.at(-1) ?? null);
              setFloatingPanel(editor);
            }
          }}
          onGenerate={(screen) => runAction(onGenerate(screen))}
          onVersion={(screen, versionId) => runAction(saveVersionScreen(activeProject.id, screen.id, current => ({ ...current, activeVersionId: versionId })))}
          onRemoveVersion={removeScreenVersion}
          onAddProject={() => runAction(onAddProject())} /> : <main className="overview-empty">
          <h1>创建你的第一个界面项目</h1><button className="primary" onClick={() => runAction(onAddProject())}>新建项目</button>
        </main>}
        {activeProject && activeScreen && editorOpen && <StudioDialog fullScreen title={stage === 'layout' ? '布局编辑器' : '资源编辑器'}
          locked={busy || layoutSaving || pendingSaves > 0 || sliceSession.hasUnsaved || !!saveError}
          onClose={stage === 'layout' ? discardLayout : () => setEditorOpen(false)}
          onApply={stage === 'layout' ? () => runAction(useLayout()) : undefined}
          actions={<><span>{activeScreen.name}</span>
            {stage === 'layout' && <>
              <button disabled={busy || !historyState.canUndo} onClick={() => moveHistory('undo')}>撤销</button>
              <button disabled={busy || !historyState.canRedo} onClick={() => moveHistory('redo')}>重做</button>
            </>}
            {stage === 'assets' && <button onClick={() => setFloatingPanel('export')}>下载当前页</button>}</>}>
          {(error || saveError) && <p className="err" role="alert">{error || saveError}</p>}
          <div className={stage === 'layout' ? 'layout-editor-page' : 'assets-editor-page'}>
            {stage === 'layout' && <nav className="layout-node-list" aria-label="布局节点">
              <div className="layout-node-heading"><h2>节点列表 · {activeScreen.layout.length}</h2>
                <AddLayoutNode disabled={busy} onAdd={kind=>runAction(onAddNode(kind))}/></div>
              <LayoutTree nodes={activeScreen.layout} selectedId={selectedNodeId} onSelect={setSelectedNodeId}
                disabled={busy || layoutSaving} onChange={nodes=>runAction(onChangeLayout(nodes))} />
            </nav>}
                      <main className="col center">

            <div className={`stage-content stage-${stage}`}>
              {stage === 'layout' && <>
              <LayoutEditor
                key={`${activeProject.id}/${activeScreen.id}`}
                disabled={busy}
                project={activeProject}
                screen={activeScreen}
                selectedNodeId={selectedNodeId}
                onSelectNode={setSelectedNodeId}
                onChangeLayout={(nodes) => runAction(onChangeLayout(nodes))}
              />

              </>}
              {stage === 'generation' && <section className="result-pane">
                <div className="result-bar">
                  <span className="pane-label">结果图</span>
                  <button className="primary" onClick={() => runAction(onGenerate())} disabled={busy}>
                    {operation === 'generate' ? '生成中…' : '生成'}
                  </button>
                  <button
                    className="tiny ghost"
                    onClick={() => versionInputRef.current?.click()}
                    disabled={busy}
                    title="把已经画好的图作为一个版本导入，用于切图"
                  >
                    导入结果图
                  </button>
                  <button disabled={busy || !activeVersion?.image} onClick={onExtractStyle}>
                    提取当前图画风
                  </button>
                </div>

                <GenerationResults key={`${activeProject.id}/${activeScreen.id}/${activeVersion?.id ?? 'empty'}`} versions={activeScreen.versions} activeVersion={activeVersion} />

                <button disabled={!activeVersion?.image} onClick={() => setStage('assets')}>进入素材编辑</button>
              </section>}
              {stage === 'assets' && <>
                <AssetsStage screenName={activeScreen.name} version={activeVersion}
                screens={activeProject.screens} screenId={activeScreen.id} onSelectScreen={onSelectScreen}
                onSelectVersion={versionId => runAction(onSwitchVersion(versionId))}
                exportSettings={assetSettings} onExportSettings={next => runAction(patchScreen({ assetSettings: next }))}
                busy={busy}
                onImport={() => versionInputRef.current?.click()}
                onImportGeneratedVersion={onImportAiSliceElements}
                panelProps={assetPanelProps} />
              </>}

            </div>

          </main>
                    <aside className="col right">
          {activeProject && activeScreen && (
            <>
              {stage === 'generation' && <GenerationStagePanel activeProject={activeProject} styles={styles}
                appliedStyleId={appliedStyleId} busy={busy} onApplyStyle={onApplyStyle} patchProject={patchProject}
                onUploadStyle={() => styleInputRef.current?.click()} runAction={runAction} />}

              {stage === 'layout' && <LayoutStagePanel key={`${activeProject.id}/${activeScreen.id}`} visionModel={settings.visionModel} activeScreen={activeScreen} selectedNode={selectedNode}
                busy={busy} operation={operation} setSelectedNodeId={setSelectedNodeId}
                patchScreen={patchScreen} onPlanLayout={onPlanLayout}
                onPatchNode={onPatchNode} onDeleteNode={onDeleteNode} runAction={runAction} />}

              {stage === 'assets' && <p className="hint">在主区域识别、修正和审核素材。修改自动保存到当前来源任务。</p>}
            </>
          )}
        </aside>
          </div>
        </StudioDialog>}
        {activeProject && activeScreen && floatingPanel && floatingPanel !== 'refine' && <StudioDialog
          title={{ project: '项目设置', export: '导出资源' }[floatingPanel]}
          locked={busy || pendingSaves > 0 || sliceSession.hasUnsaved} onClose={() => setFloatingPanel(null)}>
          <div className="studio-panel-content">
            {floatingPanel === 'project' && <>
              <section className="panel project-settings-form">
                <label>项目名称<input aria-label="项目名称" value={activeProject.name} disabled={busy}
                  onChange={event => runAction(patchProject({ name: event.target.value }))} /></label>
                <h2>画布分辨率</h2>
                <ResolutionForm key={activeProject.id} size={activeProject.size} disabled={busy} onSave={onSetResolution} />
              </section>
              <ProjectStyleGallery styles={styles} appliedStyleId={appliedStyleId}
                busy={busy} onApplyStyle={onApplyStyle} runAction={runAction} /></>}
            {floatingPanel === 'export' && <PageExportPanel project={activeProject} currentScreenId={activeScreen.id}
              settings={settings} busy={busy || sliceSession.hasUnsaved} onBusyChange={setBusy} />}
          </div>
        </StudioDialog>}
        {floatingPanel === 'refine' && refineSource?.image && activeScreen && <RefineDialog
          key={refineSource.id} source={refineSource} versions={activeScreen.versions} tasks={renderTasks}
          busy={busy} error={error} onSubmit={(prompt) => onRefine(prompt, refineSource)}
          onClose={() => setFloatingPanel(null)} onEditAssets={() => {
            setFloatingPanel(null);
            setStage('assets');
            setEditorOpen(true);
          }} />}
          </>
        )}
      </div>

      {retryRequest && <StudioDialog title="确认重新生成" locked={versionBusy} onClose={() => setRetryRequest(null)}>
        <div className="retry-confirmation">
          <p>将使用此任务保存的提示词、风格和画布快照生成一个新版本，保留已有版本。</p>
          <p className="muted">原请求可能已计费。重新生成会提交新请求，可能再次计费。</p>
          <div className="btn-row"><button disabled={versionBusy} onClick={() => setRetryRequest(null)}>取消</button>
            <button className="primary" disabled={busy || sliceSession.hasUnsaved} onClick={() => runAction(onRetryProjectRender())}>{versionBusy ? '提交中…' : '确认重新生成'}</button></div>
          {sliceSession.hasUnsaved && <p role="status">请先保存当前素材修改。</p>}
        </div>
      </StudioDialog>}
      <input
        ref={styleInputRef}
        className="file-input-hidden"
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) runAction(onUploadStyle(file));
          e.target.value = '';
        }}
      />

      <input
        ref={versionInputRef}
        className="file-input-hidden"
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) runAction(onImportVersion(file));
          e.target.value = '';
        }}
      />
    </div>
  );
}

function renderNoticeKey(task: ProjectRenderTask): string {
  return JSON.stringify([task.id, task.status, task.error]);
}

function projectRenderStatus(status: ProjectRenderTask['status']): string {
  switch (status) {
    case 'queued': return '排队中，可刷新页面';
    case 'running': return '生成中，可刷新页面';
    case 'interrupted': return '已中断，可继续等待已有请求';
    case 'failed': return '生成失败';
    case 'done': return '结果正在保存';
    case 'acknowledged': return '结果已保存';
    case 'discarded': return '目标已删除或修改，未写入结果';
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function operationLabel(operation: string): string {
  switch (operation) {
    case 'refine': return '正在基于所选结果微调…';
    case 'upload-style': return '正在上传风格参考图…';
    case 'import': return '正在上传并导入结果图…';
    case 'ai-slice-import': return '正在保存 AI 拆图素材表…';
    case 'plan': return '正在规划布局…';
    case 'generate': return '正在生成结果图…';
    case 'analyze': return '正在分析素材…';
    case 'plate': return '正在处理补图…';
    case 'export': return '正在打包导出…';
    case 'remove-version': return '正在移除版本…';
    default: return '工具正在处理，请稍候…';
  }
}
