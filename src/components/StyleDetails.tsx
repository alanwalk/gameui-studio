import { useState } from 'react';
import type { Style } from '../types';
import { imageUrl } from '../lib/magpie';
import { StudioDialog } from './StudioDialog';
import { ToastQueue } from './ToastQueue';

export function StyleDetails({style,onBack,onEdit,busy}: {style:Style;onBack:()=>void;onEdit?:()=>void;busy?:boolean}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  let references = style.referenceImages ?? [];
  if (references.length === 0 && style.image) references = [style.image];
  references = [...new Set(references)];

  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(style.prompt);
      setNotice('画风提示词已复制');
    } catch { setNotice('复制失败，可直接选中提示词复制。'); }
  }

  return <main className="style-details-page" aria-label="画风详情">
    <header className="style-details-header"><button onClick={onBack}>← 我的画风</button><h1>画风详情</h1>
      {onEdit && <button className="style-details-edit" disabled={busy} onClick={onEdit}>编辑风格</button>}</header>
    <div className="style-details-content">
      <section className="style-details-description">
        <span className="style-details-label">画风名称</span><h2>{style.name}</h2>
        <div className="style-details-prompt-heading"><label htmlFor="style-details-prompt">画风提示词</label><button onClick={() => void copyPrompt()}>复制提示词</button></div>
        <textarea id="style-details-prompt" value={style.prompt} readOnly />
      </section>
      <section className="style-details-references" aria-label="画风参考图">
        <h2>参考图 <span>{references.length} 张</span></h2>
        <div className="style-details-gallery">{references.map((file,index) => <figure key={file}>
          <button className="style-detail-image" onClick={() => setPreview(file)} aria-label={`预览参考图 ${index+1}`}>
            <img src={imageUrl(file)} alt={`参考图 ${index+1}`} />
          </button>
          <figcaption><span>参考图 {index+1}</span><a href={imageUrl(file)} download={file}>下载原图</a></figcaption>
        </figure>)}</div>
        {references.length === 0 && <p className="muted">此画风未添加参考图。</p>}
      </section>
    </div>
    {preview && <StudioDialog title="参考图预览" onClose={() => setPreview(null)}>
      <div className="style-details-preview"><img src={imageUrl(preview)} alt="参考图原图" /><a href={imageUrl(preview)} download={preview}>下载原图</a></div>
    </StudioDialog>}
    <ToastQueue message={notice}>{null}</ToastQueue>
  </main>;
}
