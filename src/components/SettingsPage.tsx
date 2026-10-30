import type { Settings } from '../types';
import type { MagpieHealth } from '../lib/magpie';

type Props = {
  settings: Settings;
  models: string[];
  health: MagpieHealth | null;
  onChange: (settings: Settings) => void;
};
export function SettingsPage({ settings, models, health, onChange }: Props) {
  const availableModels = Array.from(new Set([settings.visionModel, ...models]));
  return <main className="settings-page">
    <h1>全局设置</h1>
    <section className="panel">
      <h2>视觉与模型</h2>
      <label className="field">视觉 / 规划模型
        <select value={settings.visionModel} onChange={(event) => onChange({ ...settings, visionModel: event.target.value })}>
          {availableModels.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
      <p className="hint">视觉模型默认推理强度：medium。请求参数由本机服务配置。</p>
      <p>图像生成使用 Magpie 网关配置的图像模型。</p>
      <p className="hint">连接状态：{health?.status ?? '无法连接 Magpie'}。密钥与网关地址由本机服务管理。</p>
    </section>

  </main>;
}
