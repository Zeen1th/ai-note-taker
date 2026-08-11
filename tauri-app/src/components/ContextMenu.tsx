import { useEffect, useRef } from 'react';

export interface CtxItem {
  label?: string;
  icon?: React.ReactNode;
  action?: () => void;
  danger?: boolean;
  sep?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: CtxItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // capture phase: fires before any element's own pointerdown handler, so
    // stopPropagation on nodes/buttons cannot keep the menu open
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('pointerdown', onDown, true); document.removeEventListener('keydown', onEsc); };
  }, [onClose]);

  // keep within viewport
  const left = Math.min(x, window.innerWidth - 200);
  const top = Math.min(y, window.innerHeight - (items.length * 34 + 8));

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top }}>
      {items.map((it, i) => {
        if (it.sep) return <div key={i} className="ctx-sep" />;
        return (
          <button
            key={i}
            className={`ctx-item ${it.danger ? 'danger' : ''}`}
            onClick={() => { it.action?.(); onClose(); }}
          >
            {it.icon && <span className="ctx-icon">{it.icon}</span>}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
