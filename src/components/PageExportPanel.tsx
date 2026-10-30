import { useRef, useState } from 'react';
import type { Project, Settings } from '../types';
import { downloadBlob } from '../lib/export';
import { buildPageExport, PAGE_EXPORT_SIZES, type PageExportOptions } from '../lib/pageExport';
import './PageExportPanel.css';

export type PageExportPanelProps = {
  project: Project;
  currentScreenId?: string;
  settings: Settings;
  busy: boolean;
  onBusyChange: (busy: boolean) => void;
};

export function PageExportPanel({ project, currentScreenId, settings, busy, onBusyChange }: PageExportPanelProps) {
  const [scope, setScope] = useState<PageExportOptions['scope']>('current');
  const [size, setSize] = useState<PageExportOptions['size']>('original');
  const [exporting, setExporting] = useState(false);
  const [report, setReport] = useState('');
  const [error, setError] = useState('');
  const running = useRef(false);
  const disabled = busy || exporting;

  async function exportPages() {
    if (busy || running.current) return;
    running.current = true;
    setExporting(true);
    setReport('');
    setError('');
    onBusyChange(true);
    try {
      const result = await buildPageExport(project, settings, { scope, currentScreenId, size });
      downloadBlob(result.blob, result.fileName);
      setReport(result.report);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      setExporting(false);
      onBusyChange(false);
    }
  }

  return <section className="page-export-panel" aria-label="整页资源导出">
    <h3>整页 / 多界面导出</h3>
    <div className="page-export-controls">
      <label>导出范围
        <select value={scope} disabled={disabled} onChange={(event) => setScope(event.target.value as PageExportOptions['scope'])}>
          <option value="current">当前界面</option>
          <option value="all">项目全部界面（{project.screens.length}）</option>
        </select>
      </label>
      <label>整图分辨率
        <select value={size} disabled={disabled} onChange={(event) => setSize(event.target.value as PageExportOptions['size'])}>
          {Object.keys(PAGE_EXPORT_SIZES).map((preset) => <option key={preset} value={preset}>
            {preset === 'original' ? '原图实际分辨率' : preset.replace('x', ' × ')}
          </option>)}
        </select>
      </label>
      <button type="button" disabled={disabled || (scope === 'current' && !currentScreenId) || !project.screens.length}
        onClick={() => void exportPages()}>{exporting ? '正在导出…' : '导出整页资源 ZIP'}</button>
    </div>
    <p>各界面使用当前版本；无图界面跳过并报告。整图等比居中缩放、透明补边，子图保留原始分辨率。</p>
    <p>仅包含当前版本已保存的素材任务，请先保存素材修改。审核及文本图片开关沿用当前设置。</p>
    {error && <p className="page-export-error" role="alert">{error}</p>}
    {report && <pre className="page-export-report" role="status">{report}</pre>}
  </section>;
}
