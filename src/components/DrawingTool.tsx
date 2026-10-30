import { useEffect, useRef, useState } from 'react';
import type { Style } from '../types';
import { DRAWING_RESOLUTIONS, drawingSize, drawingRatioWarning, type DrawingInput, type DrawingState, type DrawingTask } from '../lib/drawingTypes';
import { createDrawing, drawingImageUrl, loadDrawingState, resumeDrawing, retryDrawing, uploadDrawingReference } from '../lib/drawingApi';
import './DrawingTool.css';
import { DrawingStylePicker } from './DrawingStylePicker';
import { imageUrl } from '../lib/magpie';

type Props = { styles?: Style[]; busy: boolean; onBusyChange: (busy: boolean) => void };
const DRAFT_KEY = 'gameui-drawing-draft-v1';
const STATUS: Record<DrawingTask['status'], string> = { queued: '排队中', running: '正在生成', done: '已完成', failed: '生成失败', interrupted: '等待中断' };
type ImagePreview = { name: string; url: string; download: string };

function readDraft(): DrawingInput {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    if (draft && typeof draft.prompt === 'string' && Array.isArray(draft.references) && draft.references.length <= 5 && draft.references.every((id: unknown) => typeof id === 'string')) {
      drawingSize(draft);
      return draft;
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  return { prompt: '', references: [], ratio: '1:1' };
}

export function DrawingTool({ styles = [], busy, onBusyChange }: Props) {
  const [draft, setDraft] = useState<DrawingInput>(readDraft);
  const [customResolution, setCustomResolution] = useState(() => !DRAWING_RESOLUTIONS.includes(drawingSize(draft)));
  const [state, setState] = useState<DrawingState>({ tasks: [], images: [] });
  const [selectedId, setSelectedId] = useState<string>();
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<ImagePreview>();
  const [referencePreviews, setReferencePreviews] = useState<ImagePreview[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  const historyPrompt = useRef<HTMLTextAreaElement>(null);
  const operation = useRef(false);
  const tasks = [...state.tasks].sort((a, b) => b.createdAt - a.createdAt);
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0];
  const selectedRatioWarning = selected && drawingRatioWarning(selected);
  useEffect(() => {
    if (historyPrompt.current) historyPrompt.current.scrollTop = 0;
  }, [selected?.id]);

  useEffect(() => {
    let cancelled = false;
    const references = selected?.references ?? [];
    const originals = references.map((id, index) => ({ name: `原始参考 ${index + 1}`, url: drawingImageUrl(id), download: drawingImageUrl(id, true) }));
    setReferencePreviews(originals);
    async function resolveOriginals() {
      const groups = await Promise.all(references.map(async (id, index) => {
        try {
          const response = await fetch('/api/style-generation/source-images', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ drawingImage: id }),
          });
          if (!response.ok) return [originals[index]];
          const result = await response.json() as { images: string[] };
          if (!result.images.length) return [originals[index]];
          return result.images.map((file, imageIndex) => ({ name: `原始参考 ${index + 1}-${imageIndex + 1}`, url: imageUrl(file), download: imageUrl(file) }));
        } catch { return [originals[index]]; }
      }));
      if (!cancelled) setReferencePreviews(groups.flat());
    }
    void resolveOriginals();
    return () => { cancelled = true; };
  }, [selected?.id]);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* Tasks remain persisted on the server. */ }
  }, [draft]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await loadDrawingState();
        if (active) { setState(next); setPollError(''); }
      } catch (cause) {
        if (active) setPollError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (active) { setLoading(false); timer = setTimeout(refresh, 2500); }
      }
    };
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (preview && !dialog.current?.open) dialog.current?.showModal();
  }, [preview]);

  async function run(action: () => Promise<void>) {
    if (busy || operation.current) return;
    operation.current = true;
    onBusyChange(true);
    setError('');
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operation.current = false; onBusyChange(false); }
  }

  async function submit() {
    await run(async () => {
      drawingSize(draft);
      try {
        const next = await createDrawing(draft);
        setState(next);
        setSelectedId([...next.tasks].sort((a, b) => b.createdAt - a.createdAt)[0]?.id);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${detail}。如果提交响应中断，请先查看生成记录再重试，请求可能已受理。`);
      }
    });
  }

  async function upload(files: File[]) {
    if (!files.length) return;
    if (draft.references.length + files.length > 5) { setError('最多添加 5 张参考图'); return; }
    await run(async () => {
      setUploading(true);
      try {
        for (const file of files) {
          const image = await uploadDrawingReference(file);
          setState((current) => ({ ...current, images: [...current.images, image] }));
          setDraft((current) => ({ ...current, references: [...current.references, image.id] }));
        }
      } finally { setUploading(false); }
    });
  }

  function showImage(id: string) {
    const image = state.images.find((entry) => entry.id === id);
    setPreview({ url: drawingImageUrl(id), download: drawingImageUrl(id, true), name: image?.name ?? '图片预览' });
  }

  async function retry(task: DrawingTask) {
    if (!window.confirm('重新生成会提交新的生图请求，可能再次计费。建议先继续等待已有结果。确认重新生成？')) return;
    await run(async () => { setState(await retryDrawing(task.id)); setSelectedId(undefined); });
  }

  return <section className="drawing-tool" aria-label="AI 画图">
    <header className="drawing-heading">
      <div><span className="drawing-eyebrow">AI IMAGE STUDIO</span><h2>把灵感变成画面</h2><p>独立创作，无需创建项目。描述想法，或上传参考图开始。</p></div>
      <span className="drawing-gateway">Magpie · 使用网关配置</span>
    </header>
    <div className="drawing-workspace">
      <div className="drawing-composer">
        <label htmlFor="drawing-prompt">创作描述</label>
        <textarea id="drawing-prompt" rows={8} maxLength={12000} value={draft.prompt} disabled={busy} placeholder="例如：一枚冰蓝色水晶盾牌图标，精致金属边框，柔和的魔法光芒，居中构图…" onChange={(event) => setDraft({ ...draft, prompt: event.target.value })} />
        <div className="drawing-hint">描述主体、风格、色彩与构图 <span>{draft.prompt.length}/12000</span></div>
        {styles.length > 0 && <DrawingStylePicker styles={styles} disabled={busy}
          onSelect={style => setDraft(current => ({ ...current, prompt: `${current.prompt}\n风格：${style.prompt}`.trim().slice(0, 12000) }))} />}
        <fieldset disabled={busy} className="drawing-resolution"><legend>分辨率（请求）</legend>
          <select aria-label="画图分辨率" value={customResolution ? 'custom' : drawingSize(draft)} onChange={event => {
            const custom = event.target.value === 'custom';
            setCustomResolution(custom);
            if (!custom) setDraft({ ...draft, ratio: 'custom', size: event.target.value });
          }}>
            {DRAWING_RESOLUTIONS.map(size => <option key={size} value={size}>{size.replace('x', ' × ')}</option>)}
            <option value="custom">自定义宽高</option>
          </select>
          {customResolution && <div className="drawing-custom-size">
            <label>宽<input aria-label="画图宽度" type="number" min={1} max={8192}
              value={(draft.size ?? drawingSize(draft)).split('x')[0]} onChange={event => setDraft({ ...draft, ratio: 'custom', size: `${Number(event.target.value)}x${(draft.size ?? drawingSize(draft)).split('x')[1]}` })} /></label>
            <span>×</span>
            <label>高<input aria-label="画图高度" type="number" min={1} max={8192}
              value={(draft.size ?? drawingSize(draft)).split('x')[1]} onChange={event => setDraft({ ...draft, ratio: 'custom', size: `${(draft.size ?? drawingSize(draft)).split('x')[0]}x${Number(event.target.value)}` })} /></label>
          </div>}
        </fieldset>
        <div className="drawing-reference-heading"><strong>参考图</strong><span>{draft.references.length}/5 · 可选</span></div>
        <div className="drawing-reference-list">{draft.references.map((id, index) => <div className="drawing-reference" key={id}>
          <button type="button" onClick={() => showImage(id)} aria-label={`预览参考图 ${index + 1}`}><img src={drawingImageUrl(id)} alt={`参考图 ${index + 1}`} /></button>
          <button type="button" disabled={busy} className="drawing-remove" aria-label={`移除参考图 ${index + 1}`} onClick={() => setDraft({ ...draft, references: draft.references.filter((entry) => entry !== id) })}>×</button>
        </div>)}</div>
        <label className={`drawing-upload ${busy || draft.references.length >= 5 ? 'is-disabled' : ''}`}>
          <input type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy || draft.references.length >= 5} onChange={(event) => { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <strong>{uploading ? '正在保存参考图…' : '+ 上传参考图'}</strong><span>PNG / JPEG / WebP · 每张最多 20 MB · 上传即保存</span>
        </label>
        <button type="button" className="drawing-generate" disabled={busy || loading || !draft.prompt.trim()} onClick={() => void submit()}>✦ 生成图片</button>
        <p className="drawing-small">生成记录自动保存，刷新或离开页面不影响服务端任务。</p>
        {error && <p role="alert" className="drawing-error">{error}</p>}
      </div>
      <div className="drawing-results">
        {pollError && <p role="alert" className="drawing-error">暂时无法同步记录：{pollError}。正在重新连接，请勿重复提交。</p>}
        {!selected && <div className="drawing-empty"><span>✧</span><h3>{loading ? '正在恢复生成记录…' : '下一张作品，从这里开始'}</h3><p>输入描述，选择比例，你的作品会出现在这里。</p></div>}
        {selected && <>
          <div className="drawing-result-heading"><h3>作品预览</h3><span className={`drawing-status drawing-status-${selected.status}`}>{STATUS[selected.status]}</span></div>
          {selectedRatioWarning && <p role="status" className="drawing-ratio-warning">⚠ {selectedRatioWarning}</p>}
          <div className="drawing-preview-columns">
            {selected.references.length > 0 && <div className="drawing-originals"><h4>原始参考</h4>{referencePreviews.map((reference, index) => <div className="drawing-reference-item" key={`${reference.url}-${index}`}>
              <button type="button" onClick={() => setPreview(reference)} aria-label={`预览${reference.name}`}><img src={reference.url} alt={reference.name} /></button>
              <a href={reference.download} download={`reference-${index + 1}.png`}>下载单图</a>
            </div>)}</div>}
            <div className="drawing-result-image">{selected.result ? <button type="button" onClick={() => showImage(selected.result!)} aria-label="放大生成结果"><img src={drawingImageUrl(selected.result)} alt="生成结果" /></button> : <div className="drawing-pending"><span>{selected.status === 'running' || selected.status === 'queued' ? '✦' : '◇'}</span><p>{STATUS[selected.status]}</p><small>{selected.submitted ? '已有请求已保存，继续等待不会重新提交生图' : '任务快照已保存'}</small></div>}</div>
          </div>
          <div className="drawing-result-actions">{selected.result && <a href={drawingImageUrl(selected.result, true)} download>↓ 下载原图</a>}
            <button type="button" disabled={busy} onClick={() => {
              setDraft({ prompt: selected.prompt, references: [...selected.references], ratio: selected.ratio, size: selected.size });
              setCustomResolution(!DRAWING_RESOLUTIONS.includes(selected.size));
            }}>复用描述与参考</button>
            {['failed', 'interrupted'].includes(selected.status) && <>
              {selected.submitted && <button type="button" disabled={busy} onClick={() => void run(async () => { setState(await resumeDrawing(selected.id)); })}>继续等待已有结果</button>}
              <button type="button" disabled={busy} onClick={() => void retry(selected)}>重新生成（新请求）</button>
            </>}
          </div>
          {selected.error && <p role="alert" className="drawing-error">{selected.error}</p>}
          <details className="drawing-snapshot"><summary>创作快照 · 请求 {selected.size}{selected.resultSize && ` · 实际 ${selected.resultSize.width}×${selected.resultSize.height}`}</summary><small>{new Date(selected.createdAt).toLocaleString()} · {selected.references.length} 张参考图</small></details>
        </>}
        <div className="drawing-history-heading"><h3>生成记录</h3><span>{tasks.length} 次创作</span></div>
        {selected && <label className="drawing-history-prompt">选中记录的完整提示词
          <textarea ref={historyPrompt} aria-label="选中记录的完整提示词" readOnly value={selected.prompt} rows={6} />
        </label>}
        <div className="drawing-history">{tasks.map((task) => {
          const ratioWarning = drawingRatioWarning(task);
          const promptSummary = task.prompt.replace(/\s+/g, ' ').trim();
          return <button type="button" key={task.id} aria-pressed={selected?.id === task.id} className={selected?.id === task.id ? 'is-selected' : ''} onClick={() => setSelectedId(task.id)}>
          {task.result ? <img src={drawingImageUrl(task.result)} alt="作品缩略图" loading="lazy" /> : <span className="drawing-history-placeholder">✦</span>}
          <span><strong>{promptSummary.slice(0,100)}{promptSummary.length>100?'…':''}</strong><small>{STATUS[task.status]} · {task.size} · {new Date(task.createdAt).toLocaleString()}</small>{ratioWarning && <small className="drawing-ratio-warning">⚠ {ratioWarning}</small>}</span>
        </button>;
        })}</div>
      </div>
    </div>
    {preview && <dialog className="drawing-modal" ref={dialog} onCancel={() => setPreview(undefined)} onClose={() => setPreview(undefined)}>
      <div><strong>{preview.name}</strong><button type="button" autoFocus onClick={() => { dialog.current?.close(); setPreview(undefined); }}>关闭</button></div>
      <img src={preview.url} alt={preview.name} /><a href={preview.download} download={`${preview.name}.png`}>↓ 下载此图</a>
    </dialog>}
  </section>;
}
