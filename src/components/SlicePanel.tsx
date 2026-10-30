import type { Settings, UiElement } from '../types';
import { SlicePreview } from './SlicePreview';
import { ToastQueue } from './ToastQueue';

type Props = {
  atlas?: boolean;
  picking?: boolean;
  onColor?: (color:string)=>void;
  elements: UiElement[] | null;
  busy: boolean;
  blocked?: boolean;
  progress?: string | null;
  onAnalyze: () => void;
  onPlate: () => void;
  onExport: () => void;
  onToggle: (id: string) => void;
  source?: { dataUrl: string; width: number; height: number };
  sourceImage?: string;
  settings?: Settings;
  onChangeElements?: (elements: UiElement[]) => void;
  manualSelecting?: boolean;
  onStartManualSlice?: () => void;
  onCancelManualSlice?: () => void;
};

export function SlicePanel({
  elements, busy, blocked = false, progress, onAnalyze, onPlate, onExport, onToggle,
  source, sourceImage, settings, onChangeElements, atlas, picking, onColor,
  manualSelecting, onStartManualSlice, onCancelManualSlice,
}: Props) {
  const hasAiTargets = elements?.some((element) => element.needsAi && element.kind !== 'text' && !element.repainted) ?? false;
  const hasExportable = elements?.some((element) => element.approved && element.slice) ?? false;

  return (
    <section className="slice-panel">
      {!atlas && <div className="slice-bar">
        <span className="pane-label">切图</span>
        <div className="slice-actions">
          <button className="primary" onClick={onAnalyze} disabled={busy || blocked}>
            {busy ? '分析中…' : '分析'}
          </button>
          <button className="tiny" onClick={onPlate} disabled={busy || blocked || !hasAiTargets}>
            补图
          </button>
          <button className="tiny" onClick={onExport} disabled={busy || !hasExportable}>
            导出 ZIP
          </button>
        </div>
      </div>}

      <ToastQueue message={null}>{progress && <p role="status">{progress}</p>}</ToastQueue>

      {(elements || atlas) && (
        <SlicePreview atlas={atlas} picking={picking} onColor={onColor} elements={elements??[]} onToggle={onToggle}
          source={source} sourceImage={sourceImage} settings={settings} onChangeElements={onChangeElements}
          busy={busy || blocked} manualSelecting={manualSelecting}
          onStartManualSlice={onStartManualSlice} onCancelManualSlice={onCancelManualSlice} />
      )}
    </section>
  )
}
