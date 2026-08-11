// AI provider config — read from localStorage, sent with every AI request so
// the sidecar can pick local (Ollama + WhisperX) or an OpenAI-compatible API.
export interface AiCfg {
  provider: 'local' | 'api';
  api_base: string;
  api_key: string;
  llm_model: string;
  stt_model: string;
}

const DEFAULTS = {
  api_base: 'https://api.openai.com/v1',
};

export function getAiCfg(): AiCfg {
  return {
    provider: localStorage.getItem('nt-ai-provider') === 'api' ? 'api' : 'local',
    api_base: (localStorage.getItem('nt-ai-base') || '').trim() || DEFAULTS.api_base,
    api_key: (localStorage.getItem('nt-ai-key') || '').trim(),
    // Empty model = let the sidecar pick (local: .env OLLAMA_MODEL; api: its default).
    llm_model: (localStorage.getItem('nt-ai-model') || '').trim(),
    stt_model: (localStorage.getItem('nt-ai-stt-model') || '').trim(),
  };
}

export function setAiCfg(patch: Partial<AiCfg>) {
  if (patch.provider !== undefined) localStorage.setItem('nt-ai-provider', patch.provider);
  if (patch.api_base !== undefined) localStorage.setItem('nt-ai-base', patch.api_base);
  if (patch.api_key !== undefined) localStorage.setItem('nt-ai-key', patch.api_key);
  if (patch.llm_model !== undefined) localStorage.setItem('nt-ai-model', patch.llm_model);
  if (patch.stt_model !== undefined) localStorage.setItem('nt-ai-stt-model', patch.stt_model);
}

// "Ask which model to use for notes" — shows a model picker after each
// transcription when on (default). Off = always use the configured model.
export function getAskNotes(): boolean {
  const v = localStorage.getItem('nt-ai-ask-notes');
  return v === null ? true : v === 'true';
}

export function setAskNotes(on: boolean) {
  localStorage.setItem('nt-ai-ask-notes', on ? 'true' : 'false');
}
