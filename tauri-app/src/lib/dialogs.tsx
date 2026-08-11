// In-app modal dialogs — replaces window.prompt()/confirm() which render as
// ugly webview "localhost" dialogs and break the desktop-app feel.

import { useEffect, useState } from 'react';

interface PromptSpec {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}

type DialogState =
  | { kind: 'prompt'; spec: PromptSpec; resolve: (value: string | null) => void }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; resolve: (value: boolean) => void }
  | { kind: 'custom'; title: string; body: (close: () => void) => React.ReactNode; resolve: (value: null) => void }
  | null;

let setDialog: (d: DialogState) => void = () => {};

export function showPrompt(spec: PromptSpec): Promise<string | null> {
  return new Promise((resolve) => setDialog({ kind: 'prompt', spec, resolve }));
}

export function showConfirm(title: string, message: string, confirmLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => setDialog({ kind: 'confirm', title, message, confirmLabel, resolve }));
}

export function showCustom(title: string, body: (close: () => void) => React.ReactNode): Promise<null> {
  return new Promise((resolve) => setDialog({ kind: 'custom', title, body, resolve }));
}

export function DialogHost() {
  const [dialog, setDialogState] = useState<DialogState>(null);
  useEffect(() => {
    setDialog = setDialogState;
    return () => { setDialog = () => {}; };
  }, []);

  const close = (value: string | boolean | null) => {
    if (dialog) dialog.resolve(value as never);
    setDialogState(null);
  };

  if (!dialog) return null;
  const isPrompt = dialog.kind === 'prompt';
  const isCustom = dialog.kind === 'custom';

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) close(null); }}>
      <div className="dialog-card" role="dialog" aria-modal="true">
        <div className="dialog-title">{dialog.kind === 'prompt' ? dialog.spec.title : dialog.title}</div>
        {isCustom && dialog.body(() => close(null))}
        {dialog.kind === 'confirm' && <div className="dialog-text">{dialog.message}</div>}
        {isPrompt && (
          <PromptBody spec={dialog.spec} onOk={(v) => close(v)} onCancel={() => close(null)} />
        )}
        {dialog.kind === 'confirm' && (
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={() => close(false)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => close(true)}>{dialog.confirmLabel}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function PromptBody({ spec, onOk, onCancel }: { spec: PromptSpec; onOk: (v: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(spec.initial ?? '');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(value); }
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [value, onOk, onCancel]);

  return (
    <>
      <input
        className="input dialog-input"
        autoFocus
        placeholder={spec.placeholder ?? ''}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <div className="dialog-actions">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onOk(value)}>{spec.confirmLabel ?? 'OK'}</button>
      </div>
    </>
  );
}
