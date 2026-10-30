import { transformLayoutGroup } from '../lib/layoutStructure';
import { PanZoomSurface } from './PanZoomSurface';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayoutKind, LayoutNode, Project, Screen } from '../types';
import {
  Handle,
  applyDrag,
  hitTest,
  kindLabel,
  pickHandle,
  renderWireframe,
} from '../lib/layout';

type Props = {
  disabled?: boolean;
  project: Project;
  screen: Screen;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  onChangeLayout: (nodes: LayoutNode[]) => void;
};

/**
 * The wireframe canvas. Node rects are stored as fractions of the screen, so the canvas
 * is drawn at a fixed working resolution and the pointer maths always converts back into
 * those fractions - resize the window and the layout does not move.
 */
export function LayoutEditor({
  disabled = false,
  project,
  screen,
  selectedNodeId,
  onSelectNode,
  onChangeLayout,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ mode: { handle: Handle; nodeId: string }; startX: number; startY: number; origin: LayoutNode['rect'] } | null>(null);
  const previewRef = useRef<LayoutNode[] | null>(null);
  const [preview, setPreview] = useState<LayoutNode[] | null>(null);
  const displayedLayout = preview ?? screen.layout;

  const width = project.size.w;
  const height = project.size.h;
  const renderScale = Math.min(1, 1600 / Math.max(width, height));
  const size = { w: Math.max(1, Math.round(width * renderScale)), h: Math.max(1, Math.round(height * renderScale)) };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) return;
    const drawW = size.w;
    const drawH = size.h;

    const wire = renderWireframe(displayedLayout, drawW, drawH);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    canvas.width = drawW;
    canvas.height = drawH;
    ctx.clearRect(0, 0, drawW, drawH);
    ctx.drawImage(wire, 0, 0);

    // Selection chrome is drawn here rather than baked into the wireframe, because the
    // wireframe PNG is what gets sent to the image model and must stay clean.
    const selected = displayedLayout.find((node) => node.id === selectedNodeId);
    if (selected) {
      const x = selected.rect.x * drawW;
      const y = selected.rect.y * drawH;
      const w = Math.max(2, selected.rect.w * drawW);
      const h = Math.max(2, selected.rect.h * drawH);
      ctx.strokeStyle = '#6ee7ff';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      for (const [cx, cy] of [
        [x, y],
        [x + w, y],
        [x, y + h],
        [x + w, y + h],
      ]) {
        ctx.fillStyle = '#6ee7ff';
        ctx.fillRect(cx - 4, cy - 4, 8, 8);
      }
    }

  }, [displayedLayout, selectedNodeId, width, height, size.w, size.h]);

  useEffect(() => {
    draw();
  }, [draw]);

  const toNorm = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { px: 0, py: 0 };
    const bounds = canvas.getBoundingClientRect();
    return { px: (event.clientX - bounds.left) * canvas.width / bounds.width,
      py: (event.clientY - bounds.top) * canvas.height / bounds.height };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    if (disabled) return;
    if (size.w <= 0 || size.h <= 0) return;
    const { px, py } = toNorm(event);

    const selected = displayedLayout.find((node) => node.id === selectedNodeId) ?? null;
    if (selected) {
      const handle = pickHandle(selected, px, py, size.w, size.h);
      if (handle !== Handle.None) {
        event.stopPropagation();
        dragRef.current = {
          mode: { handle, nodeId: selected.id },
          startX: px,
          startY: py,
          origin: { ...selected.rect },
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }

    const hit = hitTest(screen.layout, px / size.w, py / size.h);
    onSelectNode(hit ? hit.id : null);

    if (hit) {
      event.stopPropagation();
      dragRef.current = {
        mode: { handle: Handle.Move, nodeId: hit.id },
        startX: px,
        startY: py,
        origin: { ...hit.rect },
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (!drag || size.w <= 0 || size.h <= 0) return;
    const { px, py } = toNorm(event);

    const next = applyDrag(
      drag.origin,
      drag.mode.handle,
      px - drag.startX,
      py - drag.startY,
      size.w,
      size.h,
    );

    const nodes = transformLayoutGroup(screen.layout, drag.mode.nodeId, next);
    previewRef.current = nodes;
    setPreview(nodes);
  };

  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const nodes = previewRef.current;
    dragRef.current = null;
    previewRef.current = null;
    setPreview(null);
    if (nodes && event.type === 'pointerup') onChangeLayout(nodes);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const ratio = `${project.size.w} × ${project.size.h}`;

  return (
    <div className="wire-host">
      <div className="wire-bar">
        <span className="wire-size">{ratio}</span>
        <span className="wire-hint">
          {screen.layout.length} 个元素 · 拖动移动，四角缩放
        </span>
      </div>
      <PanZoomSurface width={size.w} height={size.h} label="线稿无限画布" onBackgroundClick={() => onSelectNode(null)}>
      <canvas
        ref={canvasRef}
        className="wire-canvas"
        style={{ width: size.w, height: size.h, maxWidth: 'none', maxHeight: 'none', margin: 0 }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
      />
      </PanZoomSurface>
      <div className="wire-legend">
        {(['container', 'panel', 'button', 'icon', 'text', 'image', 'progress'] as LayoutKind[]).map(
          (kind) => (
            <span key={kind} className={`legend-item kind-${kind}`}>
              {kindLabel(kind)}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
