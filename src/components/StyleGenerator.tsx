import { useEffect, useRef, useState } from 'react';
import type { Style } from '../types';
import { imageUrl } from '../lib/magpie';
import { loadStyleDraft, newStyleDraft, STYLE_DRAFT_KEY, styleRequest, uploadStyleReference, type StyleDraft } from '../lib/styleGeneration';
import './style-generator.css';
import { ToastQueue } from './ToastQueue';

type Props = {
  home?: boolean;
  visionModel?: string;
  initialReferenceImage?: string;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onCreate: (style: Style) => Promise<void>;
};

export function StyleGenerator({ home = false, visionModel, initialReferenceImage, busy, onBusyChange, onCreate }: Props) {
  const [category, setCategory] = useState('自动');
  const [draft, setDraft] = useState(() => loadStyleDraft(initialReferenceImage));
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const current = useRef(draft);
  const mounted = useRef(true);
  const locked = useRef(false);
  const source = useRef(initialReferenceImage);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  current.current = draft;

  function persist(next: StyleDraft) {
    current.current = next;
    setDraft(next);
    try { localStorage.setItem(STYLE_DRAFT_KEY, JSON.stringify(next)); setStorageError(''); }
    catch { setStorageError('无法保存草稿，刷新可能丢失，请检查浏览器存储空间'); }
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; busyCallback.current(false); };
  }, []);

  useEffect(() => {
    if (source.current === initialReferenceImage) return;
    source.current = initialReferenceImage;
    persist(newStyleDraft(initialReferenceImage));
    setNotice('');
  }, [initialReferenceImage]);

  function isCurrent(id: string) { return mounted.current && current.current.id === id; }

  async function run(operation: (snapshot: StyleDraft) => Promise<void>) {
    if (locked.current || busy) return;
    locked.current = true;
    setWorking(true);
    onBusyChange(true);
    const snapshot = current.current;
    persist({ ...snapshot, error: undefined });
    setNotice('');
    try { await operation(snapshot); }
    catch (error) {
      if (isCurrent(snapshot.id)) persist({ ...current.current, error: error instanceof Error ? error.message : String(error) });
    } finally {
      locked.current = false;
      if (mounted.current) { setWorking(false); onBusyChange(false); }
    }
  }

  const frozen = busy || working;
  const generate = () => run(async snapshot => {
    let description = snapshot.description;
    if (home && category !== '自动') description = `${category}风格。${description}`;
    const result = await styleRequest<{ name: string; prompt: string; drawingReferences: string[] }>('/api/style-generation/analyze', {
      description, referenceImages: snapshot.referenceImages, model: visionModel,
    });
    if (!isCurrent(snapshot.id)) return;
    const analyzed = { ...snapshot, ...result, error: undefined, submitted: undefined, pendingDrawingID: undefined, image: snapshot.referenceImages[0] };
    persist(analyzed);
  });

  let previewStatus = '上传的图片直接作为风格参考，不额外生成图片。';
  if (working) previewStatus = '正在分析画风…';
  else if (draft.error) previewStatus = draft.error;
  else if (draft.prompt) previewStatus = '画风已分析，可直接保存，也可继续修改参考图后重新分析。';
  let generateLabel = home ? '开始创作' : 'AI 分析画风';
  if (working) generateLabel = '分析中…';

  return <section className={`style-generator panel ${home ? 'home-composer' : ''}`} aria-label="AI 画风创建">
    {home ? <div className="home-style-categories"><span>风格选择</span>{['自动','卡通','写实','手绘','扁平','3D','像素'].map(value =>
      <button key={value} disabled={frozen} aria-pressed={category === value} onClick={() => setCategory(value)}>{value}</button>)}</div> : <>
      <h2>AI 创建 / 提取画风</h2>
      <p className="muted">描述画风或上传参考图，分析后保存到风格库。</p>
    </>}
    <label className={home ? 'visually-hidden' : ''} htmlFor="style-ai-description">画风描述（有参考图时可选）</label>
    <textarea id="style-ai-description" maxLength={8000} rows={3} value={draft.description} disabled={frozen}
      placeholder="详细描述你想制作的游戏风格、类型、色调、画风与目标人群。例如：面向休闲玩家的森林冒险手游，明亮温暖的卡通画面，适配移动端竖屏。"
      onChange={event => persist({ ...draft, description: event.target.value })} />
    <div className="style-generator-refs">
      {draft.referenceImages.map((file, index) => <figure key={`${file}-${index}`}>
        <img src={imageUrl(file)} alt={`参考图 ${index + 1}`} />
        <button disabled={frozen} onClick={() => persist({ ...draft, referenceImages: draft.referenceImages.filter((_, i) => i !== index) })}>移除 {index + 1}</button>
      </figure>)}
    </div>
    <label className="style-upload-control">{home ? `＋ 添加截图 (${draft.referenceImages.length}/12)` : `上传参考图（${draft.referenceImages.length}/12）`}
      <input type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={frozen || draft.referenceImages.length >= 12}
        onChange={event => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          void run(async snapshot => {
            if (files.length + snapshot.referenceImages.length > 12) throw new Error('最多上传 12 张参考图，请重新选择');
            const references = [...snapshot.referenceImages];
            for (const file of files) references.push(await uploadStyleReference(file));
            if (isCurrent(snapshot.id)) persist({ ...snapshot, referenceImages: references, error: undefined });
          });
        }} />
    </label>
    <div className="style-generator-actions">
      <p role="status">{home && !working && !draft.prompt && !draft.error ? '上传游戏截图，或直接描述想法开始创作。' : previewStatus}</p>
      <button className="primary" disabled={frozen || (!draft.description.trim() && !draft.referenceImages.length)} onClick={() => void generate()}>{generateLabel}</button>
      <button disabled={frozen} onClick={() => { persist(newStyleDraft(initialReferenceImage)); setNotice(''); }}>新建草稿</button>
    </div>
    {draft.prompt && <div className="style-generator-result"><h3>{draft.name}</h3><details><summary>查看画风提示词</summary><p>{draft.prompt}</p></details>
      <button className="primary" disabled={busy || working} onClick={() => void run(async snapshot => {
        if (!snapshot.name || !snapshot.prompt) return;
        const now = Date.now();
        const style: Style & { referenceImages: string[] } = {
          id: `style-${snapshot.id}`, name: snapshot.name, prompt: snapshot.prompt, image: snapshot.referenceImages[0],
          referenceImages: snapshot.referenceImages, createdAt: now, updatedAt: now,
        };
        await onCreate(style);
        if (isCurrent(snapshot.id)) { persist(newStyleDraft(initialReferenceImage)); setNotice(`已保存风格「${style.name}」`); }
      })}>保存 AI 画风到风格库</button>
    </div>}
    {(draft.error || storageError) && <p role="alert" className="err">{draft.error || storageError}</p>}
    <ToastQueue message={notice}>{null}</ToastQueue>
  </section>;
}
