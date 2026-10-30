export type StudioStage = 'layout' | 'generation' | 'assets';
const stages: { id: StudioStage; label: string }[] = [
  { id: 'layout', label: '1 · 布局' },
  { id: 'generation', label: '2 · 生成' },
  { id: 'assets', label: '3 · 素材' },
];
export function StageTabs({ stage, onChange }: { stage: StudioStage; onChange: (stage: StudioStage) => void }) {
  return <nav className="stage-tabs" aria-label="项目工作阶段">
    {stages.map((entry) => <button key={entry.id} aria-current={stage === entry.id ? 'step' : undefined}
      className={stage === entry.id ? 'active' : ''} onClick={() => onChange(entry.id)}>{entry.label}</button>)}
  </nav>;
}
