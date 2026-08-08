// Tiny toast system — mirrors the old app's window.nt.toast().

import { useEffect, useState } from 'react';

interface ToastItem {
  id: number;
  msg: string;
}

let pushToast: (msg: string) => void = () => {};

export function toast(msg: string) {
  pushToast(msg);
}

export function Toasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    pushToast = (msg: string) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev.slice(-3), { id, msg }]);
      setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 2600);
    };
    return () => { pushToast = () => {}; };
  }, []);
  if (!items.length) return null;
  return (
    <div className="toast-stack">
      {items.map((t) => <div key={t.id} className="toast">{t.msg}</div>)}
    </div>
  );
}
