import { renderCleanWireframe } from './wireframeRenderer';
import { orderedLayout } from './layoutStructure';
import type { LayoutKind, LayoutNode, NormRect, Project, Screen } from '../types';

/**
 * Wireframe plumbing. A layout is stored as FRACTIONS of the screen so the same
 * wireframe can be rendered at any pixel size and reused across a portrait and a
 * landscape project without rebuilding it.
 */

export const LAYOUT_KINDS: LayoutKind[] = [
  'container',
  'panel',
  'button',
  'icon',
  'text',
  'image',
  'progress',
];

/** Generation resolutions Magpie's image models accept, per orientation. */
export const GENERATION_SIZE: Record<Project['orientation'], string> = {
  portrait: '1024x1536',
  landscape: '1536x1024',
};

export const PROJECT_SIZE: Record<Project['orientation'], { w: number; h: number }> = {
  portrait: { w: 1080, h: 1920 },
  landscape: { w: 1920, h: 1080 },
};

let nodeSeq = 0;

export function newNode(kind: LayoutKind, name?: string): LayoutNode {
  nodeSeq += 1;
  const label = name ?? `${kindLabel(kind)}${nodeSeq}`;
  return {
    id: `n${Date.now().toString(36)}${nodeSeq}`,
    name: label,
    kind,
    rect: { x: 0.1, y: 0.1, w: 0.3, h: 0.12 },
    text: kind === 'text' ? '文本' : undefined,
  };
}

export function newScreen(name: string): Screen {
  return {
    id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    usage: '',
    // A background container is the one node every screen has; users add the rest.
    layout: [
      {
        id: `n${Date.now().toString(36)}bg`,
        name: '背景',
        kind: 'container',
        rect: { x: 0, y: 0, w: 1, h: 1 },
      },
    ],
    versions: [],
  };
}

export function newProject(name: string): Project {
  const now = Date.now();
  return {
    id: `p${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    stylePrompt: '',
    orientation: 'portrait',
    size: PROJECT_SIZE.portrait,
    screens: [newScreen('首页 界面')],
    createdAt: now,
    updatedAt: now,
  };
}

export function pointInRect(px: number, py: number, rect: NormRect): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}

/** Topmost-first hit test; later nodes are drawn on top. */
export function hitTest(nodes: LayoutNode[], px: number, py: number): LayoutNode | null {
  const ordered = orderedLayout(nodes);
  for (let i = ordered.length - 1; i >= 0; i--) {
    const node = ordered[i];
    if (!node) continue;
    if (pointInRect(px, py, node.rect)) return node;
  }
  return null;
}

enum Handle {
  None,
  Move,
  Nw,
  Ne,
  Sw,
  Se,
}

export type DragMode = { handle: Handle; nodeId: string };

const HANDLE_PX = 9;

/** Returns which control the pointer grabbed, in screen pixels. */
export function pickHandle(
  node: LayoutNode,
  px: number,
  py: number,
  vw: number,
  vh: number,
): Handle {
  const x = node.rect.x * vw;
  const y = node.rect.y * vh;
  const w = node.rect.w * vw;
  const h = node.rect.h * vh;
  const near = (ax: number, ay: number) =>
    Math.abs(px - ax) <= HANDLE_PX && Math.abs(py - ay) <= HANDLE_PX;

  if (near(x, y)) return Handle.Nw;
  if (near(x + w, y)) return Handle.Ne;
  if (near(x, y + h)) return Handle.Sw;
  if (near(x + w, y + h)) return Handle.Se;
  if (px >= x && px <= x + w && py >= y && py <= y + h) return Handle.Move;
  return Handle.None;
}

export { Handle };

/**
 * Applies a drag in normalized units. Resizing normalizes from the opposite corner, so
 * dragging the SE handle leaves NW pinned exactly where it was.
 */
export function applyDrag(
  rect: NormRect,
  handle: Handle,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
): NormRect {
  const nx = dx / vw;
  const ny = dy / vh;

  if (handle === Handle.Move) {
    return {
      x: clamp01(rect.x + nx),
      y: clamp01(rect.y + ny),
      w: rect.w,
      h: rect.h,
    };
  }

  let x = rect.x;
  let y = rect.y;
  let w = rect.w;
  let h = rect.h;

  if (handle === Handle.Nw || handle === Handle.Sw) {
    x = rect.x + nx;
    w = rect.w - nx;
  } else if (handle === Handle.Ne || handle === Handle.Se) {
    w = rect.w + nx;
  }

  if (handle === Handle.Nw || handle === Handle.Ne) {
    y = rect.y + ny;
    h = rect.h - ny;
  } else if (handle === Handle.Sw || handle === Handle.Se) {
    h = rect.h + ny;
  }

  // A flipped box is meaningless to an image model, so it is folded back to a positive
  // rect instead of being allowed to invert.
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }

  const min = 0.01;
  w = Math.max(min, w);
  h = Math.max(min, h);

  return {
    x: clamp(x, 0, 1 - w),
    y: clamp(y, 0, 1 - h),
    w,
    h,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

const KIND_LABEL: Record<LayoutKind, string> = {
  container: '容器',
  panel: '面板',
  button: '按钮',
  icon: '图标',
  text: '文本',
  image: '图片',
  progress: '进度条',
};

export function kindLabel(kind: LayoutKind): string {
  return KIND_LABEL[kind] ?? kind;
}

export function renderWireframe(nodes: LayoutNode[], width: number, height: number, opts?: { showNames?: boolean }): HTMLCanvasElement {
  return renderCleanWireframe(nodes, width, height, opts?.showNames ?? false);
}

/**
 * Builds the generation prompt. The wireframe is the layout contract, so the prompt
 * describes the layout in words too - a model that only gets the image still drifts on
 * which block is which.
 */
export function buildGenerationPrompt(project: Project, screen: Screen): string {
  const orientation = project.orientation === 'landscape' ? 'landscape' : 'portrait';
  const lines: string[] = [];

  lines.push(`A complete ${orientation} mobile game UI screen, finished concept art, full screen, no cropping.`);

  if (screen.usage) {
    lines.push(`Screen purpose: ${screen.usage}.`);
  }

  if (project.stylePrompt) {
    lines.push(`Art style: ${project.stylePrompt}.`);
  }

  const named = screen.layout.filter((node) => node.kind !== 'container' || node.rect.w < 1);
  if (named.length > 0) {
    lines.push('Layout from the reference wireframe, which this screen must follow exactly:');
    for (const node of named) {
      const position = describePosition(node.rect);
      const size = `${Math.round(node.rect.w * 100)}% wide by ${Math.round(node.rect.h * 100)}% tall`;
      const settings = JSON.stringify({ parentId: node.parentId, preset: node.preset, icon: node.iconLabel, textPosition: node.textPosition, framed: node.framed, value: node.value, textAlign: node.textAlign, description: node.description });
      lines.push('Node settings for ' + node.name + ': ' + settings);
      const detail = node.text ? ` showing "${node.text}"` : '';
      lines.push(`- ${node.name} (${node.kind}): ${position}, ${size}${detail}.`);
    }
  }

  lines.push('Keep every element in the position and size given by the wireframe.');
  lines.push('Rich game-ready detail, consistent lighting, clean readable text, no UI of any host application.');

  return lines.join(' ');
}

function describePosition(rect: NormRect): string {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const horizontal = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : 'centre';
  const vertical = cy < 0.2 ? 'top' : cy > 0.8 ? 'bottom' : cy < 0.45 ? 'upper' : 'lower';
  if (rect.w >= 0.95 && rect.h >= 0.95) return 'fills the whole screen';
  return `${vertical} ${horizontal}`;
}
