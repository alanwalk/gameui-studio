import { useEffect, useRef, useState } from 'react';
import type { UiElement } from '../types';
import { createSliceAtlas } from '../lib/sliceAtlas';

export function SliceAtlasPreview({elements}: {elements:UiElement[]}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error,setError] = useState<string | null>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    try {
      const atlas = createSliceAtlas(elements);
      target.width = atlas.width;
      target.height = atlas.height;
      target.getContext('2d')?.drawImage(atlas,0,0);
      setError(null);
    } catch (reason) {
      target.width = 1;
      target.height = 1;
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  },[elements]);
  return <div className="slicer-atlas-preview">{error ? <p className="muted">{error}</p> : null}<canvas ref={canvas} aria-label="切图图集预览" hidden={!!error}/></div>;
}
