import { NodeProperties } from './NodeProperties';
import { useEffect, useRef, useState } from 'react';
import { kindLabel } from '../lib/layout';
import { analyzeLayoutReference, decodeLayoutReference, DEFAULT_LAYOUT_VISION_MODEL } from '../lib/layoutReference';
import type { LayoutReferencePreview } from '../lib/layoutReference';
import { imageUrl } from '../lib/magpie';
import './layout-tools.css';
import type { LayoutNode, Screen } from '../types';
type Props = {
  visionModel?: string;
  activeScreen: Screen; selectedNode: LayoutNode | null;
  busy: boolean; operation: string; setSelectedNodeId: (id: string | null) => void;
  patchScreen: (patch: Partial<Screen>) => Promise<void>;
  onPlanLayout: () => Promise<void>;
  onPatchNode: (patch: Partial<LayoutNode>) => Promise<void>; onDeleteNode: () => Promise<void>;
  runAction: (action: Promise<unknown>) => void;
};
export function LayoutStagePanel({
  activeScreen,
  selectedNode,
  busy,
  operation,
  setSelectedNodeId,
  patchScreen,
  onPlanLayout,
  onPatchNode,
  onDeleteNode,
  runAction,
  visionModel = DEFAULT_LAYOUT_VISION_MODEL,
}: Props) {
  const owner = useRef({ screenId: activeScreen.id, generation: 0, mounted: true });
  if (owner.current.screenId !== activeScreen.id) {
    owner.current = { screenId: activeScreen.id, generation: owner.current.generation + 1, mounted: true };
  }
  const [reference, setReference] = useState<{ generation: number; preview: LayoutReferencePreview } | null>(null);
  const [analyzing, setAnalyzing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ generation: number; message: string } | null>(null);
  useEffect(() => {
    owner.current.mounted = true;
    return () => { owner.current.mounted = false; owner.current.generation += 1; };
  }, []);
  const generation = owner.current.generation;
  const preview = reference?.generation === generation ? reference.preview : null;
  const analyzingHere = analyzing === generation;

  const saveLayout = async (layout: LayoutNode[], sourceImage?: string) => {
    if (busy || saving) return;
    if (activeScreen.layout.length > 0 && !window.confirm('将替换当前全部布局节点，之后可通过撤销恢复。确定继续？')) return;
    const saveGeneration = owner.current.generation;
    setSaving(true);
    setError(null);
    try {
      const patch: Partial<Screen> = { layout, layoutReferenceImage: sourceImage };
      await patchScreen(patch);
      if (!owner.current.mounted || owner.current.generation !== saveGeneration) return;
      setSelectedNodeId(null);
      setReference(null);
    } catch (reason) {
      if (owner.current.mounted && owner.current.generation === saveGeneration) {
        setError({ generation: saveGeneration, message: String(reason) });
      }
    } finally {
      if (owner.current.mounted) setSaving(false);
    }
  };

  const importReference = async (file: File) => {
    const requestGeneration = ++owner.current.generation;
    const isCurrent = () => owner.current.mounted && owner.current.generation === requestGeneration;
    setAnalyzing(requestGeneration);
    setReference(null);
    setError(null);
    try {
      const image = await decodeLayoutReference(file);
      if (!isCurrent()) return;
      const result = await analyzeLayoutReference(image.dataUrl, image.width, image.height, visionModel, isCurrent);
      if (result && isCurrent()) setReference({ generation: requestGeneration, preview: result });
    } catch (reason) {
      if (isCurrent()) setError({ generation: requestGeneration, message: String(reason) });
    } finally {
      if (isCurrent()) setAnalyzing(null);
    }
  };

  if (selectedNode) return <fieldset className="stage-fields" disabled={busy || saving}>
    <NodeProperties node={selectedNode} screen={activeScreen} disabled={busy || saving}
      onPatch={patch=>runAction(onPatchNode(patch))} onDelete={()=>runAction(onDeleteNode())}/>
  </fieldset>;

  return <fieldset className="stage-fields" disabled={busy || saving}>
    <section className="panel layout-tools">
      <h2>参考图分析</h2>
      <label className="layout-reference-picker">{analyzingHere ? '识别中…仍可编辑当前布局' : '选择本地参考图'}
        <input type="file" accept="image/*" disabled={analyzingHere}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void importReference(file);
          }} />
      </label>
      {preview && <div className="layout-reference-result">
        <div className="layout-reference-preview" style={{ aspectRatio: `${preview.width} / ${preview.height}`, maxWidth: 260 * preview.width / preview.height }}>
          <img src={imageUrl(preview.sourceImage)} alt="待应用的布局参考图" />
          {preview.nodes.map((node) => <span key={node.id} title={`${node.name} · ${kindLabel(node.kind)}`}
            style={{ left: `${node.rect.x * 100}%`, top: `${node.rect.y * 100}%`, width: `${node.rect.w * 100}%`, height: `${node.rect.h * 100}%` }} />)}
        </div>
        <p>已识别 {preview.nodes.length} 个节点 · {preview.width} × {preview.height}；应用前可继续编辑。</p>
        <ul>{preview.nodes.map((node) => <li key={node.id}>{node.name} · {kindLabel(node.kind)}</li>)}</ul>
        <div className="btn-row">
          <button className="primary" onClick={() => void saveLayout(preview.nodes, preview.sourceImage)}>应用识别布局</button>
          <button className="ghost" onClick={() => setReference(null)}>放弃预览</button>
        </div>
      </div>}
      {error?.generation === generation && <p role="alert" className="err">{error.message}</p>}
    </section>
    <section className="panel">
      <h2>界面用途</h2>
      <div className="field">
        <textarea
          rows={3}
          placeholder="例如：主界面，顶部货币栏，中部角色立绘，底部功能按钮"
          value={activeScreen.usage}
          onChange={(e) => runAction(patchScreen({ usage: e.target.value }))}
        />
      </div>
      <div className="btn-row">
        <button className="ghost" onClick={() => runAction(onPlanLayout())} disabled={busy}>
          {operation === 'plan' ? '规划中…' : 'AI 规划线稿'}
        </button>
        <button className="ghost danger" disabled={busy || activeScreen.layout.length === 0} onClick={()=>void saveLayout([])}>清空线稿</button>
      </div>
    </section>


  </fieldset>;
}
