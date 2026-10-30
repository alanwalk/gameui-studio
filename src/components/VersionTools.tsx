import { useState } from 'react';
import type { ScreenVersion } from '../types';
import { versionName, versionSource } from '../lib/versions';

type Props = {
  version: ScreenVersion; versions: ScreenVersion[]; disabled: boolean;
  onSave: (patch: Pick<ScreenVersion, 'name' | 'note'>) => Promise<void>;
  onRefine: (prompt: string) => Promise<void>;
  runAction: (action: Promise<unknown>) => void;
};

export function VersionTools({ version, versions, disabled, onSave, onRefine, runAction }: Props) {
  const [name, setName] = useState(version.name ?? '');
  const [note, setNote] = useState(version.note ?? '');
  const [prompt, setPrompt] = useState('');
  const index = versions.findIndex((entry) => entry.id === version.id);
  return <fieldset className="version-tools" disabled={disabled}>
    <p>{versionSource(version, versions)}</p>
    <form onSubmit={(event) => { event.preventDefault(); runAction(onSave({ name: name.trim(), note })); }}>
      <label>版本名称<input value={name} placeholder={versionName(version, index)} onChange={(event) => setName(event.target.value)} maxLength={120} /></label>
      <label>版本备注<textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={4000} /></label>
      <button type="submit">保存名称和备注</button>
    </form>
    <form onSubmit={(event) => { event.preventDefault(); runAction(onRefine(prompt.trim())); }}>
      <label>基于此版本微调<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="例如：把确认按钮改成金色，其他内容保持" maxLength={12000} /></label>
      <p className="hint">使用当前选定风格和此结果整图生成新版本，保留原图。</p>
      <button type="submit" disabled={!version.image || !prompt.trim()}>生成微调版本</button>
    </form>
  </fieldset>;
}
