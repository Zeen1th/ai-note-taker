"""AI Note-Taker — fully local FastAPI backend.

Flow:
  1. Upload audio/video to POST /api/transcribe.
  2. WhisperX: transcribe -> align -> diarize -> assign word speakers.
  3. Build a speaker-labeled transcript + segments.
  4. Generate structured notes with a local LLM (Ollama / Qwen3).
  5. POST /api/chat answers questions about the transcript (stateless).

Everything runs locally. WhisperX runs on CPU by default so the GPU stays
free for the LLM (12GB VRAM plan).
"""

import json
import os
import re
import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:14b")
OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
# CPU threads for transcription. faster-whisper defaults to 4; set this near your
# physical core count for a big speedup on CPU. Ignored meaningfully on GPU.
WHISPER_THREADS = int(os.getenv("WHISPER_THREADS", "16"))
# Force a language (e.g. "en") to skip auto-detection. Required for English-only
# models like distil-large-v3. Empty = auto-detect per file.
WHISPER_LANGUAGE = os.getenv("WHISPER_LANGUAGE", "").strip() or None
# Diarization model. pyannote-audio 4.x requires the gated "community-1" model
# (accept its terms once at the HF model page — approval is instant).
DIARIZE_MODEL = os.getenv("DIARIZE_MODEL", "pyannote/speaker-diarization-community-1")
HF_TOKEN = os.getenv("HF_TOKEN", "").strip()

ALLOWED_EXTENSIONS = {".mp3", ".mp4", ".m4a", ".wav", ".mov", ".webm"}
BATCH_SIZE = int(os.getenv("WHISPER_BATCH_SIZE", "16"))

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"

# Loaded once at startup (see lifespan).
STATE: dict = {
    "device": WHISPER_DEVICE,  # resolved effective device (cuda may fall back to cpu)
    "whisper_model": None,
    "diarize_model": None,
    "diarize_error": None,  # human-readable reason diarization is unavailable
    "align_cache": {},  # language_code -> (model_a, metadata)
}


# ---------------------------------------------------------------------------
# Model loading (once, at startup)
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    import torch
    import whisperx

    # Resolve the effective device: if cuda was requested but isn't available,
    # fall back to CPU with a clear warning rather than crashing.
    device = WHISPER_DEVICE
    if device == "cuda" and not torch.cuda.is_available():
        print("[startup] WARNING: WHISPER_DEVICE=cuda but CUDA is unavailable to "
              "PyTorch — falling back to CPU.")
        device = "cpu"
    STATE["device"] = device

    if device == "cuda":
        print(f"[startup] CUDA device: {torch.cuda.get_device_name(0)}")
        # Make torch's bundled cuDNN/cuBLAS DLLs discoverable by CTranslate2
        # (faster-whisper's engine) on Windows.
        if hasattr(os, "add_dll_directory"):
            libdir = os.path.join(os.path.dirname(torch.__file__), "lib")
            if os.path.isdir(libdir):
                os.add_dll_directory(libdir)
    else:
        # VAD / alignment / diarization run on PyTorch — let them use the cores
        # too, not just the whisper transcription stage.
        torch.set_num_threads(WHISPER_THREADS)

    print(f"[startup] Loading WhisperX model '{WHISPER_MODEL}' "
          f"(device={device}, compute_type={WHISPER_COMPUTE_TYPE}, "
          f"threads={WHISPER_THREADS})...")
    STATE["whisper_model"] = whisperx.load_model(
        WHISPER_MODEL, device,
        compute_type=WHISPER_COMPUTE_TYPE, threads=WHISPER_THREADS,
        language=WHISPER_LANGUAGE,
    )

    if HF_TOKEN:
        try:
            from whisperx.diarize import DiarizationPipeline
            print(f"[startup] Loading diarization pipeline ({DIARIZE_MODEL})...")
            STATE["diarize_model"] = DiarizationPipeline(
                model_name=DIARIZE_MODEL, token=HF_TOKEN, device=STATE["device"]
            )
            print("[startup] Diarization ready.")
        except Exception as exc:  # noqa: BLE001
            STATE["diarize_error"] = (
                f"Could not load diarization model '{DIARIZE_MODEL}': {exc} "
                f"— accept its terms at https://huggingface.co/{DIARIZE_MODEL} "
                f"and ensure HF_TOKEN has access. Until then everyone is 'Speaker 1'."
            )
            print(f"[startup] WARNING: {STATE['diarize_error']}")
            STATE["diarize_model"] = None
    else:
        STATE["diarize_error"] = (
            "HF_TOKEN not set — diarization disabled, all speech labeled 'Speaker 1'."
        )
        print(f"[startup] WARNING: {STATE['diarize_error']}")

    print("[startup] Ready.")
    yield
    STATE.clear()


app = FastAPI(title="AI Note-Taker", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _get_align_model(language_code: str):
    """Load (and cache) an alignment model per language."""
    import whisperx

    cache = STATE["align_cache"]
    if language_code not in cache:
        cache[language_code] = whisperx.load_align_model(
            language_code=language_code, device=STATE["device"]
        )
    return cache[language_code]


def _build_segments(result: dict) -> list[dict]:
    """Turn a WhisperX result into [{speaker, start, end, text}] with
    SPEAKER_00/01 mapped to 'Speaker 1/2' in order of first appearance."""
    speaker_map: dict[str, str] = {}

    def label_for(raw_speaker):
        if not raw_speaker:
            raw_speaker = "UNKNOWN"
        if raw_speaker not in speaker_map:
            speaker_map[raw_speaker] = f"Speaker {len(speaker_map) + 1}"
        return speaker_map[raw_speaker]

    segments = []
    for seg in result.get("segments", []):
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        segments.append({
            "speaker": label_for(seg.get("speaker")),
            "start": round(float(seg.get("start", 0.0)), 2),
            "end": round(float(seg.get("end", 0.0)), 2),
            "text": text,
        })
    return segments


def _build_transcript(segments: list[dict]) -> str:
    """One line per turn, merging consecutive same-speaker segments."""
    lines: list[str] = []
    current_speaker = None
    buffer: list[str] = []

    def flush():
        if buffer:
            lines.append(f"{current_speaker}: {' '.join(buffer)}")

    for seg in segments:
        if seg["speaker"] != current_speaker:
            flush()
            current_speaker = seg["speaker"]
            buffer = [seg["text"]]
        else:
            buffer.append(seg["text"])
    flush()
    return "\n".join(lines)


def _strip_think(text: str) -> str:
    """Remove Qwen3 <think>...</think> reasoning blocks."""
    cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    return cleaned.strip()


def _ollama_chat(system_prompt: str, messages: list[dict]) -> str:
    """Call the local Ollama server and return cleaned text."""
    import ollama

    client = ollama.Client(host=OLLAMA_HOST)
    try:
        response = client.chat(
            model=OLLAMA_MODEL,
            messages=[{"role": "system", "content": system_prompt}, *messages],
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=503,
            detail=(
                f"Could not reach the local LLM at {OLLAMA_HOST} with model "
                f"'{OLLAMA_MODEL}'. Is Ollama running and the model pulled "
                f"(`ollama pull {OLLAMA_MODEL}`)? Underlying error: {exc}"
            ),
        ) from exc

    return _strip_think(response["message"]["content"])


NOTES_SYSTEM_PROMPT = """You are a meeting-notes assistant. You are given a \
speaker-labeled transcript of a recording. Produce well-structured notes in \
Markdown.

Use these sections, but OMIT any section that would be empty:
- **Summary** — 2-4 sentences capturing what the recording is about.
- **Key Points** — bullet points of the important content. Attribute points to \
speakers (e.g. "Speaker 1 noted ...") when it is relevant.
- **Decisions** — bullet points of any decisions that were made.
- **Action Items** — bullet points of tasks/follow-ups. Note who owns each item \
by speaker label when it is clear from the transcript.

Base everything strictly on the transcript. Do not invent content. Output only \
the Markdown notes — no preamble, no commentary."""


def _generate_notes(transcript: str) -> str:
    return _ollama_chat(
        NOTES_SYSTEM_PROMPT,
        [{"role": "user", "content": f"Transcript:\n\n{transcript}"}],
    )


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.post("/api/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """Stream newline-delimited JSON progress events, then a final result.

    Event shapes (one JSON object per line):
      {"type": "progress", "stage": str, "pct": int, "elapsed": float}
      {"type": "result",   "pct": 100, "transcript", "segments", "notes", ...}
      {"type": "error",    "detail": str, "elapsed": float}
    """
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported file type '{ext}'. Allowed: "
                f"{', '.join(sorted(ALLOWED_EXTENSIONS))}."
            ),
        )

    # Read the upload now; the heavy work happens in the (sync) stream generator,
    # which Starlette runs in a threadpool so it won't block the event loop.
    audio_bytes = await file.read()

    def event_stream():
        import whisperx

        t0 = time.time()

        def evt(type_, **kw):
            return json.dumps(
                {"type": type_, "elapsed": round(time.time() - t0, 1), **kw}
            ) + "\n"

        tmp_path = None
        try:
            yield evt("progress", stage="Preparing audio", pct=3)
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            audio = whisperx.load_audio(tmp_path)

            yield evt("progress", stage="Transcribing", pct=10)
            try:
                result = STATE["whisper_model"].transcribe(audio, batch_size=BATCH_SIZE)
            except Exception as exc:  # noqa: BLE001
                yield evt("error", detail=f"Transcription failed: {exc}")
                return
            print(f"[transcribe] transcription done at {time.time() - t0:.1f}s")

            if not result.get("segments"):
                yield evt("error", detail="No speech detected in the recording.")
                return

            # Word-level alignment (improves diarization accuracy).
            yield evt("progress", stage="Aligning words", pct=55)
            try:
                model_a, metadata = _get_align_model(result["language"])
                result = whisperx.align(
                    result["segments"], model_a, metadata, audio,
                    STATE["device"], return_char_alignments=False,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[transcribe] WARNING: alignment failed, continuing: {exc}")
            print(f"[transcribe] alignment done at {time.time() - t0:.1f}s")

            # Diarization (assigns speakers to words/segments).
            if STATE["diarize_model"] is not None:
                yield evt("progress", stage="Identifying speakers", pct=70)
                try:
                    diarize_segments = STATE["diarize_model"](audio)
                    result = whisperx.assign_word_speakers(diarize_segments, result)
                except Exception as exc:  # noqa: BLE001
                    print(f"[transcribe] WARNING: diarization failed, continuing: {exc}")
                print(f"[transcribe] diarization done at {time.time() - t0:.1f}s")

            segments = _build_segments(result)
            if not segments:
                yield evt("error", detail="No speech detected in the recording.")
                return
            transcript = _build_transcript(segments)

            yield evt("progress", stage="Writing notes", pct=90)
            try:
                notes = _generate_notes(transcript)
            except HTTPException as exc:
                notes = f"> ⚠️ Notes could not be generated: {exc.detail}"
            except Exception as exc:  # noqa: BLE001
                notes = f"> ⚠️ Notes could not be generated: {exc}"
            print(f"[transcribe] notes done at {time.time() - t0:.1f}s (total)")

            num_speakers = len({s["speaker"] for s in segments})
            warning = None
            if STATE["diarize_model"] is None:
                warning = STATE["diarize_error"]
            elif num_speakers <= 1:
                warning = (
                    "Only one speaker was detected. If you expected more, the audio "
                    "may have overlapping or very quiet speakers, or be a single voice."
                )

            yield evt(
                "result", pct=100,
                transcript=transcript, segments=segments, notes=notes,
                num_speakers=num_speakers, warning=warning,
            )
        except Exception as exc:  # noqa: BLE001
            yield evt("error", detail=f"Unexpected error: {exc}")
        finally:
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    transcript: str
    messages: list[ChatMessage]


CHAT_SYSTEM_PROMPT_TEMPLATE = """You are a helpful assistant answering questions \
about a recorded conversation. Below is the speaker-labeled transcript.

Rules:
- Answer ONLY using information from the transcript.
- Refer to people by their speaker labels (e.g. "Speaker 1").
- If something is not covered by the transcript, say so plainly instead of \
guessing.

Transcript:
---
{transcript}
---"""


@app.post("/api/chat")
async def chat(req: ChatRequest):
    if not req.transcript.strip():
        raise HTTPException(status_code=400, detail="No transcript provided.")
    system_prompt = CHAT_SYSTEM_PROMPT_TEMPLATE.format(transcript=req.transcript)
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    reply = _ollama_chat(system_prompt, messages)
    return {"reply": reply}


# Static assets (after routes so "/" maps to index above).
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
