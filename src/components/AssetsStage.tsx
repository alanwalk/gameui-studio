import { useEffect, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from 'react';
import { generateAiSliceSheet, imageUrl } from '../lib/magpie';
import type { Rect, Screen, ScreenVersion, Settings, UiElement } from '../types';
import { canvasToDataUrl, loadImageElement, toImageData } from '../lib/image';
import { sliceElement } from '../lib/key';
import { segmentElement } from '../lib/segmentation';
import { SlicePanel } from './SlicePanel';
import { PanZoomSurface } from './PanZoomSurface';
import { StudioDialog } from './StudioDialog';
import { ToastQueue } from './ToastQueue';

const DEFAULT_AI_SLICE_PROMPT = [
  '将这张游戏 UI 截图中的所有可复用物件拆分为独立组件。',
  '按面板、按钮、图标、徽章、边框、装饰和进度条分类，分区排布成整齐的组件表。',
  '每个组件保持完整轮廓、原始比例、配色、材质、光照和画风，组件之间留出充足间距，不重叠。',
  '去掉整屏背景、角色立绘和不可复用的场景内容；不要添加文字标签、网格线、阴影或宿主应用界面。',
  '透明背景，只输出一张适合自动切图的独立组件素材表。',
].join('');
const DEFAULT_AI_SLICE_FOCUS = '透明背景，按面板、按钮、图标、徽章、边框、装饰和进度条分类，组件之间留出充足间距。';

type Props = {
  screens?: Screen[];
  screenId?: string;
  onSelectScreen?: (id:string) => void;
  onSelectVersion?: (id:string) => void;
  exportSettings?: Pick<Settings, 'module' | 'includeTextAsImage'>;
  onExportSettings?: (settings: Pick<Settings, 'module' | 'includeTextAsImage'>) => void;
  screenName:string;version:ScreenVersion|null;busy:boolean;
  onImport:()=>void;panelProps:ComponentProps<typeof SlicePanel>;
  onImportGeneratedVersion?: (dataUrl: string, prompt: string) => Promise<void>;
};
export function AssetsStage({screenName,version,busy,onImport,panelProps,exportSettings,onExportSettings,screens,screenId,onSelectScreen,onSelectVersion,onImportGeneratedVersion}:Props) {
  const [size,setSize]=useState({w:1024,h:1536});
  const [picking,setPicking]=useState(false);
  const [color,setColor]=useState('#000000');
  const [notice,setNotice]=useState<string|null>(null);
  const [manualSelecting,setManualSelecting]=useState(false);
  const [manualSelection,setManualSelection]=useState<Rect|null>(null);
  const [manualName,setManualName]=useState('');
  const [manualWorking,setManualWorking]=useState(false);
  const [manualError,setManualError]=useState('');
  const [aiSliceOpen,setAiSliceOpen]=useState(false);
  const [aiSlicePrompt,setAiSlicePrompt]=useState(DEFAULT_AI_SLICE_FOCUS);
  const [aiSliceWorking,setAiSliceWorking]=useState(false);
  const [aiSliceError,setAiSliceError]=useState('');
  const screen = screens?.find(entry => entry.id === screenId);
  const latestManual = useRef({
    elements: panelProps.elements ?? [],
    source: panelProps.source,
    sourceImage: panelProps.sourceImage,
    settings: panelProps.settings,
    onChangeElements: panelProps.onChangeElements,
  });
  latestManual.current = {
    elements: panelProps.elements ?? [],
    source: panelProps.source,
    sourceImage: panelProps.sourceImage,
    settings: panelProps.settings,
    onChangeElements: panelProps.onChangeElements,
  };
  const manualSession = useRef(0);
  const manualOperation = useRef(0);
  const editorBusy = busy || manualWorking || aiSliceWorking;

  useEffect(() => {
    manualSession.current++;
    manualOperation.current++;
    setManualSelecting(false);
    setManualSelection(null);
    setManualName('');
    setManualWorking(false);
    setManualError('');
  }, [version?.image, panelProps.sourceImage]);

  function startManualSelection() {
    if (busy || panelProps.blocked || !panelProps.source || !panelProps.onChangeElements) return;
    manualSession.current++;
    setManualSelecting(true);
    setManualSelection(null);
    setManualName(nextManualAssetName(latestManual.current.elements));
    setManualError('');
  }

  function cancelManualSelection() {
    manualSession.current++;
    manualOperation.current++;
    setManualSelecting(false);
    setManualSelection(null);
    setManualName('');
    setManualWorking(false);
    setManualError('');
  }

  function selectManualRect(rect: Rect | null) {
    if (manualWorking) return;
    setManualSelection(rect);
    setManualError('');
  }

  async function extractManualSelection(method: 'segmentation' | 'color-key') {
    if (!manualSelection || manualWorking) return;
    const objectName = manualName.trim();
    if (!objectName) {
      setManualError('对象名不能为空');
      return;
    }
    const request = latestManual.current;
    if (!request.source || !request.onChangeElements) {
      setManualError('当前素材尚未加载完成');
      return;
    }
    if (method === 'segmentation' && !request.sourceImage) {
      setManualError('原图尚未落盘，暂不能精准分割');
      return;
    }
    if (method === 'color-key' && !request.settings) {
      setManualError('缺少色键提取设置');
      return;
    }

    const element: UiElement = {
      id: `manual-${crypto.randomUUID()}`,
      label: objectName,
      objectName,
      state: 'Normal',
      rect: { ...manualSelection },
      kind: 'icon',
      description: '人工框选素材',
      layer: Math.max(0, ...request.elements.map((entry) => entry.layer)) + 1,
      occluded: false,
      needsAi: false,
      approved: true,
    };
    const session = manualSession.current;
    const operation = ++manualOperation.current;
    setManualWorking(true);
    setManualError('');

    try {
      let extracted: UiElement;
      if (method === 'segmentation') {
        extracted = await segmentElement(request.sourceImage!, element);
      } else {
        const image = await loadImageElement(request.source.dataUrl);
        const pixels = toImageData(image);
        const slice = sliceElement(pixels, element.rect, request.settings!);
        extracted = { ...element, slice, extractionMethod: 'color-key', repainted: false, maskImage: undefined };
      }
      const current = latestManual.current;
      if (session !== manualSession.current || operation !== manualOperation.current) return;
      if (!current.source || current.source.dataUrl !== request.source.dataUrl || current.sourceImage !== request.sourceImage ||
          !current.onChangeElements) {
        setManualError('素材或操作状态已变化，本次结果未保存，请重新框选。');
        return;
      }
      current.onChangeElements([...current.elements, { ...extracted, processingStatus: 'done', processingError: undefined }]);
      setManualSelecting(false);
      setManualSelection(null);
      setManualName('');
      setNotice(`已新增框选素材「${objectName}」`);
    } catch (reason) {
      if (session === manualSession.current && operation === manualOperation.current) {
        setManualError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (session === manualSession.current && operation === manualOperation.current) setManualWorking(false);
    }
  }

  async function createAiSliceSheet() {
    if (!onImportGeneratedVersion || !version?.image || aiSliceWorking) return;
    const prompt = aiSlicePrompt.trim();
    if (!prompt) {
      setAiSliceError('请填写拆图要求');
      return;
    }
    setAiSliceWorking(true);
    setAiSliceError('');
    try {
      let reference = panelProps.source;
      if (!reference) {
        const image = await loadImageElement(imageUrl(version.image));
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('无法读取当前结果图');
        context.drawImage(image, 0, 0);
        reference = {
          dataUrl: canvasToDataUrl(canvas),
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
      }
      const size = reference.width > reference.height ? '1536x1024' : '1024x1536';
      const sheet = await generateAiSliceSheet({
        referenceDataUrl: reference.dataUrl,
        prompt: `${DEFAULT_AI_SLICE_PROMPT}\n补充要求：${prompt}`,
        size,
      });
      await onImportGeneratedVersion(sheet, prompt);
      setAiSliceOpen(false);
      setNotice('AI 拆图完成，组件已写入当前素材任务');
    } catch (reason) {
      setAiSliceError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAiSliceWorking(false);
    }
  }

  const manualOverlay = manualSelecting ? <div className="manual-slice-overlay" onPointerDown={(event) => event.stopPropagation()}>
    {manualSelection
      ? <div className="manual-slice-toolbar">
        <span className="manual-slice-size">{manualSelection.w} × {manualSelection.h}</span>
        <label>素材名称<input aria-label="新素材名称" value={manualName} disabled={manualWorking}
          onChange={(event) => setManualName(event.target.value)} /></label>
        <button className="primary" disabled={manualWorking || !panelProps.sourceImage}
          onClick={() => void extractManualSelection('segmentation')}>{manualWorking ? '提取中…' : '精准分割'}</button>
        <button disabled={manualWorking || !panelProps.settings}
          onClick={() => void extractManualSelection('color-key')}>色键提取</button>
        <button disabled={manualWorking} onClick={cancelManualSelection}>取消</button>
        {manualError && <p role="alert" className="manual-slice-error">{manualError}</p>}
      </div>
      : <div className="manual-slice-hint">在左侧原图上拖拽框选切图区域
        <button disabled={manualWorking} onClick={cancelManualSelection}>取消</button>
      </div>}
  </div> : undefined;

  return <section className="assets-stage asset-editor-stage">
    <nav className="asset-page-tabs" aria-label="资源界面">
      <div>{screens ? screens.map(entry => <button key={entry.id} className={entry.id === screenId ? 'active' : ''} disabled={editorBusy} onClick={() => onSelectScreen?.(entry.id)}>{entry.name}</button>) : <span>{screenName}</span>}</div>
      <div><button className="active">{screenName} · 素材</button></div>
    </nav>
    <header className="asset-tools">
      <strong>{screenName}</strong>
      <details className="asset-options" data-dropdown-menu><summary aria-label="资源编辑选项">···</summary><div>
        <button disabled={editorBusy} onClick={onImport}>导入图片</button>
      {exportSettings&&onExportSettings&&<details className="asset-export-settings"><summary>素材与导出设置</summary>
        <label>素材命名模块<input aria-label="素材命名模块" value={exportSettings.module} maxLength={64} disabled={editorBusy}
          onChange={event=>onExportSettings({...exportSettings,module:event.target.value})}/></label>
        <label><input type="checkbox" checked={exportSettings.includeTextAsImage} disabled={editorBusy}
          onChange={event=>onExportSettings({...exportSettings,includeTextAsImage:event.target.checked})}/>文本按图片导出</label>
      </details>}
      </div></details>
      <button className={picking?'active':''} aria-pressed={picking} disabled={editorBusy} onClick={()=>setPicking(!picking)}>取色</button>
      {picking && <><span className="color-readout"><i style={{background:color}}/>{color}</span>
      <button onClick={async()=>{
        try{await navigator.clipboard.writeText(color);setNotice('颜色已复制');}
        catch{setNotice('复制失败，请手动选择颜色值');}
      }}>复制颜色</button></>}
      {onImportGeneratedVersion && <button disabled={editorBusy||panelProps.blocked||!version?.image}
        onClick={()=>{setAiSlicePrompt(DEFAULT_AI_SLICE_FOCUS);setAiSliceError('');setAiSliceOpen(true);}}>AI 拆图</button>}
      <button className="primary" disabled={editorBusy||panelProps.blocked||!version?.image} onClick={panelProps.onAnalyze}>一键切图</button>
    </header>
    <div className="asset-workspace">
      <PanZoomSurface key={version?.image??'empty'} width={panelProps.source?.width??size.w} height={panelProps.source?.height??size.h}
        label="效果图画布" picking={picking} onColor={setColor} overlay={manualOverlay}>
        {version?.image&&<img className="asset-effect-image" draggable={false} src={imageUrl(version.image)} alt="当前素材来源图"
          onLoad={event=>setSize({w:event.currentTarget.naturalWidth,h:event.currentTarget.naturalHeight})}/>}
        {manualSelecting && <ManualSliceSelectionLayer width={panelProps.source?.width??size.w}
          height={panelProps.source?.height??size.h} selection={manualSelection} onSelect={selectManualRect} />}
      </PanZoomSurface>
      <SlicePanel {...panelProps} busy={panelProps.busy || manualWorking} atlas picking={picking} onColor={setColor}
        manualSelecting={manualSelecting} onStartManualSlice={startManualSelection}
        onCancelManualSlice={cancelManualSelection}/>
    </div>
    <footer className="asset-bottom-bar"><span>{screen ? '版本：' : '素材编辑'}</span>{screen?.versions.map((entry,index) =>
      <button key={entry.id} className={entry.id === version?.id ? 'active' : ''} disabled={editorBusy} onClick={() => onSelectVersion?.(entry.id)}>v{index+1}</button>)}</footer>
    {aiSliceOpen && <StudioDialog title="AI 拆图" locked={aiSliceWorking} onClose={() => setAiSliceOpen(false)}>
      <div className="studio-panel-content ai-slice-form">
        <p>图像模型会把当前结果重绘成一张透明背景的独立组件排版图，再交给现有检测和 SAM2 切图流程。当前界面版本不会被覆盖。</p>
        <label>拆分要求
          <textarea aria-label="拆分要求" value={aiSlicePrompt} maxLength={4000} disabled={aiSliceWorking}
            onChange={event=>setAiSlicePrompt(event.target.value)} />
        </label>
        <p className="hint">会调用图像模型，可能产生费用。生成结果会保存为新的“AI 拆图素材表”版本。</p>
        {aiSliceError && <p role="alert" className="err">{aiSliceError}</p>}
        <div className="btn-row">
          <button disabled={aiSliceWorking} onClick={()=>setAiSliceOpen(false)}>取消</button>
          <button className="primary" disabled={aiSliceWorking || !aiSlicePrompt.trim()} onClick={()=>void createAiSliceSheet()}>
            {aiSliceWorking ? '正在生成拆图素材表…' : '生成拆图素材表'}
          </button>
        </div>
      </div>
    </StudioDialog>}
    <ToastQueue message={notice}>{null}</ToastQueue>
  </section>;
}

function ManualSliceSelectionLayer({width,height,selection,onSelect}:{
  width:number;height:number;selection:Rect|null;onSelect:(rect:Rect|null)=>void;
}) {
  const [draft,setDraft]=useState<Rect|null>(selection);
  const start=useRef<{x:number;y:number;pointerId:number}|null>(null);

  useEffect(()=>{setDraft(selection);},[selection]);

  function sourcePoint(event:ReactPointerEvent<HTMLDivElement>) {
    const bounds=event.currentTarget.getBoundingClientRect();
    if(bounds.width<=0||bounds.height<=0)return{x:0,y:0};
    return{
      x:Math.max(0,Math.min(width,Math.round((event.clientX-bounds.left)/bounds.width*width))),
      y:Math.max(0,Math.min(height,Math.round((event.clientY-bounds.top)/bounds.height*height))),
    };
  }

  function updateDraft(event:ReactPointerEvent<HTMLDivElement>) {
    const anchor=start.current;
    if(!anchor||anchor.pointerId!==event.pointerId)return;
    const point=sourcePoint(event);
    setDraft({
      x:Math.min(anchor.x,point.x),
      y:Math.min(anchor.y,point.y),
      w:Math.abs(point.x-anchor.x),
      h:Math.abs(point.y-anchor.y),
    });
  }

  return <div className="manual-slice-layer" aria-label="框选切图区域"
    onPointerDown={(event)=>{
      if(event.button!==0)return;
      event.preventDefault();
      event.stopPropagation();
      const point=sourcePoint(event);
      start.current={...point,pointerId:event.pointerId};
      setDraft(null);
      onSelect(null);
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event)=>{
      event.stopPropagation();
      updateDraft(event);
    }}
    onPointerUp={(event)=>{
      event.preventDefault();
      event.stopPropagation();
      updateDraft(event);
      const point=sourcePoint(event);
      const anchor=start.current;
      start.current=null;
      if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
      if(!anchor||Math.abs(point.x-anchor.x)<2||Math.abs(point.y-anchor.y)<2){onSelect(null);return;}
      const rect={
        x:Math.min(anchor.x,point.x),
        y:Math.min(anchor.y,point.y),
        w:Math.max(1,Math.abs(point.x-anchor.x)),
        h:Math.max(1,Math.abs(point.y-anchor.y)),
      };
      setDraft(rect);
      onSelect(rect);
    }}
    onPointerCancel={()=>{start.current=null;setDraft(null);onSelect(null);}}
    onLostPointerCapture={()=>{start.current=null;}}>
    {draft&&<span className="manual-slice-selection" style={{left:draft.x,top:draft.y,width:draft.w,height:draft.h}}/>}
  </div>;
}

function nextManualAssetName(elements:UiElement[]):string {
  const names=new Set(elements.map(element=>element.objectName||element.label));
  let index=1;
  while(names.has(`ManualAsset${index}`))index++;
  return `ManualAsset${index}`;
}
