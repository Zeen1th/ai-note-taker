import { useEffect, useState } from 'react';
import { getSidecarUrl } from '../lib/tauri';

interface SettingsProps {
  palette: string;
  theme: string;
  onPalette: (p: string) => void;
  onTheme: (t: string) => void;
}

interface StatusInfo {
  whisper_model?: string;
  whisper_device?: string;
  cuda?: boolean;
  diarization?: boolean;
  diarize_error?: string | null;
  ollama?: boolean;
}

const PALETTES = ['notebook', 'blueprint', 'aurora'];
const PALETTE_NAMES: Record<string, string> = { notebook: 'Notebook', blueprint: 'Blueprint', aurora: 'Aurora' };
const MODEL_OPTIONS = ['large-v3-turbo', 'medium', 'small', 'base'];

function Toggle({ id, defaultOn = false, onLabel }: { id: string; defaultOn?: boolean; onLabel?: string }) {
  const [on, setOn] = useState<boolean>(() => {
    const saved = localStorage.getItem('nt-set-' + id);
    return saved !== null ? saved === 'true' : defaultOn;
  });
  useEffect(() => {
    localStorage.setItem('nt-set-' + id, on ? 'true' : 'false');
  }, [id, on]);
  return (
    <button
      className="toggle"
      role="switch"
      aria-checked={on}
      aria-label={onLabel || id}
      onClick={() => setOn(!on)}
    />
  );
}

export function Settings({ palette, theme, onPalette, onTheme }: SettingsProps) {
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [exportNote, setExportNote] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const baseUrl = await getSidecarUrl();
        const res = await fetch(`${baseUrl}/api/status`);
        if (res.ok) {
          const s = await res.json();
          if (!cancelled) setStatus(s);
        }
      } catch {
        /* sidecar not available — leave status null */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const model = status?.whisper_model || '';
  const modelDesc = status
    ? `Whisper on ${status.whisper_device || 'cpu'}${status.cuda ? ' (CUDA available)' : ''}. Set via WHISPER_MODEL / .env.`
    : 'Querying the AI engine…';
  const diarizeOn = !!status?.diarization;
  const diarizeDesc = status
    ? (status.diarization
        ? 'Available — identifies who said what.'
        : (status.diarize_error || 'Not configured. Set HF_TOKEN to enable.'))
    : 'Querying the AI engine…';

  return (
    <div className="set-wrap">
      <h1 className="h-headline">Settings</h1>
      <p className="set-intro">
        Appearance, capture behaviour, and storage. The AI engine is optional — a modest corner, on by default only if you turn it on.
      </p>

      <div className="set-group">
        <span className="eyebrow">Appearance</span>
        <div className="card">
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Palette</div>
              <div className="setting-desc">Notebook, blueprint, or aurora — your app's own look.</div>
            </div>
            <select className="select" style={{ width: 170 }} value={palette} onChange={(e) => onPalette(e.target.value)}>
              {PALETTES.map((p) => <option key={p} value={p}>{PALETTE_NAMES[p]}</option>)}
            </select>
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Theme</div>
              <div className="setting-desc">Dark by default; switch to light for bright rooms.</div>
            </div>
            <select className="select" style={{ width: 170 }} value={theme} onChange={(e) => onTheme(e.target.value)}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Density</div>
              <div className="setting-desc">Tighter list rows for more on screen.</div>
            </div>
            <Toggle id="setDensity" />
          </div>
        </div>
      </div>

      <div className="set-group">
        <span className="eyebrow">Capture</span>
        <div className="card">
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Record with system audio</div>
              <div className="setting-desc">Mix microphone and desktop audio into one file.</div>
            </div>
            <Toggle id="setSystem" defaultOn />
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Auto-transcribe on import</div>
              <div className="setting-desc">Run transcription immediately when you import a file.</div>
            </div>
            <Toggle id="setAuto" defaultOn />
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Audio format</div>
              <div className="setting-desc">Container used for new recordings.</div>
            </div>
            <select className="select" style={{ width: 150 }}>
              <option>webm</option>
              <option>m4a</option>
              <option>wav</option>
            </select>
          </div>
        </div>
      </div>

      <div className="set-group">
        <span className="eyebrow">AI engine · optional</span>
        <div className="card">
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Enable AI notes</div>
              <div className="setting-desc">Summaries and chat over transcripts, generated locally via Ollama. Off by default.</div>
            </div>
            <Toggle id="setAI" defaultOn />
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Transcription model</div>
              <div className="setting-desc" id="modelDesc">{modelDesc}</div>
            </div>
            <select className="select" style={{ width: 170 }} value={model} disabled>
              {!MODEL_OPTIONS.includes(model) && model && <option>{model}</option>}
              {MODEL_OPTIONS.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Speaker diarisation</div>
              <div className="setting-desc">{diarizeDesc}</div>
            </div>
            <button className="toggle" role="switch" aria-checked={diarizeOn} aria-label="Diarisation" onClick={() => {}} />
          </div>
        </div>
      </div>

      <div className="set-group">
        <span className="eyebrow">Storage</span>
        <div className="card">
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Data location</div>
              <div className="setting-desc">SQLite database and audio files live on this machine. Nothing is uploaded.</div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => setExportNote('Export arrives with the sessions library.')}>
              Export
            </button>
          </div>
          {exportNote && (
            <div className="setting-row">
              <div className="grow">
                <div className="setting-desc">{exportNote}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
