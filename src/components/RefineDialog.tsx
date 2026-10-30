import { useRef, useState } from 'react';
import type { ScreenVersion } from '../types';
import type { ProjectRenderTask } from '../lib/projectRenderTypes';
import { imageUrl } from '../lib/magpie';
import { StudioDialog } from './StudioDialog';

type Props = {
  source: ScreenVersion;
  versions: ScreenVersion[];
  tasks: ProjectRenderTask[];
  busy: boolean;
  error: string | null;
  onSubmit: (prompt: string) => Promise<void>;
  onClose: () => void;
  onEditAssets: () => void;
};

export function RefineDialog({ source, versions, tasks, busy, error, onSubmit, onClose, onEditAssets }: Props) {
  const previousVersions = useRef(new Set(versions.map((version) => version.id)));
  const [prompt, setPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const request = useRef(false);
  const result = [...versions].reverse().find((version) => version.parentVersionId === source.id && !previousVersions.current.has(version.id));
  const task = tasks.find((entry) => entry.id === result?.id);
  const pending = task?.status === 'queued' || task?.status === 'running' || task?.status === 'done';

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || pending || request.current || !prompt.trim()) return;
    request.current = true;
    setSubmitting(true);
    try { await onSubmit(prompt.trim()); }
    finally {
      request.current = false;
      setSubmitting(false);
    }
  }

  return <StudioDialog title="微调结果" locked={submitting} onClose={onClose}>
    <form id="refine-submit" className="refine-form" onSubmit={submit}>
      <label>修改要求<textarea autoFocus value={prompt} maxLength={12000} rows={3}
        placeholder="例如：把确认按钮改为金色，保留其他内容" onChange={(event) => setPrompt(event.target.value)} /></label>
    </form>
    <div className="refine-images">
      <figure><figcaption>来源图</figcaption><div><img src={imageUrl(source.image!)} alt="微调来源图" /></div></figure>
      <figure><figcaption>微调结果</figcaption><div>{result?.image ? <img src={imageUrl(result.image)} alt="微调结果图" /> : <span>{pending ? '正在生成，可关闭后继续查看' : '新结果会显示在这里'}</span>}</div></figure>
    </div>
    <footer className="refine-footer">
      {(error || task?.error) && <p className="err" role="alert">{error || task?.error}</p>}
      <button className="primary" form="refine-submit" disabled={busy || submitting || pending || !prompt.trim()} type="submit">
        {pending || submitting ? '微调中…' : '✧ 生成微调版本'}</button>
      {result?.image && <button onClick={onEditAssets}>编辑新结果资源</button>}
    </footer>
  </StudioDialog>;
}
