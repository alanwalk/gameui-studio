import { imageUrl } from '../lib/magpie';
import type { Project, Style } from '../types';
type Props = {
  activeProject: Project; styles: Style[]; appliedStyleId: string; busy: boolean;
  onApplyStyle: (id: string) => Promise<void>; patchProject: (patch: Partial<Project>) => Promise<void>;
  onUploadStyle: () => void; runAction: (action: Promise<unknown>) => void;
};
export function GenerationStagePanel({
  activeProject,
  styles,
  appliedStyleId,
  busy,
  onApplyStyle,
  patchProject,
  onUploadStyle,
  runAction,
}: Props) {
  return <fieldset className="stage-fields" disabled={busy}>
    <section className="panel">
      <h2>风格</h2>
      <div className="field">
        <label>从风格库应用</label>
        <select
          value={appliedStyleId}
          onChange={(e) => runAction(onApplyStyle(e.target.value))}
          disabled={styles.length === 0}
        >
          <option value="">
            {styles.length === 0 ? '风格库为空' : '选择一套风格…'}
          </option>
          {styles.map((style) => (
            <option key={style.id} value={style.id}>
              {style.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>风格提示词</label>
        <textarea
          rows={3}
          placeholder="例如：冰川题材 RPG，手绘厚涂，冷蓝与暖橙对比，木石材质"
          value={activeProject.stylePrompt}
          onChange={(e) => runAction(patchProject({ stylePrompt: e.target.value }))}
        />
      </div>
      <div className="style-row">
        {activeProject.styleImage ? (
          <img
            className="style-thumb"
            src={imageUrl(activeProject.styleImage)}
            alt="风格参考"
          />
        ) : (
          <span className="style-thumb blank">无参考图</span>
        )}
        <button className="tiny" onClick={onUploadStyle}>
          上传风格图
        </button>
      </div>
    </section>

  </fieldset>;
}
