import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Props = {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  fullScreen?: boolean;
  locked?: boolean;
  onClose: () => void;
  onApply?: () => void;
};

export function StudioDialog({ title, children, actions, fullScreen, locked, onClose, onApply }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  return createPortal(<dialog ref={dialog} aria-label={title}
    className={`studio-dialog ${fullScreen ? 'studio-editor' : 'studio-floating'}`}
    onCancel={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      if (!locked) onClose();
    }}>
    <header className="studio-dialog-header">
      <h1>{title}</h1>
      <div className="studio-dialog-actions">{actions}
        <button className="dialog-close" title={onApply ? '不保存关闭' : '关闭'} disabled={locked} onClick={onClose} aria-label={onApply ? '不保存关闭' : `关闭${title}`}>×</button>
        {onApply && <button className="primary" disabled={locked} onClick={onApply}>保存关闭</button>}
      </div>
    </header>
    {children}
  </dialog>, document.body);
}
