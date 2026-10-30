import type { LayoutNode, Screen } from '../types';
import { LAYOUT_KINDS, kindLabel } from '../lib/layout';
import { alignmentRect, NODE_PRESETS } from '../lib/layoutStructure';
import { NodeIcon } from './LayoutTree';

export function NodeProperties({node,screen,onPatch,onDelete,disabled}: {
  node: LayoutNode;screen:Screen;onPatch:(patch:Partial<LayoutNode>)=>void;onDelete:()=>void;disabled:boolean;
}) {
  const parent=screen.layout.find(parent=>parent.id===node.parentId);
  const alignments=[['left','左对齐'],['center','水平居中'],['right','右对齐'],['top','顶对齐'],['middle','垂直居中'],['bottom','底对齐']];
  return <fieldset className="node-properties" disabled={disabled}>
    <h2>{kindLabel(node.kind)}</h2>
    <label>名称<input value={node.name} onChange={event=>onPatch({name:event.target.value})}/></label>
    <div className="node-kind-options">{LAYOUT_KINDS.map(kind=><button key={kind} className={node.kind===kind?'active':''}
      onClick={()=>onPatch({kind,preset:NODE_PRESETS[kind][0].id})}><NodeIcon kind={kind}/>{kindLabel(kind)}</button>)}</div>
    <label>预设效果<select aria-label="节点预设" value={node.preset??NODE_PRESETS[node.kind][0].id} onChange={event=>onPatch({preset:event.target.value})}>
      {NODE_PRESETS[node.kind].map(preset=><option key={preset.id} value={preset.id}>{preset.label}</option>)}
    </select></label>
    {node.kind!=='image'&&node.kind!=='progress'&&<label>文字<input value={node.text??''} onChange={event=>onPatch({text:event.target.value})}/></label>}
    {(node.kind==='icon'||node.kind==='button')&&<label>图标描述<input value={node.iconLabel??''} onChange={event=>onPatch({iconLabel:event.target.value})}/></label>}
    {node.kind==='icon'&&<>
      <label><input type="checkbox" checked={!!node.framed} onChange={event=>onPatch({framed:event.target.checked})}/>带底框</label>
      <label>文字位置<select value={node.textPosition??'bottom'} onChange={event=>onPatch({textPosition:event.target.value as LayoutNode['textPosition']})}>
        <option value="bottom">底部标题</option><option value="above">顶部标题</option><option value="corner">右下数量</option><option value="right">右侧标签</option>
      </select></label>
    </>}
    {node.kind==='text'&&<label>文字对齐<select value={node.textAlign??'center'} onChange={event=>onPatch({textAlign:event.target.value as LayoutNode['textAlign']})}>
      <option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option>
    </select></label>}
    {node.kind==='progress'&&<label>进度 {node.value??50}%<input type="range" min={0} max={100} value={node.value??50} onChange={event=>onPatch({value:Number(event.target.value)})}/></label>}
    {node.kind==='image'&&<label>原画描述<textarea value={node.description??''} onChange={event=>onPatch({description:event.target.value})}/></label>}
    <div className="node-alignments">{alignments.map(([alignment,label])=><button key={alignment} onClick={()=>onPatch({rect:alignmentRect(node.rect,parent?.rect??{x:0,y:0,w:1,h:1},alignment)})}>{label}</button>)}</div>
    <div className="grid4">{(['x','y','w','h'] as const).map(key=><label key={key}>{key}<input aria-label={`节点${key}`} type="number" step={.01} min={0} max={1} value={Math.round(node.rect[key]*1000)/1000}
      onChange={event=>{
        const value=Number(event.target.value);
        if(!Number.isFinite(value))return;
        const rect={...node.rect,[key]:Math.max(0,Math.min(1,value))};
        rect.w=Math.max(.001,Math.min(rect.w,1-rect.x));
    rect.h=Math.max(.001,Math.min(rect.h,1-rect.y));
        onPatch({rect});
      }}/></label>)}</div>
    <button className="danger" onClick={onDelete}>删除节点</button>
  </fieldset>;
}
