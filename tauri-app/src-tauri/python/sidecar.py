"""AI Note-Taker — Python sidecar for the Tauri app.

This is a lean FastAPI server that handles ONLY the AI operations:
  - POST /api/transcribe (streaming NDJSON: WhisperX + diarization + Ollama notes)
  - POST /api/chat (Ollama chat over a transcript)
  - POST /api/board/chat (Ollama chat over board nodes)
  - GET /api/status (what AI models are loaded)

The Tauri Rust backend handles everything else (boards, nodes, notes, files).
This sidecar is spawned lazily by Rust only when AI is first needed.

Run standalone:  python sidecar.py   (binds 127.0.0.1:8765)
"""
import json
import os
import re
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

load_dotenv()

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

STATE: dict = {
    "device": WHISPER_DEVICE,
    "whisper_model": None,
    "diarize_model": None,
    "diarize_error": None,
    "align_cache": {},
}


def _ensure_whisper():
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
        from whisperx.diarize import DiarizationPipeline
        STATE["diarize_model"] = DiarizationPipeline(
            model_name=DIARIZE_MODEL, token=HF_TOKEN, device=STATE["device"]
        )
    except Exception as exc:
        STATE["diarize_error"] = f"Could not load diarization model: {exc}"
        STATE["diarize_model"] = None
    return STATE["diarize_model"]


def _get_align_model(language_code: str):
    import whisperx
    cache = STATE["align_cache"]
    if language_code not in cache:
        cache[language_code] = whisperx.load_align_model(
            language_code=language_code, device=STATE["device"]
        )
    return cache[language_code]


def _strip_think(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def _ollama_chat(system_prompt: str, messages: list[dict]) -> str:
    import ollama
    if not OLLAMA_THINK:
        system_prompt += " /no_think"
    client = ollama.Client(host=OLLAMA_HOST)
    try:
        response = client.chat(
            model=OLLAMA_MODEL,
            messages=[{"role": "system", "content": system_prompt}, *messages],
            options={"num_ctx": OLLAMA_NUM_CTX},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Could not reach Ollama at {OLLAMA_HOST} with model '{OLLAMA_MODEL}'. Is Ollama running? Error: {exc}",
        ) from exc
    return _strip_think(response["message"]["content"])


NOTES_PROMPT = """You are a meeting-notes assistant. Produce well-structured notes in \
Markdown. Sections: Summary, Key Points, Decisions, Action Items. Omit empty sections. \
Base everything strictly on the transcript. Output only the Markdown notes."""

CHAT_PROMPT = """You are a helpful assistant answering questions about a recorded \
conversation. Transcript:\n---\n{transcript}\n---\nAnswer ONLY using the transcript. \
Refer to people by speaker labels."""

BOARD_PROMPT = """You are a helpful assistant for a note board. Cards:\n---\n{cards}\n---\
\nAnswer ONLY using the cards provided."""


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
        if buf: lines.append(f"{cur}: {' '.join(buf)}")
    for seg in segments:
        if seg["speaker"] != cur:
            flush(); cur = seg["speaker"]; buf = [seg["text"]]
        else:
            buf.append(seg["text"])
    flush()
    return "\n".join(lines)


app = FastAPI(title="note·taker AI sidecar")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/status")
async def status():
    ollama_ok = False
    try:
        import ollama
        ollama.Client(host=OLLAMA_HOST).list()
        ollama_ok = True
    except Exception:
        pass
    cuda = False
    try:
        import torch
        cuda = torch.cuda.is_available()
    except Exception:
        pass
    return {
        "whisper": STATE["whisper_model"] is not None,
        "whisper_model": WHISPER_MODEL,
        "whisper_device": STATE["device"],
        "diarization": STATE["diarize_model"] is not None,
        "diarize_error": STATE["diarize_error"],
        "ollama": ollama_ok,
        "ollama_model": OLLAMA_MODEL,
        "cuda": cuda,
    }


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    import whisperx
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, f"Unsupported type '{ext}'.")
    audio_bytes = await file.read()

    def stream():
        import whisperx
        t0 = time.time()
        def evt(t, **kw):
            return json.dumps({"type": t, "elapsed": round(time.time() - t0, 1), **kw}) + "\n"

        tmp_path = None
        try:
            if STATE["whisper_model"] is None:
                yield evt("progress", stage="Loading speech model", pct=2)
                _ensure_whisper()

            yield evt("progress", stage="Preparing audio", pct=5)
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
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
            try:
                notes = _ollama_chat(NOTES_PROMPT, [{"role": "user", "content": f"Transcript:\n\n{transcript}"}])
            except Exception as exc:
                notes = f"> ⚠️ Notes could not be generated: {exc}"

            num_speakers = len({s["speaker"] for s in segments})
            warning = STATE["diarize_error"] if STATE["diarize_model"] is None else (None if num_speakers > 1 else "Only one speaker detected.")

            yield evt("result", pct=100, transcript=transcript, segments=segments,
                      notes=notes, num_speakers=num_speakers, warning=warning)
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

@app.post("/api/chat")
async def chat(req: ChatReq):
    if not req.transcript.strip():
        raise HTTPException(400, "No transcript provided.")
    prompt = CHAT_PROMPT.format(transcript=req.transcript)
    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    return {"reply": _ollama_chat(prompt, msgs)}


class BoardChatReq(BaseModel):
    cards: str = ""
    messages: list[ChatMsg] = []

@app.post("/api/board/chat")
async def board_chat(req: BoardChatReq):
    if not req.cards.strip():
        raise HTTPException(400, "No cards provided.")
    prompt = BOARD_PROMPT.format(cards=req.cards)
    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    return {"reply": _ollama_chat(prompt, msgs)}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("SIDECAR_PORT", "8765"))
    print(f"[sidecar] Starting on port {port}...")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
