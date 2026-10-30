import type { UiElement } from '../types';
import { imageUrl } from '../lib/magpie';

export function AssetQualityFeedback({ element }: { element: UiElement }) {
  const diagnostics = element.segmentationDiagnostics;
  return <div className="asset-quality-feedback" aria-label="素材质量检查">
    <p className="hint">{element.approved ? '已人工确认，可加入导出。' : '待审核：请检查轮廓、文字、相邻残片与透明边缘。'}</p>
    {(element.coordinateSpace === 'sheet' || element.extractionMethod === 'ai-sheet') &&
      <p className="hint">这张素材来自重绘组件表，坐标属于组件表。可直接编辑素材；放回原界面时需要重新定位。</p>}
    {element.qualityWarnings && element.qualityWarnings.length > 0 && <ul className="hint">
      {element.qualityWarnings.map((message, index) => <li key={index}>{message}</li>)}
    </ul>}
    {element.sourceSheetImage && <a className="hint" href={imageUrl(element.sourceSheetImage)} target="_blank" rel="noreferrer">查看保留的原始组件表</a>}
    {diagnostics && <>
      <p className="hint">{diagnostics.refinement.status === 'applied'
        ? '已精修透明边缘并处理边缘颜色，请在浅底和深底上复核。'
        : diagnostics.refinement.status === 'preserved'
          ? '保留了输入素材已有的透明度，请检查细小装饰。'
          : `当前仅有粗分割，边缘精修未完成：${diagnostics.refinement.reason ?? '精修不可用'}`}</p>
      {diagnostics.quality.issues.length > 0 && <ul className="hint">
        {diagnostics.quality.issues.map((issue, index) => <li key={`${issue.code}-${index}`}>
          {issue.message}
        </li>)}
      </ul>}
      {diagnostics.quality.removedPixels > 0 && <p className="hint">
        已移除 {diagnostics.quality.removedComponents} 处明确位于目标外的碎片，请确认没有误删装饰。
      </p>}
    </>}
  </div>;
}
