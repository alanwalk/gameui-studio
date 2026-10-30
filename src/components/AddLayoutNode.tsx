import { useRef } from 'react';
import type { LayoutKind } from '../types';
import { LAYOUT_KINDS, kindLabel } from '../lib/layout';
import { NodeIcon } from './LayoutTree';

export function AddLayoutNode({disabled,onAdd}:{disabled:boolean;onAdd:(kind:LayoutKind)=>void}) {
  const menu=useRef<HTMLDetailsElement>(null);
  return <details className="add-layout-node" ref={menu} onKeyDown={event=>{
    if(event.key==='Escape'&&menu.current){menu.current.open=false;menu.current.querySelector('summary')?.focus();}
  }}>
    <summary aria-label="添加节点" title="添加节点">＋</summary>
    <div role="menu" aria-label="节点类型">
      {LAYOUT_KINDS.map(kind=><button role="menuitem" aria-label={kindLabel(kind)} key={kind} disabled={disabled} onClick={()=>{
        if(menu.current)menu.current.open=false;
        onAdd(kind);
      }}><NodeIcon kind={kind}/>{kindLabel(kind)}</button>)}
    </div>
  </details>;
}
