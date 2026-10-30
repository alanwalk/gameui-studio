import { useState } from 'react';

export function ResolutionForm({ size, disabled, onSave }: {
  size: { w: number; h: number }; disabled: boolean; onSave: (size: { w: number; h: number }) => Promise<void>;
}) {
  const [w, setW] = useState(size.w);
  const [h, setH] = useState(size.h);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  return <form className="resolution-form" onSubmit={async event => {
    event.preventDefault();
    if (disabled || saving) return;
    if (![w, h].every(value => Number.isSafeInteger(value) && value > 0 && value <= 8192) || w * h > 40_000_000) {
      setError('宽高需为 1–8192 的整数，总像素不能超过 4000 万');
      return;
    }
    setSaving(true);
    setError('');
    try { await onSave({ w, h }); }
    catch (reason) { setError(String(reason)); }
    finally { setSaving(false); }
  }}>
    <label>宽<input aria-label="画布宽度" type="number" value={w} onChange={event => setW(Number(event.target.value))} /></label>
    <span>×</span>
    <label>高<input aria-label="画布高度" type="number" value={h} onChange={event => setH(Number(event.target.value))} /></label>
    <button disabled={disabled || saving} type="submit">{saving ? '保存中' : '设置分辨率'}</button>
    {error && <span role="alert">{error}</span>}
  </form>;
}
