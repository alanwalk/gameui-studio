import { imageUrl } from '../lib/magpie';
import type { Style } from '../types';

type Props = {
  styles: Style[];
  appliedStyleId: string;
  busy: boolean;
  onApplyStyle: (id: string) => Promise<void>;
  runAction: (action: Promise<unknown>) => void;
};

export function ProjectStyleGallery({ styles, appliedStyleId, busy, onApplyStyle, runAction }: Props) {
  return <section className="panel project-style-gallery-panel" aria-label="项目风格">
    <h2>风格</h2>
    {styles.length === 0
      ? <p className="project-style-empty">风格库暂无风格</p>
      : <ul className="project-style-gallery">
        {styles.map((style) => {
          const selected = style.id === appliedStyleId;
          return <li key={style.id}>
            <button
              type="button"
              className="project-style-card"
              aria-pressed={selected}
              disabled={busy}
              onClick={() => runAction(onApplyStyle(style.id))}
            >
              <span className="project-style-image">
                {style.image
                  ? <img src={imageUrl(style.image)} alt="" />
                  : <span aria-hidden="true">{style.name.slice(0, 1)}</span>}
              </span>
              <span className="project-style-title">{style.name}</span>
            </button>
          </li>;
        })}
      </ul>}
  </section>;
}
