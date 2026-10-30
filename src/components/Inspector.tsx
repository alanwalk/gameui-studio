import { useEffect, useRef, useState } from 'react';
import type { Settings, UiElement } from '../types';
import { suggestNineSlice } from '../lib/geometry';
import { buildFileName } from '../lib/naming';
import { canvasToDataUrl } from '../lib/image';

type Props = {
  element: UiElement | null;
  settings: Settings;
  onRename: (id: string, objectName: string, state: string) => void;
};

/** Draws a scaled copy so the shared slice canvas is never moved out of the list. */
function Preview({ element }: { element: UiElement }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !element.slice) return;

    const source = element.slice.canvas;
    const maxW = 300;
    const maxH = 190;
    const scale = Math.min(maxW / source.width, maxH / source.height, 1);

    const copy = document.createElement('canvas');
    copy.width = Math.max(1, Math.round(source.width * scale));
    copy.height = Math.max(1, Math.round(source.height * scale));
    copy.style.display = 'block';
    copy.style.margin = '0 auto';
    const ctx = copy.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(source, 0, 0, copy.width, copy.height);

    host.replaceChildren(copy);
  }, [element.slice]);

  return (
    <div
      ref={hostRef}
      style={{
        background:
          'repeating-conic-gradient(#141d21 0% 25%, #0b1013 0% 50%) 0 0 / 16px 16px',
        borderRadius: 3,
        padding: 8,
        marginBottom: 12,
        minHeight: 90,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    />
  );
}

export function Inspector({ element, settings, onRename }: Props) {
  const [objectName, setObjectName] = useState('');
  const [state, setState] = useState('');

  useEffect(() => {
    if (!element) return;
    setObjectName(element.objectName);
    setState(element.state);
  }, [element?.id, element?.objectName, element?.state]);

  if (!element) {
    return (
      <p className="empty">
        选中一个元素查看细节。
        <br />
        可以在画布上直接点选。
      </p>
    );
  }

  const slice = element.slice;
  const quietEdge = (slice?.border.dirtySides.length ?? 0) === 0;
  const nine = suggestNineSlice(element, quietEdge);
  const previewFileName = buildFileName(settings.module, objectName, state);

  const handleDownload = () => {
    if (!slice) return;
    const anchor = document.createElement('a');
    anchor.href = canvasToDataUrl(slice.canvas);
    anchor.download = previewFileName;
    anchor.click();
  };

  const commit = () => {
    const nextObject = objectName.trim() || element.objectName;
    if (nextObject === element.objectName && state.trim() === element.state) return;
    onRename(element.id, nextObject, state.trim());
  };

  return (
    <>
      <Preview element={element} />

      <div className="panel">
        <div className="card-name" style={{ marginBottom: 8, color: 'var(--key)' }}>
          {previewFileName}
        </div>
        <div className="card-meta">
          <span>{element.kind}</span>
          <span>
            {element.rect.w}×{element.rect.h}
          </span>
          <span>layer {element.layer}</span>
        </div>
      </div>

      <div className="field">
        <label>对象名</label>
        <input
          type="text"
          value={objectName}
          onChange={(e) => setObjectName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </div>
      <div className="field">
        <label>状态后缀</label>
        <input
          type="text"
          value={state}
          placeholder="Normal / Pressed / Selected ..."
          onChange={(e) => setState(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
        <p className="hint">模型原始标签：{element.label}</p>
      </div>

      {element.description && (
        <div className="field">
          <label>素材描述</label>
          <p className="hint" style={{ margin: 0 }}>
            {element.description}
          </p>
        </div>
      )}

      {element.text && (
        <div className="field">
          <label>识别文字</label>
          <p className="hint" style={{ margin: 0, color: 'var(--danger)' }}>
            {element.text}
          </p>
        </div>
      )}

      {slice && (
        <div className="field">
          <label>边缘检查</label>
          <div className="card-meta">
            {quietEdge ? (
              <span className="tag ok">四边干净</span>
            ) : (
              slice.border.dirtySides.map((side) => (
                <span key={side} className="tag dirty">
                  {side}
                </span>
              ))
            )}
          </div>
          <p className="hint">
            脏边意味着框切到了内容，通常是模型坐标偏了。可微调上方坐标后重切。
          </p>
        </div>
      )}

      <div className="field">
        <label>九宫格建议</label>
        {nine.suggested ? (
          <div className="card-meta">
            <span className="tag slice9">
              {nine.border.left}/{nine.border.right}/{nine.border.top}/{nine.border.bottom}
            </span>
          </div>
        ) : (
          <span className="tag">{nine.reason}</span>
        )}
        <p className="hint">{nine.suggested ? nine.reason : '仅为参考，最终由人工确认。'}</p>
      </div>

      <div className="field">
        <label>遮挡</label>
        <p className="hint" style={{ margin: 0 }}>
          {element.occluded ? '被上层元素覆盖，已标记为需补图。' : '无覆盖，本地色键即可切干净。'}
        </p>
      </div>

      <button className="tiny" onClick={handleDownload} disabled={!slice}>
        下载这张 PNG
      </button>
    </>
  );
}
