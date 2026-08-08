import { useEffect, useRef } from 'react';

export interface CtxItem {
  label?: string;
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
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onEsc);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onEsc); };
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
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
