import { useEffect, useRef, useState } from 'react';
import { imageUrl } from '../lib/magpie';
import type { Style } from '../types';
import './style-edit.css';
import { StyleGenerator } from './StyleGenerator';
import { StudioDialog } from './StudioDialog';
import { ToastQueue } from './ToastQueue';

type Props = {
  initialEditingId?: string;
  onEditorClose?: () => void;
  visionModel?: string;
  initialReferenceImage?: string;
  styles: Style[];
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onCreate: (style: Style) => Promise<void>;
  onUpdate?: (style: Style) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
};

/**
 * The style library is deliberately project-independent: a look developed once should
 * be reusable across projects instead of being retyped for each one.
 */
export function StyleLibrary({
  initialEditingId,
  onEditorClose,
  visionModel,
  initialReferenceImage,
  styles,
  busy,
  onBusyChange,
  onCreate,
  onUpdate = onCreate,
  onDelete,
}: Props) {
  const initialStyle = styles.find(style => style.id === initialEditingId);
  const [name, setName] = useState(initialStyle?.name ?? '');
  const [prompt, setPrompt] = useState(initialStyle?.prompt ?? '');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftImages, setDraftImages] = useState<{ file: File; previewUrl: string }[]>([]);
  const [referenceImages, setReferenceImages] = useState<string[]>(() => {
    if (initialStyle?.referenceImages?.length) return [...initialStyle.referenceImages];
    if (initialStyle?.image) return [initialStyle.image];
    return [];
  });
  const [editingId, setEditingId] = useState<string | null>(initialStyle?.id ?? null);
  const [panel, setPanel] = useState<'ai' | 'manual' | null>(() => {
    if (initialStyle) return 'manual';
    if (initialReferenceImage) return 'ai';
    return null;
  });
  useEffect(() => { if (initialReferenceImage) setPanel('ai'); }, [initialReferenceImage]);
  const pending = useRef(false);
  const imageDraftRef = useRef(draftImages);
  imageDraftRef.current = draftImages;
  useEffect(() => () => imageDraftRef.current.forEach(releaseDraftImage), []);
  const locked = busy;
  const editingStyle = styles.find((style) => style.id === editingId);
  const canCreate = name.trim().length > 0 && prompt.trim().length > 0;

  const onCreateStyle = async () => {
    if (!canCreate || locked || pending.current) return;
    if (editingId && !editingStyle) {
      setError('该风格已不存在，请取消编辑后重试');
      return;
    }
    pending.current = true;
    onBusyChange(true);
    setError(null);
    setStatus(null);
    try {
      const now = Date.now();
      const references = [...referenceImages];
      for (const draft of draftImages) references.push(await uploadImageForRecord(draft.file));
      let style: Style;
      if (editingStyle) {
        style = editStyleFields(editingStyle, name, prompt, now);
        style.image = references[0];
        style.referenceImages = references;
        await onUpdate(style);
      } else {
        style = {
          id: createStyleId(),
          name: name.trim(),
          prompt: prompt.trim(),
          image: references[0],
          referenceImages: references,
          createdAt: now,
          updatedAt: now,
        };
        await onCreate(style);
      }
      setEditingId(null);
      setName('');
      setPrompt('');
      draftImages.forEach(releaseDraftImage);
      setDraftImages([]);
      setReferenceImages([]);
      setStatus(`已保存风格「${style.name}」`);
      setPanel(null);
      onEditorClose?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  };

  const onPickImages = (files: File[]) => {
    if (files.length + draftImages.length + referenceImages.length > 12) {
      setError('最多使用12张参考图');
      return;
    }
    const additions = files.map(file => ({ file, previewUrl: URL.createObjectURL(file) }));
    setDraftImages(current => [...current, ...additions]);
  };

  const onCopyStyle = async (source: Style) => {
    if (locked || pending.current) return;
    pending.current = true;
    onBusyChange(true);
    setError(null);
    setStatus(null);
    try {
      const now = Date.now();
      const copy: Style = { ...source, id: createStyleId(), name: source.name + ' 副本', createdAt: now, updatedAt: now };
      if (source.referenceImages) copy.referenceImages = [...source.referenceImages];
      await onCreate(copy);
      setStatus('已复制风格「' + source.name + '」');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  };

  const onDeleteStyle = async (style: Style) => {
    if (locked || pending.current) return;
    const confirmed = window.confirm(`删除风格「${style.name}」？已套用它的项目不会被改动。`);
    if (!confirmed) return;

    pending.current = true;
    onBusyChange(true);
    setError(null);
    setStatus(null);
    try {
      await onDelete(style.id);
      if (editingId === style.id) cancelEdit();
      setStatus(`已删除风格「${style.name}」`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      onBusyChange(false);
    }
  };

  function cancelEdit() {
    setEditingId(null);
    setName('');
    setPrompt('');
    draftImages.forEach(releaseDraftImage);
    setDraftImages([]);
    setReferenceImages([]);
  }

  const beginEdit = (style: Style) => {
    if (locked || pending.current) return;
    draftImages.forEach(releaseDraftImage);
    setDraftImages([]);
    const references = style.referenceImages?.length ? [...style.referenceImages] : [];
    if (!references.length && style.image) references.push(style.image);
    setReferenceImages(references);
    setEditingId(style.id);
    setName(style.name);
    setPrompt(style.prompt);
    setError(null);
    setStatus(null);
    setPanel('manual');
  };

  function closeEditor() {
    if (locked || pending.current) return;
    cancelEdit();
    setPanel(null);
    onEditorClose?.();
  }

  if (panel === 'manual') return <main className="style-details-page style-editor-page" aria-label={editingId ? '编辑风格' : '手动新增风格'}>
    <header className="style-details-header">
      <button disabled={locked} onClick={closeEditor}>← 返回</button>
      <h1>{editingId ? '编辑风格' : '手动新增风格'}</h1>
      <div className="style-editor-actions">
        <button disabled={locked} onClick={closeEditor}>取消编辑</button>
        <button className="primary" onClick={() => void onCreateStyle()} disabled={locked || !canCreate}>{busy ? '保存中…' : '保存到风格库'}</button>
      </div>
    </header>
    <div className="style-details-content">
      <section className="style-details-description">
          <div className="field">
            <label htmlFor="style-name">名称</label>
            <input
              id="style-name"
              placeholder="例如：冰川手绘厚涂"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={locked}
            />
          </div>
          <div className="field">
            <label htmlFor="style-prompt">风格提示词</label>
            <textarea
              id="style-prompt"
              rows={5}
              placeholder="例如：冰川题材 RPG，手绘厚涂，冷蓝与暖橙对比，木石材质"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={locked}
            />
          </div>
      </section>
      <section className="style-details-references" aria-label="编辑参考图">
        <h2>参考图 <span>{referenceImages.length + draftImages.length}/12</span></h2>
          <div className="style-edit-references">
            {referenceImages.map((file, index) => <figure key={file + index}>
              <img src={imageUrl(file)} alt={'参考图 ' + (index + 1)} />
              <button disabled={locked} onClick={() => setReferenceImages(current => current.filter((_, position) => position !== index))}>移除</button>
            </figure>)}
            {draftImages.map((draft, index) => <figure key={draft.previewUrl}>
              <img src={draft.previewUrl} alt={'新增参考图 ' + (index + 1)} />
              <button disabled={locked} onClick={() => {
                releaseDraftImage(draft);
                setDraftImages(current => current.filter((_, position) => position !== index));
              }}>移除</button>
            </figure>)}
          </div>
          <label className="style-file-button">添加参考图（{referenceImages.length + draftImages.length}/12）
            <input className="file-input-hidden" type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={locked}
              onChange={event => { onPickImages(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          </label>
      </section>
    </div>
    <ToastQueue message={error}>{null}</ToastQueue>
  </main>;

  return (
    <main className="col center styles">
      <div className="slicer-head">
        <div>
          <h2>风格库</h2>
          <p className="muted">
            把可复用的美术风格集中保存，新建项目或调整方向时直接套用，不用重复写提示词。
          </p>
        </div>
      </div>

      <div className="btn-row">
        <button onClick={() => setPanel('ai')}>AI 创建 / 提取画风</button>
        <button onClick={() => { cancelEdit(); setPanel('manual'); }}>手动新增风格</button>
      </div>
      {panel === 'ai' && <StudioDialog title="AI 创建画风" onClose={() => setPanel(null)} locked={busy}>
        <div className="studio-panel-content"><StyleGenerator visionModel={visionModel} initialReferenceImage={initialReferenceImage}
          busy={busy} onBusyChange={onBusyChange} onCreate={onCreate} /></div>
      </StudioDialog>}

      <div className="styles-layout">


        <section className="style-cards">
          <div className="style-cards-head">
            <span className="pane-label">已保存的风格</span>
            <span className="muted">{styles.length} 个</span>
          </div>

          {styles.length === 0 ? (
            <div className="result-empty">
              <p>风格库还是空的</p>
              <p className="muted">在左侧填写名称和提示词，保存第一套风格</p>
            </div>
          ) : (
            <div className="style-card-grid">
              {styles.map((style) => (
                <article key={style.id} className="style-card panel">
                  {style.image ? (
                    <img src={imageUrl(style.image)} alt={`${style.name} 参考图`} />
                  ) : (
                    <div className="style-card-placeholder">NO REFERENCE</div>
                  )}
                  <div className="style-card-body">
                    <h3>{style.name}</h3>
                    <p>{style.prompt}</p>
                    <div className="style-card-actions">
                      <button className="tiny ghost" onClick={() => beginEdit(style)} disabled={locked}>编辑</button>
                      <button className="tiny ghost" onClick={() => void onCopyStyle(style)} disabled={locked}>复制</button>
                      <button
                        className="tiny ghost danger"
                        onClick={() => void onDeleteStyle(style)}
                        disabled={locked}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <ToastQueue message={status}>{error && (
        <div className="statusline">
          {error ? <span className="err">{error}</span> : <span>{status}</span>}
        </div>
      )}</ToastQueue>
    </main>
  );
}

export function editStyleFields(style: Style, name: string, prompt: string, updatedAt = Date.now()): Style {
  const trimmedName = name.trim();
  const trimmedPrompt = prompt.trim();
  if (!trimmedName || !trimmedPrompt) throw new Error('风格名称和提示词不能为空');
  return { ...style, name: trimmedName, prompt: trimmedPrompt, updatedAt };
}

function createStyleId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function releaseDraftImage(draft: { file: File; previewUrl: string } | null): void {
  if (draft) URL.revokeObjectURL(draft.previewUrl);
}

async function uploadImageForRecord(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const response = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, prefix: 'style' }),
  });
  const payload = (await response.json()) as { fileName?: string; error?: string };
  if (!response.ok || payload.error || !payload.fileName) {
    throw new Error(payload.error ?? '风格参考图上传失败');
  }
  return payload.fileName;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
