import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Rect, Settings, SliceResult, TextPolicy, UiElement } from '../types';
import { sliceToDataUrl, plateOccluded } from '../lib/pipeline';
import { restoreEnclosedPixels } from '../lib/maskHoles';
import { loadImageElement, toImageData } from '../lib/image';
import { sliceElement } from '../lib/key';
import { buildFileName } from '../lib/naming';
import { segmentElement } from '../lib/segmentation';
import type { SegmentationPoint } from '../lib/segmentation';
import { MaskEditor } from './MaskEditor';
import { arrangeAssets } from '../lib/assetAtlas';
import { PanZoomSurface } from './PanZoomSurface';
import { createUuid } from '../lib/uuid';
import { AssetQualityFeedback } from './AssetQualityFeedback';

const methodLabels = {
  'color-key': '原图色键（非精准分割）',
  segmentation: '精准分割',
  repaint: 'AI 补图',
  manual: '手工蒙版修正',
  'ai-sheet': 'AI 透明素材表裁切',
};
type Props = {
  atlas?: boolean;
  picking?: boolean;
  onColor?: (color:string)=>void;
  elements: UiElement[];
  onToggle: (id: string) => void;
  source?: { dataUrl: string; width: number; height: number };
  sourceImage?: string;
  settings?: Settings;
  onChangeElements?: (elements: UiElement[]) => void;
  busy?: boolean;
  manualSelecting?: boolean;
  onStartManualSlice?: () => void;
  onCancelManualSlice?: () => void;
};

export function SlicePreview({
  elements, onToggle, source, sourceImage, settings, onChangeElements, busy = false,
  atlas=false, picking, onColor, manualSelecting, onStartManualSlice, onCancelManualSlice,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [objectName, setObjectName] = useState('');
  const [state, setState] = useState('');
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 100, h: 100 });
  const [background, setBackground] = useState('checker');
  const [zoom, setZoom] = useState(1);
  const [editingMask, setEditingMask] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [interaction, setInteraction] = useState<'box' | 'keep' | 'exclude'>('box');
  const [points, setPoints] = useState<SegmentationPoint[]>([]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const frameStart = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const sessionRef = useRef(0);
  const operationRef = useRef(0);
  const latest = useRef({ elements, source, sourceImage, settings, busy, selectedId, adding, onChangeElements });
  latest.current = { elements, source, sourceImage, settings, busy, selectedId, adding, onChangeElements };
  const selected = elements.find((element) => element.id === selectedId);
  const open = adding || !!selected;
  const locked = busy || working;
  const readOnly = locked || !onChangeElements;
  const sheetAsset = selected?.coordinateSpace === 'sheet' || selected?.extractionMethod === 'ai-sheet';

  useEffect(() => {
    sessionRef.current++;
    setPoints([]);
    setSelectedId(null);
    setAdding(false);
    setEditingMask(false);
    frameStart.current = null;
  }, [source?.dataUrl, source?.width, source?.height, sourceImage]);

  useEffect(() => () => { sessionRef.current++; operationRef.current++; }, []);

  useEffect(() => { sessionRef.current++; }, [elements, busy]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      const opener = openerRef.current;
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  const close = () => {
    sessionRef.current++;
    setSelectedId(null);
    setAdding(false);
    setEditingMask(false);
  };

  const openEditor = (element?: UiElement) => {
    sessionRef.current++;
    openerRef.current = document.activeElement as HTMLElement;
    setAdding(!element);
    setSelectedId(element?.id ?? null);
    setObjectName(element?.objectName ?? 'ManualIcon');
    setState(element?.state ?? '');
    setRect(element?.rect ?? { x: 0, y: 0, w: Math.min(100, source?.width ?? 100), h: Math.min(100, source?.height ?? 100) });
    setEditingMask(false);
    setError('');
    setPoints([]);
    setInteraction('box');
    frameStart.current = null;
  };

  const updateElement = (updated: UiElement) => {
    if (readOnly) return;
    onChangeElements?.(elements.map((element) => element.id === updated.id ? updated : element));
  };

  const applyManualSlice = (slice: SliceResult) => {
    if (readOnly || !selected) return;
    updateElement({ ...selected, slice, approved: false, segmentationDiagnostics: undefined,
      extractionMethod: 'manual', processingStatus: 'done', processingError: undefined });
    setError('');
  };

  async function repairAsset(removeText: boolean) {
    if (readOnly || !selected?.slice || (!removeText && (!source || sheetAsset))) return;
    const owner = sessionRef.current;
    const target = selected;
    setWorking(true);
    setError('');
    try {
      let updated: UiElement;
      if (removeText) {
        const cleanTarget = { ...target, needsAi: true, textPolicy: 'remove' as const };
        const result = await plateOccluded([cleanTarget], source ?? { dataUrl: '' }, () => {});
        if (!result.outcomes[0]?.ok) throw Error(result.outcomes[0]?.error || '去字失败');
        updated = { ...result.updated[0], approved: false, textPolicy: target.textPolicy ?? 'separate' };
      } else {
        const original = await loadImageElement(source!.dataUrl);
        const canvas = document.createElement('canvas');
        canvas.width = target.slice!.width;
        canvas.height = target.slice!.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(original, target.rect.x, target.rect.y, target.rect.w, target.rect.h, 0, 0, canvas.width, canvas.height);
        const originalPixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const current = await loadImageElement(sliceToDataUrl(target.slice!));
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(current, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const repaired = restoreEnclosedPixels(canvas.width, canvas.height, pixels.data, originalPixels.data);
        pixels.data.set(repaired.pixels);
        context.putImageData(pixels, 0, 0);
        updated = { ...target, slice: { ...target.slice!, canvas }, approved: false,
          segmentationDiagnostics: undefined, extractionMethod: 'manual', processingStatus: 'done', processingError: undefined };
      }
      if (owner !== sessionRef.current || latest.current.selectedId !== target.id) throw Error('素材已切换，未覆盖其他结果');
      latest.current.onChangeElements?.(latest.current.elements.map(element => element.id === target.id ? updated : element));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setWorking(false); }
  }

  const extract = async (method: 'color-key' | 'segmentation') => {
    if (readOnly || !source || sheetAsset) return;
    if (method === 'color-key' && !settings) return;
    if (method === 'segmentation' && !sourceImage) return;
    if (!Object.values(rect).every(Number.isInteger) || rect.x < 0 || rect.y < 0 || rect.w < 1 || rect.h < 1 || rect.x + rect.w > source.width || rect.y + rect.h > source.height) {
      setError('请输入原图范围内的整数像素坐标，宽高必须大于零。');
      return;
    }
    if (!objectName.trim()) { setError('对象名不能为空。'); return; }
    const request = latest.current;
    const session = sessionRef.current;
    const operation = ++operationRef.current;
    const requestPoints = points.map((point) => ({ ...point }));
    let updatedElement: UiElement;
    if (selected) {
      updatedElement = { ...selected, objectName: objectName.trim(), state: state.trim(), rect: { ...rect } };
    } else {
      updatedElement = {
        id: `manual-${createUuid()}`, label: objectName.trim(), objectName: objectName.trim(), state: state.trim(),
        rect: { ...rect }, kind: 'icon', description: '人工框选素材', layer: Math.max(0, ...elements.map((element) => element.layer)) + 1,
        occluded: false, needsAi: false, approved: true,
      };
    }
    setWorking(true);
    setError('');
    try {
      let updated: UiElement;
      if (method === 'segmentation') {
        updated = await segmentElement(sourceImage!, updatedElement, requestPoints);
      } else {
        const image = await loadImageElement(source.dataUrl);
        if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) throw new Error('原图尺寸与传入坐标尺寸不一致');
        const pixels = toImageData(image);
        const slice = sliceElement(pixels, rect, settings!);
        updated = { ...updatedElement, slice, approved: false, extractionMethod: 'color-key', repainted: false,
          maskImage: undefined, segmentationDiagnostics: undefined };
      }
      const current = latest.current;
      if (session !== sessionRef.current || operation !== operationRef.current) return;
      const sourceChanged = current.source?.dataUrl !== request.source?.dataUrl || current.source?.width !== request.source?.width || current.source?.height !== request.source?.height || current.sourceImage !== request.sourceImage;
      const selectionChanged = current.selectedId !== request.selectedId || current.adding !== request.adding;
      const keySettingsChanged = method === 'color-key' && current.settings !== request.settings;
      if (current.busy || current.elements !== request.elements || sourceChanged || selectionChanged || keySettingsChanged || !current.onChangeElements) {
        setError('素材或操作状态已变化，本次结果未保存，请重新执行提取。');
        return;
      }
      updated = { ...updated, processingStatus: 'done', processingError: undefined };
      if (selected) current.onChangeElements(elements.map((element) => element.id === selected.id ? updated : element));
      else current.onChangeElements([...elements, updated]);
      setAdding(false);
      setSelectedId(updated.id);
      setEditingMask(false);
    } catch (cause) {
      if (session === sessionRef.current && operation === operationRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (operation === operationRef.current) setWorking(false);
    }
  };

  const download = () => {
    if (!selected?.slice) return;
    const anchor = document.createElement('a');
    anchor.href = sliceToDataUrl(selected.slice);
    anchor.download = buildFileName(settings?.module ?? 'Common', selected.objectName, selected.state);
    anchor.click();
  };

  const sourcePoint = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width * (source?.width ?? 1);
    const y = (event.clientY - bounds.top) / bounds.height * (source?.height ?? 1);
    return { x: Math.max(0, Math.min(source?.width ?? 1, Math.round(x))), y: Math.max(0, Math.min(source?.height ?? 1, Math.round(y))) };
  };

  const drawFrame = (event: PointerEvent<HTMLDivElement>) => {
    const start = frameStart.current;
    if (readOnly || interaction !== 'box' || !start || start.pointerId !== event.pointerId) return;
    const point = sourcePoint(event);
    setRect({ x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), w: Math.max(1, Math.abs(point.x - start.x)), h: Math.max(1, Math.abs(point.y - start.y)) });
  };

  const arrangement=arrangeAssets(elements);
  return (
    <section className={`slice-preview ${atlas?'atlas-preview':''}`}>
      {atlas && <button className="atlas-add" aria-pressed={manualSelecting} disabled={readOnly||!source}
        onClick={() => {
          if (manualSelecting) {
            onCancelManualSlice?.();
            return;
          }
          if (onStartManualSlice) {
            onStartManualSlice();
            return;
          }
          openEditor();
        }}>{manualSelecting ? '取消框选' : '框选切图'}</button>}
      {atlas && <PanZoomSurface width={arrangement.width} height={arrangement.height} label="切图图集画布" picking={picking} onColor={onColor}>
        {elements.map(element=>{
          const position=arrangement.items.find(item=>item.id===element.id)!;
          return <button key={element.id} className="atlas-sprite" title={element.objectName||element.label}
            aria-label={`预览 ${element.label}`} style={{left:position.x,top:position.y,width:position.w,height:position.h}}
            onClick={()=>openEditor(element)}>{element.slice&&<img draggable={false} src={sliceToDataUrl(element.slice)} alt={element.label}/>}</button>;
        })}
      </PanZoomSurface>}
      {!atlas && <>
      <div className="slice-preview-heading">素材预览 <span>点击放大与修正，取消审核可跳过导出</span>
        <button disabled={readOnly || !source || (!settings && !sourceImage)} onClick={() => openEditor()}>新增矩形素材</button>
      </div>
      <p className="hint">每项素材分别标注提取方式，请放大检查透明边缘；可用精准分割、显式色键提取或手工蒙版修正。</p>
      <div className="slice-preview-grid">
        {elements.map((element) => (
          <div className="slice-preview-card" key={element.id}>
            <button className="slice-preview-image" onClick={() => openEditor(element)} aria-label={`预览 ${element.label}`}>
              {element.slice && <img src={sliceToDataUrl(element.slice)} alt={element.label} />}
              {!element.slice && <span>尚未切图</span>}
            </button>
            <label><input type="checkbox" checked={element.approved} disabled={locked} onChange={() => {
              if (locked) return;
              if (onChangeElements) onChangeElements(elements.map((entry) => entry.id === element.id ? { ...entry, approved: !entry.approved } : entry));
              else onToggle(element.id);
            }} /> {element.objectName || element.label}</label>
            <p className="hint">{element.extractionMethod ? methodLabels[element.extractionMethod] : '提取方式未标注'}</p>
            <span className={`tag ${element.approved ? 'ok' : ''}`}>{element.approved ? '已审核' : '待审核'}</span>
            {element.processingError && <p role="alert">{element.processingError}</p>}
          </div>
        ))}
      </div>
      </>}
      {open && createPortal(
        <dialog ref={dialogRef} className="slice-preview-dialog slice-edit-dialog" aria-label="素材修正" onCancel={close} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
          <div className="slice-preview-heading">{selected?.label ?? '新增矩形素材'}<button onClick={close}>关闭</button></div>
          <div className="slice-edit-toolbar">
            <label>预览底色<select aria-label="预览底色" value={background} onChange={(event) => setBackground(event.target.value)}><option value="checker">棋盘</option><option value="light">浅底</option><option value="dark">深底</option><option value="color">彩色底</option></select></label>
            <label>缩放<select aria-label="缩放" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>{[0.25, 0.5, 1, 2, 4].map((value) => <option key={value} value={value}>{value * 100}%</option>)}</select></label>
            <button disabled={!selected?.slice} onClick={download}>下载这张 PNG</button>
            <button disabled={readOnly || !selected?.slice || !source || selected.repainted || sheetAsset} onClick={() => void repairAsset(false)}>修复内部镂空</button>
            <button disabled={readOnly || !selected?.slice} onClick={() => void repairAsset(true)}>AI 去字补底</button>
            <p className="hint">去字补底会重绘当前素材并可能产生模型费用，保留有意义的图标符号，修复文字下面的底材。修复镂空会填回封闭透明区域，请确认真实孔洞仍被保留。</p>
            <button disabled={readOnly || !selected?.slice} onClick={() => setEditingMask(!editingMask)}>{editingMask ? '返回预览（丢弃未保存笔画）' : '编辑蒙版'}</button>
          </div>
          {selected?.slice && !editingMask && <div className={`slice-edit-viewport slice-bg-${background}`}><img style={{ width: selected.slice.width * zoom, height: selected.slice.height * zoom }} src={sliceToDataUrl(selected.slice)} alt={selected.label} /></div>}
          {selected?.slice && editingMask && <MaskEditor key={selected.id} slice={selected.slice} disabled={readOnly} zoom={zoom} background={background} onApply={applyManualSlice} />}
          {selected && <AssetQualityFeedback element={selected} />}
          {source && !sheetAsset && <details open={adding}><summary>调整切图范围</summary>
            <fieldset disabled={readOnly} className="slice-edit-toolbar">
              <label>原图交互<select aria-label="原图交互" value={interaction} onChange={(event) => { setInteraction(event.target.value as 'box' | 'keep' | 'exclude'); frameStart.current = null; }}>
                <option value="box">框选</option><option value="keep">保留点</option><option value="exclude">排除点</option>
              </select></label>
              <button disabled={points.length === 0} onClick={() => setPoints([])}>清除提示点</button>
              <span>保留点：{points.filter((point) => point.label === 1).length} · 排除点：{points.filter((point) => point.label === 0).length}</span>
            </fieldset>
            <div className="slice-source-box" aria-label="原图框选与分割提示点"
            onPointerDown={(event) => {
              if (readOnly || event.button !== 0) return;
              event.preventDefault();
              const point = sourcePoint(event);
              if (interaction !== 'box') {
                const label = interaction === 'keep' ? 1 : 0;
                const prompt = { x: Math.min(source.width - 1, point.x), y: Math.min(source.height - 1, point.y), label } satisfies SegmentationPoint;
                setPoints((previous) => [...previous, prompt]);
                return;
              }
              event.currentTarget.setPointerCapture(event.pointerId);
              frameStart.current = { ...point, pointerId: event.pointerId };
            }}
            onPointerMove={drawFrame}
            onPointerUp={(event) => { drawFrame(event); frameStart.current = null; }}
            onPointerCancel={() => { frameStart.current = null; }}
            onLostPointerCapture={() => { frameStart.current = null; }}>
            <img src={source.dataUrl} alt="框选参照原图" draggable={false} />
            <span style={{ left: `${rect.x / source.width * 100}%`, top: `${rect.y / source.height * 100}%`, width: `${rect.w / source.width * 100}%`, height: `${rect.h / source.height * 100}%` }} />
            <svg viewBox={`0 0 ${source.width} ${source.height}`} preserveAspectRatio="none" role="img" aria-label={`分割提示点：${points.length} 个`} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              {points.map((point, index) => <g key={index}>
                <circle cx={point.x} cy={point.y} r={Math.max(2, source.width * 0.009)} fill={point.label === 1 ? '#168653' : '#d73045'} stroke="white" strokeWidth={Math.max(1, source.width * 0.0015)} />
                <text x={point.x} y={point.y} textAnchor="middle" dominantBaseline="central" fill="white" fontSize={Math.max(4, source.width * 0.018)}>{point.label === 1 ? '+' : '−'}</text>
              </g>)}
            </svg>
          </div>
          <p className="hint">在原图上拖框或点击添加提示点，坐标均为原图像素；绿色 + 保留，红色 − 排除。</p>
          </details>}
          <p className="hint">{selected?.slice?.width ?? rect.w} × {selected?.slice?.height ?? rect.h} 像素 · {selected?.extractionMethod ? methodLabels[selected.extractionMethod] : '未标注提取方式'}{selected?.repainted && ' · 含补图'}</p>
          <fieldset disabled={readOnly} className="slice-edit-fields">
            <label>对象名<input value={objectName} onChange={(event) => setObjectName(event.target.value)} /></label>
            <label>状态后缀<input value={state} onChange={(event) => setState(event.target.value)} /></label>
            {selected && <>
              <button onClick={() => { if (!objectName.trim()) { setError('对象名不能为空'); return; } updateElement({ ...selected, objectName: objectName.trim(), state: state.trim() }); }}>保存名称</button>
              <label><input type="checkbox" checked={selected.approved} onChange={() => updateElement({ ...selected, approved: !selected.approved })} />审核通过</label>
              <label>后续补图的文字处理<select aria-label="素材文字处理" value={selected.textPolicy ?? 'separate'}
                onChange={(event) => updateElement({ ...selected, textPolicy: event.target.value as TextPolicy })}>
                <option value="separate">去掉动态文字，保留空白底材</option>
                <option value="remove">删除文字并修复底材</option>
                <option value="preserve">保留美术文字</option>
              </select></label>
              <button className="danger" onClick={() => { if (readOnly) return; onChangeElements?.(elements.filter((element) => element.id !== selected.id)); close(); }}>删除素材</button>
            </>}
          </fieldset>
          {!sheetAsset && <details open={adding}><summary>坐标与重切</summary>
          <fieldset disabled={readOnly || !source} className="slice-edit-fields">
            <legend>原图矩形坐标（像素）</legend>
            {(['x', 'y', 'w', 'h'] as const).map((field) => <label key={field}>{field}<input type="number" step="1" min={field === 'w' || field === 'h' ? 1 : 0} value={Number.isNaN(rect[field]) ? '' : rect[field]} onChange={(event) => setRect({ ...rect, [field]: event.target.valueAsNumber })} /></label>)}
            <button disabled={!settings} onClick={() => extract('color-key')}>按此框从原图色键提取</button>
            <button disabled={!sourceImage} onClick={() => extract('segmentation')}>{adding ? '精准提取新素材' : '精准分割此素材'}</button>
          </fieldset>
          </details>}
          {working && <p role="status">正在提取素材，请稍候。首轮精准分割可能需要数十秒。</p>}
          {source && !sourceImage && <p className="hint">原图尚未落盘，暂不能精准分割。</p>}
          <p className="hint">色键提取不是精准分割。精准分割失败会显示错误，不自动改用色键。</p>
          {!sheetAsset && <p className="hint">修改坐标仅为目标提示，提取成功后保存。最终切图范围按目标轮廓与透明留边确定，重切后请重新审核。</p>}
          {!source && <p className="hint">尚未接入原图：可预览、下载和修正已有切图；原图重切与新增暂不可用。</p>}
          {!onChangeElements && <p className="hint">尚未接入素材保存回调：当前为预览模式。</p>}
          {error && <p role="alert">{error}</p>}
        </dialog>, document.body,
      )}
    </section>
  );
}
