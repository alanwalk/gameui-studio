import { useEffect, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import type { SliceResult } from '../types';
import { MaskHistory } from '../lib/maskEdit';
import type { BrushPoint, PixelImage } from '../lib/maskEdit';

const originals = new WeakMap<HTMLCanvasElement, PixelImage>();

type Props = {
  slice: SliceResult;
  disabled: boolean;
  zoom: number;
  background: string;
  onApply: (slice: SliceResult) => void;
};

export function MaskEditor({ slice, disabled, zoom, background, onApply }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<MaskHistory | null>(null);
  const publishedRef = useRef(new WeakSet<HTMLCanvasElement>());
  const pointerRef = useRef<{ id: number; point: BrushPoint } | null>(null);
  const [mode, setMode] = useState<'erase' | 'restore'>('erase');
  const [radius, setRadius] = useState(8);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const history = historyRef.current;

  useEffect(() => {
    // Async parent saves may echo any published snapshot; keep the active history.
    if (publishedRef.current.has(slice.canvas)) return;
    try {
      const context = slice.canvas.getContext('2d');
      if (!context) throw new Error('无法读取切图');
      const current = context.getImageData(0, 0, slice.width, slice.height);
      const original = originals.get(slice.canvas) ?? current;
      historyRef.current = new MaskHistory(original, current.data);
      pointerRef.current = null;
      setError('');
      setRevision((value) => value + 1);
    } catch (cause) {
      historyRef.current = null;
      setError(String(cause));
    }
  }, [slice]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const pixels = historyRef.current;
    if (!canvas || !pixels) return;
    canvas.getContext('2d')?.putImageData(new ImageData(pixels.current.slice(), slice.width, slice.height), 0, 0);
  }, [revision, slice.width, slice.height]);

  useEffect(() => {
    if (!disabled) return;
    historyRef.current?.endStroke();
    pointerRef.current = null;
    setRevision((value) => value + 1);
  }, [disabled]);

  const pointAt = (event: PointerEvent<HTMLCanvasElement>): BrushPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * slice.width / bounds.width, y: (event.clientY - bounds.top) * slice.height / bounds.height };
  };

  const finishStroke = (event: PointerEvent<HTMLCanvasElement>) => {
    if (pointerRef.current?.id !== event.pointerId) return;
    historyRef.current?.endStroke();
    pointerRef.current = null;
    setRevision((value) => value + 1);
  };

  const applyMask = () => {
    if (disabled || !history) return;
    history.endStroke();
    const canvas = document.createElement('canvas');
    canvas.width = slice.width;
    canvas.height = slice.height;
    const context = canvas.getContext('2d');
    if (!context) { setError('无法保存蒙版'); return; }
    context.putImageData(new ImageData(history.current.slice(), slice.width, slice.height), 0, 0);
    originals.set(canvas, history.original);
    publishedRef.current.add(canvas);
    onApply({ ...slice, canvas });
  };

  return (
    <div className="mask-editor">
      <fieldset disabled={disabled || !history} className="slice-edit-toolbar">
        <label>笔刷 <select aria-label="笔刷" value={mode} onChange={(event) => setMode(event.target.value as 'erase' | 'restore')}><option value="erase">擦除</option><option value="restore">恢复原切图像素</option></select></label>
        <label>半径（像素）<input type="range" min="1" max="80" value={radius} onChange={(event) => setRadius(Number(event.target.value))} />{radius}</label>
        <button disabled={!history?.canUndo} onClick={() => { history?.undo(); setRevision((value) => value + 1); }}>撤销</button>
        <button disabled={!history?.canRedo} onClick={() => { history?.redo(); setRevision((value) => value + 1); }}>重做</button>
        <button onClick={applyMask}>保存蒙版</button>
      </fieldset>
      <p className="hint">拖动擦除或恢复，保存后同步素材。关闭将丢弃未保存笔画；撤销历史仅保留在本次弹窗中。</p>
      {error && <p role="alert">{error}</p>}
      <div className={`slice-edit-viewport slice-bg-${background}`}>
        <canvas ref={canvasRef} width={slice.width} height={slice.height} style={{ width: slice.width * zoom, height: slice.height * zoom }} aria-label="素材蒙版画布" className="mask-edit-canvas"
          onPointerDown={(event) => {
            if (disabled || !history || event.button !== 0 || pointerRef.current) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointAt(event);
            pointerRef.current = { id: event.pointerId, point };
            history.beginStroke();
            history.paint(point, point, radius, mode);
            setRevision((value) => value + 1);
          }}
          onPointerMove={(event) => {
            const pointer = pointerRef.current;
            if (disabled || !history || !pointer || pointer.id !== event.pointerId) return;
            const point = pointAt(event);
            history.paint(pointer.point, point, radius, mode);
            pointer.point = point;
            setRevision((value) => value + 1);
          }}
          onPointerUp={finishStroke} onPointerCancel={finishStroke} onLostPointerCapture={finishStroke} />
      </div>
    </div>
  );
}
