// Software-update flow: titlebar check button → "Update available" dialog with
// changelog → download with progress → install. Powered by tauri-plugin-updater.

import { useCallback, useEffect, useRef, useState } from 'react';
import { check, type Update, type DownloadEvent } from '@tauri-apps/plugin-updater';

export type UpdaterState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'uptodate' }
  | { status: 'available'; current: string; version: string; date?: string; body?: string }
  | { status: 'error'; message: string }
  | { status: 'downloading'; progress: number; total?: number }
  | { status: 'installing' };

export interface Updater {
  state: UpdaterState;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  checkNow: (openIfFound?: boolean) => void;
  install: () => void;
}

export function useUpdater(onToast: (message: string) => void): Updater {
  const [state, setState] = useState<UpdaterState>({ status: 'idle' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const checkingRef = useRef(false);

  const checkNow = useCallback(async (openIfFound = true) => {
    if (checkingRef.current) return;
    if (updateRef.current) {
      if (openIfFound) setDialogOpen(true);
      return;
    }
    checkingRef.current = true;
    setState({ status: 'checking' });
    try {
      const found = await check();
      if (found) {
        updateRef.current = found;
        setState({ status: 'available', current: found.currentVersion, version: found.version, date: found.date, body: found.body });
        if (openIfFound) setDialogOpen(true);
      } else {
        setState({ status: 'uptodate' });
        if (openIfFound) onToast('You are up to date — no updates available.');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ status: 'error', message: msg });
      if (openIfFound) onToast('Update check failed: ' + msg);
    } finally {
      checkingRef.current = false;
    }
  }, [onToast]);

  const install = useCallback(async () => {
    const u = updateRef.current;
    if (!u) return;
    setState({ status: 'downloading', progress: 0 });
    try {
      await u.downloadAndInstall((ev: DownloadEvent) => {
        if (ev.event === 'Started') {
          setState({ status: 'downloading', progress: 0, total: ev.data.contentLength });
        } else if (ev.event === 'Progress') {
          setState((s) =>
            s.status === 'downloading' ? { ...s, progress: s.progress + ev.data.chunkLength } : s,
          );
        } else if (ev.event === 'Finished') {
          setState({ status: 'installing' });
        }
      });
      setDialogOpen(false);
      onToast('Update installed — the app will restart.');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setState({ status: 'error', message: msg });
      onToast('Update failed: ' + msg);
    }
  }, [onToast]);

  // silently check once at startup so the titlebar can show an "update available" badge
  useEffect(() => { checkNow(false); }, [checkNow]);

  return {
    state,
    dialogOpen,
    openDialog: () => setDialogOpen(true),
    closeDialog: () => setDialogOpen(false),
    checkNow,
    install,
  };
}

export function UpdateModal({ updater }: { updater: Updater }) {
  const { state, dialogOpen, closeDialog, install } = updater;
  if (!dialogOpen) return null;

  const pct =
    state.status === 'downloading' && state.total
      ? Math.min(100, Math.round((state.progress / state.total) * 100))
      : null;
  const busy = state.status === 'downloading' || state.status === 'installing';

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) closeDialog(); }}>
      <div className="dialog-card update-card" role="dialog" aria-modal="true">
        {state.status === 'available' && (
          <>
            <div className="update-head">
              <svg className="update-head-icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" />
              </svg>
              <div>
                <div className="dialog-title">Update available</div>
                <div className="update-versions">
                  v{state.current} <span className="update-arrow-sep">→</span> v{state.version}
                  {state.date ? ` · ${new Date(state.date).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}` : ''}
                </div>
              </div>
            </div>
            <div className="update-changelog">{state.body || 'No changelog available for this release.'}</div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={closeDialog}>Not now</button>
              <button className="btn btn-primary update-cta" onClick={install}>
                Update now
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              </button>
            </div>
          </>
        )}

        {(state.status === 'downloading' || state.status === 'installing') && (
          <>
            <div className="dialog-title">{state.status === 'installing' ? 'Installing update…' : 'Downloading update…'}</div>
            {state.status === 'downloading' && (
              <div className="update-progress">
                <div className="update-progress-bar" style={{ width: pct !== null ? `${pct}%` : '0%' }} />
              </div>
            )}
            <div className="update-progress-label">
              {state.status === 'downloading' ? (pct !== null ? `${pct}%` : 'Starting…') : 'The app will restart automatically.'}
            </div>
          </>
        )}

        {state.status === 'error' && (
          <>
            <div className="dialog-title">Update failed</div>
            <div className="dialog-text">{state.message}</div>
            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={closeDialog}>Close</button>
              <button className="btn btn-primary" onClick={() => { closeDialog(); updater.checkNow(true); }}>Try again</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
