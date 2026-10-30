import type { LayoutKind, LayoutNode, NormRect } from '../types';

export const NODE_PRESETS: Record<LayoutKind, { id: string; label: string }[]> = {
  container: [{id:'plain',label:'普通容器'},{id:'dialog',label:'弹窗'},{id:'card',label:'卡片'},{id:'list',label:'列表'}],
  panel: [{id:'plain',label:'普通面板'},{id:'dialog',label:'弹窗'},{id:'card',label:'卡片'},{id:'list',label:'列表'}],
  button: [{id:'plain',label:'普通按钮'},{id:'label',label:'带标题'},{id:'icon-label',label:'标题和图标'}],
  icon: [{id:'plain',label:'普通图标'}],
  text: [{id:'body',label:'普通文本'},{id:'title',label:'标题'}],
  progress: [{id:'horizontal',label:'水平进度'},{id:'vertical',label:'垂直进度'},{id:'radial',label:'扇形进度'}],
  image: [{id:'character',label:'角色立绘'},{id:'decoration',label:'装饰图'},{id:'illustration',label:'插画'},{id:'panel-art',label:'面板装饰'}],
};

export function normalizeHierarchy(nodes: LayoutNode[]): LayoutNode[] {
  return nodes.map(node => {
    if (node.parentId !== undefined) return node;
    const bounds = node.rect;
    const area = bounds.w * bounds.h;
    const containers = nodes.filter(parent => {
      if (parent.id === node.id || (parent.kind !== 'container' && parent.kind !== 'panel')) return false;
      const rect = parent.rect;
      return rect.w * rect.h > area && bounds.x >= rect.x - 0.00001 && bounds.y >= rect.y - 0.00001 &&
        bounds.x + bounds.w <= rect.x + rect.w + 0.00001 && bounds.y + bounds.h <= rect.y + rect.h + 0.00001;
    });
    containers.sort((a,b) => a.rect.w*a.rect.h-b.rect.w*b.rect.h);
    return {...node, parentId: containers[0]?.id ?? null};
  });
}

export function descendantIds(nodes: LayoutNode[], id: string): Set<string> {
  const ids = new Set([id]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const node of nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        expanded = true;
      }
    }
  }
  return ids;
}

export type TreeDropPosition = 'before' | 'after' | 'inside';
export function moveLayoutNode(nodes: LayoutNode[], sourceId: string, targetId: string | null, position: TreeDropPosition): LayoutNode[] {
  const source = nodes.find(node => node.id === sourceId);
  const target = nodes.find(node => node.id === targetId);
  if (!source || (targetId !== null && !target)) return nodes;
  const movingIds = descendantIds(nodes, sourceId);
  if (target && movingIds.has(target.id)) return nodes;
  let parentId: string | null = null;
  if (target) {
    parentId = target.parentId ?? null;
    if (position === 'inside') parentId = target.id;
  }
  if (parentId && movingIds.has(parentId)) return nodes;
  const ordered = orderedLayout(nodes);
  const moving = ordered.filter(node => movingIds.has(node.id)).map(node => node.id === sourceId ? {...node, parentId} : node);
  const remaining = ordered.filter(node => !movingIds.has(node.id));
  let insertion = remaining.length;
  if (target) {
    insertion = remaining.findIndex(node => node.id === target.id);
    if (position !== 'before') {
      const targetIds = descendantIds(remaining, target.id);
      insertion = remaining.reduce((last,node,index) => targetIds.has(node.id) ? index + 1 : last, insertion + 1);
    }
  }
  return [...remaining.slice(0,insertion), ...moving, ...remaining.slice(insertion)];
}

export function orderedLayout(nodes: LayoutNode[]): LayoutNode[] {
  const ordered: LayoutNode[] = [];
  const visited = new Set<string>();
  const visit = (node: LayoutNode) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    ordered.push(node);
    nodes.filter(child => child.parentId === node.id).forEach(visit);
  };
  nodes.filter(node => !node.parentId || !nodes.some(parent => parent.id === node.parentId)).forEach(visit);
  nodes.forEach(visit);
  return ordered;
}

export function transformLayoutGroup(nodes: LayoutNode[], id: string, rect: NormRect): LayoutNode[] {
  const source = nodes.find(node => node.id === id);
  if (!source) return nodes;
  const descendants = descendantIds(nodes, id);
  const scaleX = rect.w / Math.max(source.rect.w, 0.00001);
  const scaleY = rect.h / Math.max(source.rect.h, 0.00001);
  return nodes.map(node => {
    if (node.id === id) return {...node, rect};
    if (!descendants.has(node.id)) return node;
    return {...node, rect: {x: rect.x+(node.rect.x-source.rect.x)*scaleX, y: rect.y+(node.rect.y-source.rect.y)*scaleY,
      w: node.rect.w*scaleX, h: node.rect.h*scaleY}};
  });
}

export function alignmentRect(rect: NormRect, parent: NormRect, alignment: string): NormRect {
  const next = {...rect};
  if (alignment === 'left') next.x = parent.x;
  else if (alignment === 'center') next.x = parent.x+(parent.w-rect.w)/2;
  else if (alignment === 'right') next.x = parent.x+parent.w-rect.w;
  else if (alignment === 'top') next.y = parent.y;
  else if (alignment === 'middle') next.y = parent.y+(parent.h-rect.h)/2;
  else if (alignment === 'bottom') next.y = parent.y+parent.h-rect.h;
  return next;
}
