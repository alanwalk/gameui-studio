import { useEffect, useRef } from 'react';
import type { UiElement } from '../types';

type Props = {
  elements: UiElement[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
};

function Thumb({ element }: { element: UiElement }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !element.slice) return;
    host.replaceChildren(element.slice.canvas);
  }, [element.slice]);

  return <div className="thumb" ref={hostRef} />;
}

export function ElementList({ elements, selectedId, onSelect, onToggle }: Props) {
  if (elements.length === 0) {
    return (
      <p className="empty">
        还没有元素。
        <br />
        拖入效果图后点「分析页面」，
        <br />
        视觉模型会返回素材清单与坐标。
      </p>
    );
  }

  return (
    <div className="list">
      {elements.map((element) => {
        const dirty = (element.slice?.border.dirtySides.length ?? 0) > 0;
        const className = [
          'card',
          element.id === selectedId ? 'active' : '',
          element.approved ? '' : 'off',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div
            key={element.id}
            className={className}
            onClick={() => onSelect(element.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(element.id);
            }}
          >
            <Thumb element={element} />
            <div className="card-body">
              <div className="card-name">
                T_UI_{element.objectName}
                {element.state ? `_${element.state}` : ''}
              </div>
              <div className="card-meta">
                <span>
                  {element.rect.w}×{element.rect.h}
                </span>
                <span>
                  @{element.rect.x},{element.rect.y}
                </span>
                {element.needsAi && <span className="tag ai">需补图</span>}
                {element.kind === 'text' && <span className="tag text">文字</span>}
                {dirty && <span className="tag dirty">边缘脏</span>}
              </div>
            </div>
            <button
              className="tiny ghost"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(element.id);
              }}
            >
              {element.approved ? '保留' : '跳过'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
