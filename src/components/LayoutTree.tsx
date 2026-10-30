import { useRef, useState, type DragEvent } from 'react';
import type { LayoutKind, LayoutNode } from '../types';
import { kindLabel } from '../lib/layout';
import { descendantIds, moveLayoutNode, type TreeDropPosition } from '../lib/layoutStructure';

const paths: Record<LayoutKind,string> = {
  container:'M3 3h18v18H3z M8 3v18', panel:'M3 4h18v16H3z M3 9h18',
  button:'M5 7h14a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-4a3 3 0 0 1 3-3z',
  icon:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z', text:'M3 5h18 M12 5v16 M8 21h8',
  progress:'M2 7h20v10H2z M7 7v10 M12 7v10', image:'M3 3h18v18H3z M3 18l6-7 4 5 3-3 5 6 M7 7h1',
};
export function NodeIcon({kind}: {kind: LayoutKind}) {
  return <svg className="node-type-icon" viewBox="0 0 24 24" aria-label={kindLabel(kind)} fill="none" stroke="currentColor" strokeWidth={1.6}><path d={paths[kind]} /></svg>;
}
export function LayoutTree({nodes, selectedId, onSelect, onChange, disabled=false}: {
  nodes: LayoutNode[]; selectedId: string | null; onSelect: (id:string|null)=>void;
  onChange: (nodes: LayoutNode[])=>void; disabled?:boolean;
}) {
  const [collapsed,setCollapsed] = useState(new Set<string>());
  const dragging = useRef<string|null>(null);
  const [draggedId,setDraggedId] = useState<string|null>(null);
  const [drop,setDrop] = useState<{id:string;position:TreeDropPosition}|null>(null);
  const clearDrag = () => {dragging.current=null;setDraggedId(null);setDrop(null);};
  const autoScroll = (event:DragEvent<HTMLDivElement>) => {
    if(!dragging.current)return;
    const scroller=event.currentTarget.closest('.layout-node-list');
    if(!scroller)return;
    const bounds=scroller.getBoundingClientRect();
    if(event.clientY<bounds.top+32)scroller.scrollTop-=16;
    else if(event.clientY>bounds.bottom-32)scroller.scrollTop+=16;
  };
  const dropPosition = (event:DragEvent<HTMLDivElement>):TreeDropPosition => {
    const bounds=event.currentTarget.getBoundingClientRect();
    const fraction=(event.clientY-bounds.top)/bounds.height;
    if(fraction>=.25&&fraction<=.75)return 'inside';
    return fraction<.5?'before':'after';
  };
  const canDrop = (node:LayoutNode) => !disabled && !!dragging.current && !descendantIds(nodes,dragging.current).has(node.id);
  const roots = nodes.filter(node => !node.parentId || !nodes.some(parent => parent.id === node.parentId));
  const renderNode = (node: LayoutNode, depth: number, ancestors: Set<string>): React.ReactNode => {
    if (ancestors.has(node.id)) return null;
    const children = nodes.filter(child => child.parentId === node.id);
    const nextAncestors = new Set([...ancestors,node.id]);
    return <div role="treeitem" aria-selected={selectedId===node.id} aria-expanded={children.length ? !collapsed.has(node.id) : undefined} key={node.id}>
      <div className={`layout-tree-row ${selectedId===node.id?'active':''} ${draggedId===node.id?'is-dragging':''} ${drop?.id===node.id?'drop-'+drop.position:''}`}
        data-node-id={node.id} style={{paddingLeft:8+depth*16}} draggable={!disabled}
        onDragStart={event=>{
          if(disabled){event.preventDefault();return;}
          dragging.current=node.id;setDraggedId(node.id);onSelect(node.id);
          event.dataTransfer.setData('application/x-gameui-node',node.id);
          event.dataTransfer.effectAllowed='move';
        }} onDragEnd={clearDrag} onDragOver={event=>{
          autoScroll(event);
          event.stopPropagation();
          if(!canDrop(node)){setDrop(null);event.dataTransfer.dropEffect='none';return;}
          event.preventDefault();event.dataTransfer.dropEffect='move';
          setDrop({id:node.id,position:dropPosition(event)});
        }} onDrop={event=>{
          event.preventDefault();event.stopPropagation();
          const sourceId=dragging.current;
          if(sourceId&&canDrop(node)) {
            const position=dropPosition(event);
            onChange(moveLayoutNode(nodes,sourceId,node.id,position));
            if(position==='inside')setCollapsed(current=>{const next=new Set(current);next.delete(node.id);return next;});
          }
          clearDrag();
        }}>
        {children.length > 0 ? <button className="tree-expander" aria-label={`展开或收起 ${node.name}`} onClick={() => setCollapsed(current => {
          const next=new Set(current);
          if(next.has(node.id)) next.delete(node.id); else next.add(node.id);
          return next;
        })}>{collapsed.has(node.id)?'▸':'▾'}</button> : <span className="tree-expander" aria-hidden="true" />}
        <button className="layout-tree-pick" onClick={() => onSelect(selectedId === node.id ? null : node.id)}><NodeIcon kind={node.kind}/><span>{node.name}</span></button>
      </div>
      {!collapsed.has(node.id) && children.length>0 && <div role="group">{children.map(child=>renderNode(child,depth+1,nextAncestors))}</div>}
    </div>;
  };
  return <div role="tree" aria-label="节点层级" onDragOver={autoScroll}>
    {roots.map(node=>renderNode(node,0,new Set()))}
    {draggedId&&<div className="tree-root-drop" aria-label="拖到根层级" onDragOver={event=>{
      if(disabled)return;
      event.preventDefault();event.dataTransfer.dropEffect='move';setDrop(null);
    }} onDrop={event=>{
      event.preventDefault();
      if(!disabled&&dragging.current)onChange(moveLayoutNode(nodes,dragging.current,null,'after'));
      clearDrag();
    }}>放到根层级</div>}
  </div>;
}
