"""AI Note-Taker — Python sidecar for the Tauri app.

This is a lean FastAPI server that handles ONLY the AI operations:
  - POST /api/transcribe (streaming NDJSON: WhisperX + diarization + LLM notes)
  - POST /api/chat (LLM chat over a transcript)
  - POST /api/board/chat (LLM chat over board nodes)
  - POST /api/library/search (LLM search over the notes library)
  - GET /api/status (what AI models/engines are available)
  - GET /api/health (liveness — used by the Rust host at startup)
  - POST /api/test (validates an API key with a tiny LLM call)

Two LLM/STT providers are supported, configured per-request via a `cfg` object
(or form fields for /api/transcribe):
  - provider="local": local Ollama (chat) + local WhisperX (transcribe)
  - provider="api":   any OpenAI-compatible API (chat + audio transcription)

The Tauri Rust backend handles everything else (boards, nodes, notes, files).
This sidecar is spawned lazily by Rust only when AI is first needed.

Run standalone:  python sidecar.py   (binds 127.0.0.1:8765)
"""
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

def _load_env():
    """Load .env from the working dir chain, then the sidecar script's own
    ancestor chain (repo root in dev, wherever python/ ships in production)."""
    here = Path(__file__).resolve().parent
    for d in [Path.cwd(), here, here.parent, here.parent.parent, here.parent.parent.parent]:
        env_file = d / ".env"
        if env_file.is_file():
            load_dotenv(env_file)
            return env_file
    return None


ENV_FILE = _load_env()

# Keep model downloads off the system drive: prefer a `.hf-cache` next to this
# script (S: drive in dev) so `~/.cache/huggingface` never grows by gigabytes.
_HF_CACHE = Path(__file__).resolve().parent / ".hf-cache"
if _HF_CACHE.exists():
    os.environ.setdefault("HF_HOME", str(_HF_CACHE))
    os.environ.setdefault("HF_HUB_CACHE", str(_HF_CACHE / "hub"))

OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:14b")
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))
OLLAMA_THINK = os.getenv("OLLAMA_THINK", "false").lower() in ("1", "true", "yes")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
WHISPER_THREADS = int(os.getenv("WHISPER_THREADS", "16"))
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "").strip() or None
DIARIZE_MODEL = os.getenv("DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip()
BATCH_SIZE = int(os.getenv("WHISPER_BATCH_SIZE", "16"))
ALLOWED_EXTENSIONS = {".mp3", ".mp4", ".m4a", ".wav", ".mov", ".webm"}
# OpenAI-compatible API defaults (used when provider="api")
API_DEFAULT_BASE = os.getenv("API_BASE", "https://api.openai.com/v1")
API_DEFAULT_MODEL = os.getenv("API_MODEL", "gpt-4o-mini")

INSTALL_HINT = (
    "Local AI dependencies are missing. Run:  python -m pip install -r "
    "src-tauri/python/requirements.txt  (or switch to API-key mode in Settings)."
)

STATE: dict = {
    "device": WHISPER_DEVICE,
    "whisper_model": None,
    "diarize_model": None,
    "diarize_error": None,
    "align_cache": {},
}


def _have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:
        return False


def _patch_transformers():
    """whisperx 3.8 does `from transformers import Pipeline`, which
    transformers >= 4.57 no longer exports at the top level. Alias it."""
    try:
        import transformers
        if not hasattr(transformers, "Pipeline"):
            from transformers.pipelines.base import Pipeline
            transformers.Pipeline = Pipeline
    except Exception:
        pass


def _ensure_whisper():
    if not _have("whisperx"):
        raise RuntimeError("whisperx is not installed. " + INSTALL_HINT)
    _patch_transformers()
    import torch, whisperx
    if STATE["whisper_model"] is not None:
        return
    device = WHISPER_DEVICE
    if device == "cuda" and not torch.cuda.is_available():
        print("[whisper] CUDA unavailable, falling back to CPU.")
        device = "cpu"
    STATE["device"] = device
    if device == "cuda":
        if hasattr(os, "add_dll_directory"):
            libdir = os.path.join(os.path.dirname(torch.__file__), "lib")
            if os.path.isdir(libdir):
                os.add_dll_directory(libdir)
    else:
        torch.set_num_threads(WHISPER_THREADS)
    print(f"[whisper] Loading '{WHISPER_MODEL}' (device={device})...")
    STATE["whisper_model"] = whisperx.load_model(
        WHISPER_MODEL, device,
        compute_type=WHISPER_COMPUTE_TYPE, threads=WHISPER_THREADS,
        language=WHISPER_LANGUAGE,
    )


def _ensure_diarizer():
    if STATE["diarize_model"] is not None or STATE["diarize_error"] is not None:
        return STATE["diarize_model"]
    if not HF_TOKEN:
        STATE["diarize_error"] = "HF_TOKEN not set — diarization disabled."
        return None
    try:
        _patch_transformers()
        from whisperx.diarize import DiarizationPipeline
        STATE["diarize_model"] = DiarizationPipeline(
            model_name=DIARIZE_MODEL, token=HF_TOKEN, device=STATE["device"]
        )
    except Exception as exc:
        STATE["diarize_error"] = f"Could not load diarization model: {exc}"
        STATE["diarize_model"] = None
    return STATE["diarize_model"]


def _get_align_model(language_code: str):
    _patch_transformers()
    import whisperx
    cache = STATE["align_cache"]
    if language_code not in cache:
        cache[language_code] = whisperx.load_align_model(
            language_code=language_code, device=STATE["device"]
        )
    return cache[language_code]


def _strip_think(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


# ---------------------------------------------------------------------------
# LLM provider abstraction: local Ollama or any OpenAI-compatible API
# ---------------------------------------------------------------------------
class AiCfg(BaseModel):
    provider: str = "local"
    api_base: str = ""
    api_key: str = ""
    llm_model: str = ""
    stt_model: str = ""


def _merge_cfg(cfg: AiCfg | dict | None) -> dict:
    c = cfg.dict() if isinstance(cfg, AiCfg) else (cfg or {})
    return {
        "provider": c.get("provider") or "local",
        "api_base": (c.get("api_base") or API_DEFAULT_BASE).strip(),
        "api_key": (c.get("api_key") or "").strip(),
        "llm_model": (c.get("llm_model") or "").strip(),
        "stt_model": (c.get("stt_model") or "").strip(),
    }


def _api_chat_completions(cfg: dict, messages: list[dict]) -> str:
    base = cfg["api_base"].rstrip("/")
    if not cfg["api_key"]:
        raise HTTPException(503, "API mode is selected but no API key is set — add it in Settings.")
    url = base + "/chat/completions"
    body = json.dumps({"model": cfg["llm_model"] or API_DEFAULT_MODEL, "messages": messages, "stream": False}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg['api_key']}",
    })
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise HTTPException(502, f"API error {exc.code} from {base}: {detail}") from exc
    except Exception as exc:
        raise HTTPException(503, f"Could not reach {base}: {exc}") from exc
    try:
        return data["choices"][0]["message"]["content"]
    except Exception as exc:
        raise HTTPException(502, f"Unexpected API response from {base}: {str(data)[:300]}") from exc


def _ollama_models() -> list[tuple[str, int]]:
    """Installed chat-capable models as (name, size_bytes), smallest first.

    Some installed models (e.g. qwen2.5-coder:7b, a completion-only base)
    have no chat template and reject /api/chat with HTTP 400. They are
    checked via /api/show (cached 30 s) and excluded so auto-pick, the
    model picker and the status panel never offer a broken model."""
    host = OLLAMA_HOST.rstrip("/")
    try:
        with urllib.request.urlopen(host + "/api/tags", timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
            models = [(m.get("name", ""), int(m.get("size", 0)))
                      for m in data.get("models") or [] if m.get("name")]
    except Exception:
        return []
    return sorted((m for m in models if _chat_capable(m[0])), key=lambda x: x[1])


_chat_capable_cache: dict[str, tuple[float, bool]] = {}


def _chat_capable(name: str) -> bool:
    """True if the model has a chat template (i.e. supports /api/chat).

    Failure to answer /api/show (404, corrupt blobs, Ollama down) means the
    model can't chat — exclude it rather than risk a broken pick."""
    now = time.time()
    hit = _chat_capable_cache.get(name)
    if hit and now - hit[0] < 30:
        return hit[1]
    ok = False
    try:
        body = json.dumps({"model": name}).encode()
        req = urllib.request.Request(OLLAMA_HOST.rstrip("/") + "/api/show", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
            ok = bool(str(data.get("template") or "").strip())
    except Exception:
        pass
    _chat_capable_cache[name] = (now, ok)
    return ok


def _ollama_tags() -> list[str]:
    return [n for n, _ in _ollama_models()]


def _pick_smallest_model() -> str | None:
    models = _ollama_models()
    return models[0][0] if models else None


def _ollama_reachable() -> bool:
    want = OLLAMA_MODEL.split(":")[0]
    return any(n.split(":")[0] == want for n in _ollama_tags())


def _local_chat(system_prompt: str, messages: list[dict], model: str | None = None) -> str:
    host = OLLAMA_HOST.rstrip("/")
    model = model or _pick_smallest_model() or OLLAMA_MODEL
    if not OLLAMA_THINK:
        system_prompt += " /no_think"
    body = json.dumps({
        "model": model,
        "messages": [{"role": "system", "content": system_prompt}, *messages],
        "stream": False,
        "options": {"num_ctx": OLLAMA_NUM_CTX},
    }).encode()
    req = urllib.request.Request(host + "/api/chat", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        raise HTTPException(502, f"Ollama error {exc.code}: {detail}") from exc
    except Exception as exc:
        raise HTTPException(
            503,
            f"Could not reach Ollama at {host}. Is Ollama running? Error: {exc}",
        ) from exc
    try:
        return _strip_think(data["message"]["content"])
    except Exception as exc:
        raise HTTPException(502, f"Unexpected Ollama response: {str(data)[:300]}") from exc


def _llm_chat(system_prompt: str, messages: list[dict], cfg: AiCfg | dict | None = None) -> str:
    c = _merge_cfg(cfg)
    if c["provider"] == "api":
        return _strip_think(_api_chat_completions(c, [{"role": "system", "content": system_prompt}, *messages]))
    # Local: only honour a picked model if Ollama actually has it, otherwise
    # fall back to the .env default (protects against an API-mode leftover).
    model = c["llm_model"] if c["llm_model"] in _ollama_tags() else None
    return _local_chat(system_prompt, messages, model=model)


# ---------------------------------------------------------------------------
# Transcription always runs locally via WhisperX — API keys power chat only.
# (The old OpenAI-compatible /audio/transcriptions path was removed.)
# ---------------------------------------------------------------------------
NOTES_PROMPT = """You are a meeting-notes assistant. Produce well-structured notes in \
Markdown. Sections: Summary, Key Points, Decisions, Action Items. Omit empty sections. \
Base everything strictly on the transcript. Output only the Markdown notes."""

CHAT_PROMPT = """You are a helpful assistant answering questions about a recorded \
conversation. Transcript:\n---\n{transcript}\n---\nAnswer ONLY using the transcript. \
Refer to people by speaker labels."""

BOARD_PROMPT = """You are a helpful assistant for a note board. Cards:\n---\n{cards}\n---\
\nAnswer ONLY using the cards provided."""

LIBRARY_PROMPT = """You are a search assistant for a personal notes library. \
All notes:\n---\n{corpus}\n---\nThe user searched for: {query}\n\
Find the notes that relate to the query. List the matches as Markdown bullets, each \
starting with the board name, then the note title, then one line about why it matches. \
If nothing matches, say exactly: No matches. Then suggest a broader query."""


def _build_segments(result: dict) -> list[dict]:
    speaker_map: dict[str, str] = {}
    def label(raw):
        if not raw: raw = "UNKNOWN"
        if raw not in speaker_map:
            speaker_map[raw] = f"Speaker {len(speaker_map) + 1}"
        return speaker_map[raw]
    segments = []
    for seg in result.get("segments", []):
        text = (seg.get("text") or "").strip()
        if text:
            segments.append({
                "speaker": label(seg.get("speaker")),
                "start": round(float(seg.get("start", 0)), 2),
                "end": round(float(seg.get("end", 0)), 2),
                "text": text,
            })
    return segments


def _build_transcript(segments: list[dict]) -> str:
    lines, cur, buf = [], None, []
    def flush():
        if buf:
            lines.append(f"{cur}: {' '.join(buf)}" if cur else ' '.join(buf))
    for seg in segments:
        if seg["speaker"] != cur:
            flush(); cur = seg["speaker"]; buf = [seg["text"]]
        else:
            buf.append(seg["text"])
    flush()
    return "\n".join(lines)


app = FastAPI(title="note·taker AI sidecar")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.get("/api/status")
async def status():
    cuda = False
    try:
        import torch
        cuda = torch.cuda.is_available()
    except Exception:
        pass
    whisper_ok = _have("whisperx")
    ollama_models = _ollama_models()
    ollama_ok = any(n.split(":")[0] == OLLAMA_MODEL.split(":")[0] for n, _ in ollama_models)
    return {
        "whisper": STATE["whisper_model"] is not None,
        "whisper_model": WHISPER_MODEL,
        "whisper_device": STATE["device"],
        "whisperx_available": whisper_ok,
        "ollama_available": ollama_ok,
        "ollama_models": [n for n, _ in ollama_models],
        "ollama_sizes": {n: s for n, s in ollama_models},
        "ollama_smallest": ollama_models[0][0] if ollama_models else "",
        "diarization": STATE["diarize_model"] is not None,
        "diarize_error": STATE["diarize_error"],
        "ollama": ollama_ok,
        "ollama_model": OLLAMA_MODEL,
        "cuda": cuda,
        "install_hint": INSTALL_HINT if not whisper_ok else None,
    }


@app.post("/api/test")
async def test_ai(cfg: AiCfg | None = None):
    """Validate the selected provider with a tiny LLM call."""
    c = _merge_cfg(cfg)
    if c["provider"] == "api":
        reply = _api_chat_completions(c, [{"role": "user", "content": "Reply with exactly: OK"}])
        return {"ok": True, "provider": "api", "model": c["llm_model"] or API_DEFAULT_MODEL, "reply": reply[:40]}
    model = c["llm_model"] if c["llm_model"] in _ollama_tags() else (_pick_smallest_model() or OLLAMA_MODEL)
    try:
        reply = _local_chat("Reply with exactly: OK", [{"role": "user", "content": "ping"}], model=model)
        return {"ok": True, "provider": "local", "model": model, "reply": reply[:40]}
    except HTTPException as exc:
        return {"ok": False, "error": exc.detail}


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...), provider: str = Form("local"), api_base: str = Form(""),
                     api_key: str = Form(""), stt_model: str = Form(""), llm_model: str = Form(""),
                     notes_mode: str = Form("auto")):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported type '{ext}'.")
    cfg = {"provider": provider or "local", "api_base": api_base, "api_key": api_key,
           "llm_model": llm_model, "stt_model": stt_model}
    if not _have("whisperx"):
        raise HTTPException(
            400, "whisperx is not installed. " + INSTALL_HINT
        )
    if notes_mode == "ask" and (cfg["provider"] or "local") == "api":
        notes_mode = "auto"  # the model picker only makes sense for local Ollama
    audio_bytes = await file.read()

    def stream():
        t0 = time.time()
        def evt(t, **kw):
            return json.dumps({"type": t, "elapsed": round(time.time() - t0, 1), **kw}) + "\n"

        tmp_path = None
        try:
            # ---- Transcription ALWAYS runs locally (WhisperX) ----
            # The provider cfg only decides which LLM writes the notes.
            try:
                if STATE["whisper_model"] is None:
                    yield evt("progress", stage="Loading speech model", pct=2)
                    _ensure_whisper()
            except Exception as exc:
                yield evt("error", detail=f"Could not load speech model: {exc}")
                return

            yield evt("progress", stage="Preparing audio", pct=5)
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            import whisperx
            audio = whisperx.load_audio(tmp_path)

            yield evt("progress", stage="Transcribing", pct=12)
            try:
                result = STATE["whisper_model"].transcribe(audio, batch_size=BATCH_SIZE)
            except Exception as exc:
                yield evt("error", detail=f"Transcription failed: {exc}")
                return

            if not result.get("segments"):
                yield evt("error", detail="No speech detected.")
                return

            yield evt("progress", stage="Aligning words", pct=55)
            try:
                model_a, metadata = _get_align_model(result["language"])
                result = whisperx.align(result["segments"], model_a, metadata, audio, STATE["device"], return_char_alignments=False)
            except Exception:
                pass

            if _ensure_diarizer() is not None:
                yield evt("progress", stage="Identifying speakers", pct=70)
                try:
                    diarize_segments = STATE["diarize_model"](audio)
                    result = whisperx.assign_word_speakers(diarize_segments, result)
                except Exception:
                    pass

            segments = _build_segments(result)
            if not segments:
                yield evt("error", detail="No speech detected.")
                return
            transcript = _build_transcript(segments)

            yield evt("progress", stage="Writing notes", pct=90)
            if notes_mode == "ask":
                notes = None  # the client will ask which model to use
            else:
                try:
                    notes = _llm_chat(NOTES_PROMPT, [{"role": "user", "content": f"Transcript:\n\n{transcript}"}], cfg)
                except Exception as exc:
                    notes = f"> ⚠️ Notes could not be generated: {exc}"

            num_speakers = len({s["speaker"] for s in segments})
            warning = STATE["diarize_error"] if STATE["diarize_model"] is None else (None if num_speakers > 1 else "Only one speaker detected.")

            yield evt("result", pct=100, transcript=transcript, segments=segments,
                      notes=notes, num_speakers=num_speakers, warning=warning)
        except HTTPException as exc:
            yield evt("error", detail=exc.detail)
        except Exception as exc:
            yield evt("error", detail=f"Unexpected error: {exc}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try: os.remove(tmp_path)
                except OSError: pass

    return StreamingResponse(stream(), media_type="application/x-ndjson")


class ChatMsg(BaseModel):
    role: str
    content: str

class ChatReq(BaseModel):
    transcript: str = ""
    messages: list[ChatMsg] = []
    cfg: AiCfg | None = None
    notes: bool = False

@app.post("/api/chat")
async def chat(req: ChatReq):
    if not req.transcript.strip():
        raise HTTPException(400, "No transcript provided.")
    if req.notes:
        prompt = NOTES_PROMPT
        msgs = [{"role": "user", "content": f"Transcript:\n\n{req.transcript}"}]
    else:
        prompt = CHAT_PROMPT.format(transcript=req.transcript)
        msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    return {"reply": _llm_chat(prompt, msgs, req.cfg)}


class BoardChatReq(BaseModel):
    cards: str = ""
    messages: list[ChatMsg] = []
    cfg: AiCfg | None = None

@app.post("/api/board/chat")
async def board_chat(req: BoardChatReq):
    if not req.cards.strip():
        raise HTTPException(400, "No cards provided.")
    prompt = BOARD_PROMPT.format(cards=req.cards)
    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    return {"reply": _llm_chat(prompt, msgs, req.cfg)}


class LibrarySearchReq(BaseModel):
    query: str = ""
    corpus: str = ""
    cfg: AiCfg | None = None

@app.post("/api/library/search")
async def library_search(req: LibrarySearchReq):
    if not req.query.strip():
        raise HTTPException(400, "Empty query.")
    if not req.corpus.strip():
        return {"reply": "The library is empty — add some notes first."}
    prompt = LIBRARY_PROMPT.format(query=req.query, corpus=req.corpus)
    return {"reply": _llm_chat(prompt, [], req.cfg)}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("SIDECAR_PORT", "8765"))
    print(f"[sidecar] Starting on port {port}...")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
