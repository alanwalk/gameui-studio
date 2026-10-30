import { useState } from 'react';
import type { Style } from '../types';
import { imageUrl } from '../lib/magpie';
import { StudioDialog } from './StudioDialog';

export function DrawingStylePicker({ styles, disabled, onSelect }: {
  styles: Style[]; disabled: boolean; onSelect: (style: Style) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const selected = styles.find(style => style.id === selectedId);

  return <div className="drawing-style-picker">
    <span>借用风格提示词</span>
    <button className="drawing-style-trigger" disabled={disabled} onClick={() => setOpen(true)} aria-label="选择画图风格">
      {selected?.image && <img src={imageUrl(selected.image)} alt={`${selected.name}预览`} />}
      <span>{selected?.name ?? '选择风格，查看预览图'}</span><span aria-hidden="true">▾</span>
    </button>
    {open && <StudioDialog title="选择画图风格" onClose={() => setOpen(false)}>
      <div className="drawing-style-options studio-panel-content">
        {styles.map(style => <button key={style.id} className="drawing-style-option" disabled={disabled}
          aria-label={`使用风格：${style.name}`} onClick={() => {
            onSelect(style);
            setSelectedId(style.id);
            setOpen(false);
          }}>
          {style.image ? <img src={imageUrl(style.image)} alt={`${style.name}预览图`} /> : <div className="drawing-style-no-image">暂无预览图</div>}
          <strong>{style.name}</strong>
        </button>)}
      </div>
    </StudioDialog>}
  </div>;
}
