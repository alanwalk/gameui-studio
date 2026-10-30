import { useEffect, useRef } from 'react';
import type { Rect, UiElement } from '../types';

type Props = {
  image: HTMLImageElement | null;
  elements: UiElement[];
  selectedId: string | null;
  holes: Array<Rect & { area: number }>;
  showBoxes: boolean;
  onSelect: (id: string | null) => void;
};

const KIND_COLOR: Record<string, string> = {
  panel: '#00ff5a',
  button: '#ffb020',
  icon: '#8fb0ff',
  text: '#ff5470',
  progress: '#c58bff',
  frame: '#4ad6c0',
  decor: '#7d8f8a',
};

/**
 * Draws the source image with every detected box on top, plus the uncovered holes the
 * coverage audit found. Clicking a box selects it, so review stays visual instead of
 * being a scroll through filenames.
 */
export function Stage({ image, elements, selectedId, holes, showBoxes, onSelect }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<{ scale: number; ox: number; oy: number }>({
    scale: 1,
    ox: 0,
    oy: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box || !image) return;

    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const availW = box.clientWidth;
    const availH = box.clientHeight;
    if (availW <= 0 || availH <= 0) return;

    const scale = Math.min(availW / width, availH / height, 1);
    const drawW = Math.round(width * scale);
    const drawH = Math.round(height * scale);

    const dpr = window.devicePixelRatio || 1;
    canvas.width = drawW * dpr;
    canvas.height = drawH * dpr;
    canvas.style.width = `${drawW}px`;
    canvas.style.height = `${drawH}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, drawW, drawH);
    ctx.drawImage(image, 0, 0, drawW, drawH);

    layoutRef.current = { scale, ox: 0, oy: 0 };

    if (showBoxes) {
      for (const hole of holes) {
        ctx.fillStyle = 'rgba(255, 84, 112, 0.16)';
        ctx.fillRect(
          hole.x * scale,
          hole.y * scale,
          Math.max(2, hole.w * scale),
          Math.max(2, hole.h * scale),
        );
        ctx.strokeStyle = 'rgba(255, 84, 112, 0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(
          hole.x * scale,
          hole.y * scale,
          Math.max(2, hole.w * scale),
          Math.max(2, hole.h * scale),
        );
      }

      for (const element of elements) {
        if (!element.approved) continue;
        const selected = element.id === selectedId;
        const color = KIND_COLOR[element.kind] ?? '#00ff5a';
        ctx.strokeStyle = selected ? '#ffffff' : color;
        ctx.lineWidth = selected ? 2.5 : 1.2;
        const x = element.rect.x * scale;
        const y = element.rect.y * scale;
        const w = element.rect.w * scale;
        const h = element.rect.h * scale;
        ctx.strokeRect(x, y, w, h);

        if (selected) {
          ctx.fillStyle = 'rgba(255, 255, 255, 0.09)';
          ctx.fillRect(x, y, w, h);
        }

        ctx.fillStyle = color;
        ctx.font = '600 10px "JetBrains Mono", monospace';
        const text = `${element.objectName}${element.state ? ` ${element.state}` : ''}`;
        const textY = y > 12 ? y - 3 : y + h + 11;
        ctx.fillText(text, x, textY);
      }
    }
  }, [image, elements, selectedId, holes, showBoxes]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!image || elements.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = (event.clientX - rect.left) / layoutRef.current.scale;
    const py = (event.clientY - rect.top) / layoutRef.current.scale;

    // Topmost first: a click inside nested boxes should pick the smaller one.
    const sorted = [...elements].sort((a, b) => b.layer - a.layer);
    for (const element of sorted) {
      const { x, y, w, h } = element.rect;
      if (px >= x && px <= x + w && py >= y && py <= y + h) {
        onSelect(element.id);
        return;
      }
    }
    onSelect(null);
  };

  return (
    <div className="stage" ref={boxRef}>
      <canvas ref={canvasRef} onClick={handleClick} />
    </div>
  );
}
