import { useEffect, useState } from 'react';
import { getSidecarUrl } from '../lib/tauri';
import { getAiCfg, getAskNotes, setAiCfg, type AiCfg } from '../lib/ai';

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
  ollama_model?: string;
  ollama_models?: string[];
  ollama_sizes?: Record<string, number>;
  ollama_smallest?: string;
  whisperx_available?: boolean;
  ollama_available?: boolean;
  install_hint?: string | null;
}

const PALETTES = ['notebook', 'blueprint', 'aurora'];
const PALETTE_NAMES: Record<string, string> = { notebook: 'Notebook', blueprint: 'Blueprint', aurora: 'Aurora' };
const MODEL_OPTIONS = ['large-v3-turbo', 'medium', 'small', 'base'];

function Toggle({ id, defaultOn = false, onLabel, store }: { id: string; defaultOn?: boolean; onLabel?: string; store?: string }) {
  const key = store || 'nt-set-' + id;
  const [on, setOn] = useState<boolean>(() => {
    const saved = localStorage.getItem(key);
    return saved !== null ? saved === 'true' : defaultOn;
  });
  useEffect(() => {
    localStorage.setItem(key, on ? 'true' : 'false');
  }, [key, on]);
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
  const [aiCfg, setCfg] = useState<AiCfg>(() => getAiCfg());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

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

  const saveCfg = (patch: Partial<AiCfg>) => {
    const next: AiCfg = { ...getAiCfg(), ...patch };
    setAiCfg(next);
    setCfg(next);
    setTestResult(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const baseUrl = await getSidecarUrl();
      const res = await fetch(`${baseUrl}/api/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cfg: aiCfg }),
      });
      const d = await res.json().catch(() => ({}));
      setTestResult({
        ok: !!d.ok,
        text: d.ok ? `Connected — model replied: ${d.reply}` : (d.error || `Failed (${res.status})`),
      });
    } catch (err: any) {
      setTestResult({ ok: false, text: String(err.message || err) });
    } finally {
      setTesting(false);
    }
  };

  const local = aiCfg.provider === 'local';
  const whisperxOk = status?.whisperx_available ?? false;
  const ollamaOk = status?.ollama_available ?? false;
  const ollamaModels = status?.ollama_models?.length
    ? status.ollama_models
    : (status?.ollama_model && ollamaOk ? [status.ollama_model] : []);
  const sizes = status?.ollama_sizes || {};
  const smallest = status?.ollama_smallest || (ollamaModels.length ? ollamaModels[0] : '');
  const fmtSize = (n: string) => {
    const b = sizes[n];
    return b ? ` · ${(b / 1e9).toFixed(1)} GB` : '';
  };
  const chatModel = aiCfg.llm_model && ollamaModels.includes(aiCfg.llm_model) ? aiCfg.llm_model : '';
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
              <div className="setting-desc">Summaries and chat over transcripts and boards. Off by default.</div>
            </div>
            <Toggle id="setAI" defaultOn />
          </div>
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Provider</div>
              <div className="setting-desc">Transcription always runs locally (WhisperX on your GPU). The provider only powers notes and chat — Local uses Ollama, API mode uses any OpenAI-compatible service (OpenAI, Groq, OpenRouter…).</div>
            </div>
            <select className="select" style={{ width: 240 }} value={aiCfg.provider} onChange={(e) => saveCfg({ provider: e.target.value as AiCfg['provider'] })}>
              <option value="local">Local (Ollama + WhisperX)</option>
              <option value="api">API key (OpenAI-compatible)</option>
            </select>
          </div>
          {!local && (
            <>
              <div className="setting-row">
                <div className="grow">
                  <div className="setting-label">Base URL</div>
                  <div className="setting-desc">The /v1 endpoint of your provider.</div>
                </div>
                <input
                  className="input" style={{ width: 280 }} type="text" spellCheck={false}
                  value={aiCfg.api_base}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => setCfg({ ...aiCfg, api_base: e.target.value })}
                  onBlur={() => saveCfg({ api_base: aiCfg.api_base })}
                />
              </div>
              <div className="setting-row">
                <div className="grow">
                  <div className="setting-label">API key</div>
                  <div className="setting-desc">Stored in this app only, sent to your provider.</div>
                </div>
                <input
                  className="input" style={{ width: 280 }} type="password" spellCheck={false}
                  value={aiCfg.api_key}
                  placeholder="sk-…"
                  onChange={(e) => setCfg({ ...aiCfg, api_key: e.target.value })}
                  onBlur={() => saveCfg({ api_key: aiCfg.api_key })}
                />
              </div>
              <div className="setting-row">
                <div className="grow">
                  <div className="setting-label">Chat model</div>
                  <div className="setting-desc">Notes and chat answers. e.g. gpt-4o-mini, llama-3.3-70b-versatile.</div>
                </div>
                <input
                  className="input" style={{ width: 280 }} type="text" spellCheck={false}
                  value={aiCfg.llm_model}
                  placeholder="gpt-4o-mini"
                  onChange={(e) => setCfg({ ...aiCfg, llm_model: e.target.value })}
                  onBlur={() => saveCfg({ llm_model: aiCfg.llm_model })}
                />
              </div>
            </>
          )}
          <div className="setting-row">
            <div className="grow">
              <div className="setting-label">Connection test</div>
              <div className="setting-desc">
                {testing
                  ? 'Testing…'
                  : testResult
                    ? (testResult.ok ? '✓ ' + testResult.text : '✗ ' + testResult.text)
                    : 'Verifies the provider works before you rely on it.'}
              </div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={runTest} disabled={testing}>
              {testing ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          {status && !whisperxOk && (
            <div className="setting-row">
              <div className="grow">
                <div className="setting-label">WhisperX engine</div>
                <div className="setting-desc">✗ Not installed — transcribing won't work (transcription is always local). Install with:
                  <code style={{ display: 'block', marginTop: 4 }}>python -m pip install -r src-tauri/python/requirements.txt</code>
                  or switch to API mode above.
                </div>
              </div>
            </div>
          )}
          {local && status && !ollamaOk && (
            <div className="setting-row">
              <div className="grow">
                <div className="setting-label">Ollama engine</div>
                <div className="setting-desc">✗ Not available — AI notes and chat won't work. Start Ollama on localhost:11434 (and pull a model with `ollama pull &lt;model&gt;`), or switch to API mode.</div>
              </div>
            </div>
          )}
          {local && (
            <>
              <div className="setting-row">
                <div className="grow">
                  <div className="setting-label">Transcription model</div>
                  <div className="setting-desc" id="modelDesc">{modelDesc}</div>
                </div>
                <select className="select" style={{ width: 170 }} value={status?.whisper_model || ''} disabled>
                  {!MODEL_OPTIONS.includes(status?.whisper_model || '') && status?.whisper_model && <option>{status.whisper_model}</option>}
                  {MODEL_OPTIONS.map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
              <div className="setting-row">
                <div className="grow">
                  <div className="setting-label">Chat model</div>
                  <div className="setting-desc">
                    {ollamaModels.length
                      ? (chatModel
                          ? 'Pulled on this machine — used for notes and chat.'
                          : `Auto — the smallest installed model (${smallest}) is used until you pick one.`)
                      : 'No Ollama models found — start Ollama or run `ollama pull <model>`.'}
                  </div>
                </div>
                <select
                  className="select" style={{ width: 230 }}
                  value={chatModel}
                  disabled={ollamaModels.length === 0}
                  onChange={(e) => saveCfg({ llm_model: e.target.value })}
                >
                  {ollamaModels.length === 0 && <option value="">— none —</option>}
                  {ollamaModels.length > 0 && <option value="">Auto — smallest ({smallest})</option>}
                  {ollamaModels.map((m) => <option key={m} value={m}>{m}{fmtSize(m)}</option>)}
                </select>
              </div>
              <div className="setting-row">
                <div className="grow">
                  <div className="setting-label">Ask which model for notes</div>
                  <div className="setting-desc">Shows a model picker after each transcription. Off = always use the selected model.</div>
                </div>
                <Toggle id="setAskModel" store="nt-ai-ask-notes" defaultOn={getAskNotes()} />
              </div>
              <div className="setting-row">
                <div className="grow">
                  <div className="setting-label">Speaker diarisation</div>
                  <div className="setting-desc">{diarizeDesc}</div>
                </div>
                <button className="toggle" role="switch" aria-checked={diarizeOn} aria-label="Diarisation" onClick={() => {}} />
              </div>
            </>
          )}
          {!local && (
            <div className="setting-row">
              <div className="grow">
                <div className="setting-label">Local engines</div>
                <div className="setting-desc">Not needed in API mode — everything runs through your endpoint. WhisperX installed: {whisperxOk ? 'yes' : 'no'} · Ollama installed: {ollamaOk ? 'yes' : 'no'}</div>
              </div>
            </div>
          )}
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
