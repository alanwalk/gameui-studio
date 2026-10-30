import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ToastQueue({ message, children }: { message: string | null; children: ReactNode }) {
  const [host] = useState(() => {
    let element = document.getElementById('studio-toasts') as HTMLDivElement | null;
    if (!element) {
      element = document.createElement('div');
      element.id = 'studio-toasts';
      element.className = 'toast-queue';
      element.setAttribute('popover', 'manual');
      element.setAttribute('aria-live', 'polite');
      document.body.appendChild(element);
    }
    return element;
  });
  const sequence = useRef(0);
  const [items, setItems] = useState<{ id: number; message: string }[]>([]);
  useEffect(() => {
    if (!message) return;
    const id = ++sequence.current;
    setItems(current => [...current.slice(-3), { id, message }]);
  }, [message]);
  useEffect(() => {
    if (!items.length) return;
    const timer = setTimeout(() => setItems(current => current.slice(1)), 6000);
    return () => clearTimeout(timer);
  }, [items]);
  useEffect(() => {
    if (host.matches(':popover-open') && document.querySelector('dialog[open]')) host.hidePopover();
    if (!host.matches(':popover-open')) host.showPopover();
  });
  return createPortal(<section className="toast-group">
    {items.map(item => <div className="toast-item" key={item.id}>{item.message}<button className="toast-close" aria-label="关闭提示"
      onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}>×</button></div>)}
    {children}
  </section>, host);
}
