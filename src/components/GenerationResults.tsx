import { useState } from 'react';
import { imageUrl } from '../lib/magpie';
import { versionName, versionSource } from '../lib/versions';
import type { ScreenVersion } from '../types';
import './GenerationResults.css';

type Props = { versions: ScreenVersion[]; activeVersion: ScreenVersion | null };

function VersionImage({ version, versions }: { version: ScreenVersion; versions: ScreenVersion[] }) {
  const index = versions.findIndex((entry) => entry.id === version.id);
  const style = version.styleSnapshot;
  return <figure className="version-figure">
    <figcaption><strong>{versionName(version, index)}</strong> · {versionSource(version, versions)}
      <p>{new Date(version.createdAt).toLocaleString()}</p>
      <details><summary>提示词与来源</summary><p>修改/生成要求：{version.prompt || '未记录'}</p>
      <p>风格：{style?.name || style?.prompt || '未记录风格'}{style?.image && <> · <a href={imageUrl(style.image)} target="_blank" rel="noreferrer">风格参考图</a></>}</p>
      {style?.name && style.prompt && <p>风格描述：{style.prompt}</p>}
      {version.note && <p>备注：{version.note}</p>}</details>
    </figcaption>
    {version.image && <a href={imageUrl(version.image)} target="_blank" rel="noreferrer" title="打开整图"><img src={imageUrl(version.image)} alt={versionName(version, index)} /></a>}
  </figure>;
}

export function GenerationResults({ versions, activeVersion }: Props) {
  const [compare, setCompare] = useState(false);
  const [leftId, setLeftId] = useState(activeVersion?.parentVersionId ?? versions[0]?.id ?? '');
  const [rightId, setRightId] = useState(activeVersion?.id ?? '');
  const available = versions.filter((version) => version.image);
  const left = available.find((version) => version.id === leftId) ?? available[0];
  const right = available.find((version) => version.id === rightId) ?? activeVersion ?? available.at(-1);
  if (!activeVersion?.image) {
    if (activeVersion?.operation === 'generate' || activeVersion?.operation === 'refine') {
      return <div className="result-empty"><p>此版本尚未生成成功</p><p>生成状态和恢复操作见上方任务提示；也可以切换已有结果版本。</p></div>;
    }
    return <div className="result-empty"><p>还没有结果图</p><p>调好线稿后点「生成」，或导入结果图。</p></div>;
  }
  const options = available.map((version) => <option key={version.id} value={version.id}>{versionName(version, versions.indexOf(version))}</option>);
  return <div className="generation-results">
    <label><input type="checkbox" checked={compare} disabled={available.length < 2} onChange={(event) => {
      setCompare(event.target.checked);
      setLeftId(activeVersion.parentVersionId ?? available.find((version) => version.id !== activeVersion.id)?.id ?? '');
      setRightId(activeVersion.id);
    }} />对比两个版本（整图）</label>
    {compare && available.length > 1 ? <>
      <div className="version-compare-selectors">
        <label>左侧版本<select value={left?.id ?? ''} onChange={(event) => setLeftId(event.target.value)}>{options}</select></label>
        <label>右侧版本<select value={right?.id ?? ''} onChange={(event) => setRightId(event.target.value)}>{options}</select></label>
      </div>
      <div className="version-compare">{left && <VersionImage version={left} versions={versions} />}{right && <VersionImage version={right} versions={versions} />}</div>
    </> : <VersionImage version={activeVersion} versions={versions} />}
  </div>;
}
