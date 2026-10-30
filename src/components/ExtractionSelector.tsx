export type ExtractionMethod = 'segmentation' | 'color-key';
type Props = {
  value: ExtractionMethod;
  busy: boolean;
  onChange: (method: ExtractionMethod) => void;
};
export function ExtractionSelector({ value, busy, onChange }: Props) {
  return <div className="extraction-selector panel">
    <label>素材提取方式
      <select value={value} disabled={busy} onChange={(event) => onChange(event.target.value as ExtractionMethod)}>
        <option value="segmentation">精准分割（等待接入）</option>
        <option value="color-key">简单背景色键</option>
      </select>
    </label>
    {value === 'segmentation' && <p className="hint">精准分割尚未接线，分析暂不可用；已有素材仍可检查与导出。</p>}
    {value === 'color-key' && <p className="hint">当前分析只识别矩形框并按背景色抠图，适用于简单背景，不代表精准分割。</p>}
  </div>;
}
