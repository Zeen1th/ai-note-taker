"""AI Note-Taker — fully local FastAPI backend.

Two parts:
  1. General note taker: plain Markdown notes (GET/POST/PATCH/DELETE
     /api/notes) — works with no GPU, no Ollama, no WhisperX.
  2. AI transcription: upload audio/video to POST /api/transcribe.
     WhisperX (transcribe -> align -> diarize -> assign speakers) loads
     lazily on first use, then notes are generated with a local LLM
     (Ollama / Qwen3). POST /api/chat answers questions about the transcript.

Everything runs locally. WhisperX runs on CPU by default so the GPU stays
free for the LLM (12GB VRAM plan). The app starts instantly; no AI model
is loaded at startup.
"""

import json
import os
import re
import sqlite3
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
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
# Context window for the LLM. Ollama defaults qwen3 to 40960, which bloats the
# KV cache (~11GB) and spills to CPU. 8192 fits the transcript + notes, stays
# 100% on GPU, and is much faster. Raise only for very long recordings.
OLLAMA_NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "8192"))
# qwen3 "thinks" before answering (slow, then discarded). Off by default for
# speed; set OLLAMA_THINK=true to re-enable reasoning.
OLLAMA_THINK = os.getenv("OLLAMA_THINK", "false").lower() in ("1", "true", "yes")
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
ALLOWED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024  # 8 MB cap on board image uploads
BATCH_SIZE = int(os.getenv("WHISPER_BATCH_SIZE", "16"))

BASE_DIR = Path(__file__).parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
AUDIO_DIR = DATA_DIR / "audio"
IMAGES_DIR = DATA_DIR / "board_images"
DB_PATH = DATA_DIR / "sessions.db"

# Loaded once at startup (see lifespan).
STATE: dict = {
    "device": WHISPER_DEVICE,  # resolved effective device (cuda may fall back to cpu)
    "whisper_model": None,
    "diarize_model": None,
    "diarize_error": None,  # human-readable reason diarization is unavailable
    "align_cache": {},  # language_code -> (model_a, metadata)
}


# ---------------------------------------------------------------------------
# Lazy model loading — the app starts instantly; AI models load on first use.
# The general note taker never needs WhisperX, Ollama, or a GPU.
# ---------------------------------------------------------------------------
def _ensure_whisper():
    """Load WhisperX on demand (first transcription)."""
    import torch
    import whisperx

    if STATE["whisper_model"] is not None:
        return

    # Resolve the effective device: if cuda was requested but isn't available,
    # fall back to CPU with a clear warning rather than crashing.
    device = WHISPER_DEVICE
    if device == "cuda" and not torch.cuda.is_available():
        print("[whisper] WARNING: WHISPER_DEVICE=cuda but CUDA is unavailable to "
              "PyTorch — falling back to CPU.")
        device = "cpu"
    STATE["device"] = device

    if device == "cuda":
        print(f"[whisper] CUDA device: {torch.cuda.get_device_name(0)}")
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

    print(f"[whisper] Loading WhisperX model '{WHISPER_MODEL}' "
          f"(device={device}, compute_type={WHISPER_COMPUTE_TYPE}, "
          f"threads={WHISPER_THREADS})...")
    STATE["whisper_model"] = whisperx.load_model(
        WHISPER_MODEL, device,
        compute_type=WHISPER_COMPUTE_TYPE, threads=WHISPER_THREADS,
        language=WHISPER_LANGUAGE,
    )
    print("[whisper] ready.")


def _ensure_diarizer():
    """Load the pyannote diarization pipeline on demand (first transcription)."""
    if STATE["diarize_model"] is not None or STATE["diarize_error"] is not None:
        return STATE["diarize_model"]

    if not HF_TOKEN:
        STATE["diarize_error"] = (
            "HF_TOKEN not set — diarization disabled, all speech labeled 'Speaker 1'."
        )
        print(f"[diarize] WARNING: {STATE['diarize_error']}")
        return None

    try:
        from whisperx.diarize import DiarizationPipeline
        print(f"[diarize] Loading diarization pipeline ({DIARIZE_MODEL})...")
        STATE["diarize_model"] = DiarizationPipeline(
            model_name=DIARIZE_MODEL, token=HF_TOKEN, device=STATE["device"]
        )
        print("[diarize] ready.")
    except Exception as exc:  # noqa: BLE001
        STATE["diarize_error"] = (
            f"Could not load diarization model '{DIARIZE_MODEL}': {exc} "
            f"— accept its terms at https://huggingface.co/{DIARIZE_MODEL} "
            f"and ensure HF_TOKEN has access. Until then everyone is 'Speaker 1'."
        )
        print(f"[diarize] WARNING: {STATE['diarize_error']}")
        STATE["diarize_model"] = None
    return STATE["diarize_model"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    _init_db()
    print("[startup] Ready. (WhisperX loads lazily on first transcription — "
          "the app opens instantly and needs no AI stack to run.)")
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

    # Disable qwen3's slow reasoning unless explicitly enabled (it's discarded).
    if not OLLAMA_THINK:
        system_prompt += " /no_think"

    client = ollama.Client(host=OLLAMA_HOST)
    try:
        response = client.chat(
            model=OLLAMA_MODEL,
            messages=[{"role": "system", "content": system_prompt}, *messages],
            options={"num_ctx": OLLAMA_NUM_CTX},
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


BOARD_SYSTEM_PROMPT_TEMPLATE = """You are a helpful assistant for a free-form \
note board. The user has a canvas of short notes. Below are their current cards \
(text only), one per line, in the format `[kind] text`.

Rules:
- Answer ONLY using the cards provided.
- A "summary" should briefly characterise what the board holds.
- A "group"/"grouping" should cluster related cards by topic or kind.
- "actions"/"action items" should pull out anything that reads like a task.
- If the board is empty or the question is not answerable from the cards, say so.

Board cards:
---
{cards}
---"""


def _cards_to_context(cards: list[dict]) -> str:
    """Flatten board nodes into the text context for the LLM."""
    lines = []
    for c in cards or []:
        kind = (c.get("kind") or "note").strip() or "note"
        text = (c.get("text") or "").strip().replace("\n", " ")
        if kind == "image":
            # Image nodes carry no transcribable text; note their presence so the
            # model can mention "the board has an image" rather than ignore them.
            label = text or "image"
            lines.append(f"[image] {label}")
        elif text:
            lines.append(f"[note] {text}")
    return "\n".join(lines) if lines else "(the board is empty)"


# ---------------------------------------------------------------------------
# Storage (SQLite) — persist sessions so they survive restarts
# ---------------------------------------------------------------------------
def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    DATA_DIR.mkdir(exist_ok=True)
    AUDIO_DIR.mkdir(exist_ok=True)
    IMAGES_DIR.mkdir(exist_ok=True)
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                title TEXT NOT NULL,
                source TEXT,
                duration REAL,
                num_speakers INTEGER,
                transcript TEXT,
                segments TEXT,
                notes TEXT,
                audio_path TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS plain_notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS board_cards (
                id TEXT PRIMARY KEY,
                x REAL,
                y REAL,
                w REAL,
                h REAL,
                text TEXT,
                c INTEGER,
                kind TEXT,
                image TEXT,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS board_edges (
                id TEXT PRIMARY KEY,
                from_id TEXT NOT NULL,
                to_id TEXT NOT NULL,
                color INTEGER,
                label TEXT,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS boards (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source_session_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        # --- Migrations for pre-existing DBs (CREATE TABLE IF NOT EXISTS won't
        #     add columns to an already-created table). Guard each by checking the
        #     live schema so this is idempotent and safe on fresh installs.
        cols = {row["name"] for row in conn.execute(
            "PRAGMA table_info(board_cards)"
        ).fetchall()}
        if "h" not in cols:
            conn.execute("ALTER TABLE board_cards ADD COLUMN h REAL")
        if "image" not in cols:
            conn.execute("ALTER TABLE board_cards ADD COLUMN image TEXT")
        if "board_id" not in cols:
            conn.execute("ALTER TABLE board_cards ADD COLUMN board_id TEXT")
        ecols = {row["name"] for row in conn.execute(
            "PRAGMA table_info(board_edges)"
        ).fetchall()}
        if "board_id" not in ecols:
            conn.execute("ALTER TABLE board_edges ADD COLUMN board_id TEXT")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_board_cards_board ON board_cards(board_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_board_edges_board ON board_edges(board_id)"
        )
        # --- Migrate pre-existing single-board data: if there are board_cards
        #     rows but no boards yet, create a default board and backfill the
        #     board_id on every existing card/edge.
        board_count = conn.execute("SELECT COUNT(*) FROM boards").fetchone()[0]
        if board_count == 0:
            existing_cards = conn.execute("SELECT COUNT(*) FROM board_cards").fetchone()[0]
            if existing_cards > 0:
                now = datetime.now(timezone.utc).isoformat()
                default_id = uuid.uuid4().hex[:12]
                conn.execute(
                    "INSERT INTO boards (id, name, created_at, updated_at) VALUES (?,?,?,?)",
                    (default_id, "My board", now, now),
                )
                conn.execute("UPDATE board_cards SET board_id=?", (default_id,))
                conn.execute("UPDATE board_edges SET board_id=?", (default_id,))
            else:
                # No boards and no cards: create a starter board so the app never
                # opens to an empty boards list.
                now = datetime.now(timezone.utc).isoformat()
                conn.execute(
                    "INSERT INTO boards (id, name, created_at, updated_at) VALUES (?,?,?,?)",
                    (uuid.uuid4().hex[:12], "My board", now, now),
                )


def _derive_title(transcript: str, source: str) -> str:
    """A short human title from the first words of the transcript."""
    first_line = next((ln for ln in transcript.splitlines() if ln.strip()), "")
    # Drop the "Speaker N: " prefix for the title.
    body = re.sub(r"^Speaker \d+:\s*", "", first_line).strip()
    if body:
        return (body[:60] + "…") if len(body) > 60 else body
    return source or "Untitled recording"


def _save_session(*, transcript, segments, notes, source, audio_bytes, ext):
    """Persist a finished transcription; returns the row dict."""
    sid = uuid.uuid4().hex[:12]
    created_at = datetime.now(timezone.utc).isoformat()
    duration = max((s.get("end", 0) for s in segments), default=0)
    num_speakers = len({s["speaker"] for s in segments})
    title = _derive_title(transcript, source)

    audio_path = ""
    if audio_bytes:
        audio_file = AUDIO_DIR / f"{sid}{ext or '.bin'}"
        audio_file.write_bytes(audio_bytes)
        audio_path = str(audio_file.relative_to(BASE_DIR))

    with _db() as conn:
        conn.execute(
            "INSERT INTO sessions (id, created_at, title, source, duration, "
            "num_speakers, transcript, segments, notes, audio_path) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (sid, created_at, title, source, duration, num_speakers,
             transcript, json.dumps(segments), notes, audio_path),
        )
    return {"id": sid, "created_at": created_at, "title": title,
            "num_speakers": num_speakers, "duration": duration, "source": source}


def _list_sessions():
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, created_at, title, source, duration, num_speakers "
            "FROM sessions ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def _get_session(sid: str):
    with _db() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id=?", (sid,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["segments"] = json.loads(d["segments"] or "[]")
    return d


def _delete_session(sid: str) -> bool:
    row = _get_session(sid)
    if not row:
        return False
    if row.get("audio_path"):
        audio_file = BASE_DIR / row["audio_path"]
        try:
            audio_file.unlink(missing_ok=True)
        except OSError:
            pass
    with _db() as conn:
        conn.execute("DELETE FROM sessions WHERE id=?", (sid,))
    return True


def _rename_session(sid: str, title: str) -> bool:
    with _db() as conn:
        cur = conn.execute("UPDATE sessions SET title=? WHERE id=?", (title, sid))
        return cur.rowcount > 0


# ---------------------------------------------------------------------------
# General note taker — plain Markdown notes, no AI required
# ---------------------------------------------------------------------------
def _list_plain_notes():
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, title, created_at, updated_at "
            "FROM plain_notes ORDER BY updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def _get_plain_note(nid: str):
    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM plain_notes WHERE id=?", (nid,)
        ).fetchone()
    return dict(row) if row else None


def _create_plain_note(title: str, content: str) -> dict:
    nid = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    with _db() as conn:
        conn.execute(
            "INSERT INTO plain_notes (id, title, content, created_at, updated_at) "
            "VALUES (?,?,?,?,?)",
            (nid, title, content, now, now),
        )
    return {"id": nid, "title": title, "content": content,
            "created_at": now, "updated_at": now}


def _update_plain_note(nid: str, title: str | None, content: str | None) -> bool:
    now = datetime.now(timezone.utc).isoformat()
    with _db() as conn:
        if title is not None and content is not None:
            cur = conn.execute(
                "UPDATE plain_notes SET title=?, content=?, updated_at=? WHERE id=?",
                (title, content, now, nid),
            )
        elif title is not None:
            cur = conn.execute(
                "UPDATE plain_notes SET title=?, updated_at=? WHERE id=?",
                (title, now, nid),
            )
        elif content is not None:
            cur = conn.execute(
                "UPDATE plain_notes SET content=?, updated_at=? WHERE id=?",
                (content, now, nid),
            )
        else:
            return False
        return cur.rowcount > 0


def _delete_plain_note(nid: str) -> bool:
    with _db() as conn:
        cur = conn.execute("DELETE FROM plain_notes WHERE id=?", (nid,))
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Board — a Miro-style node canvas. Each board owns a set of nodes (notes +
# images) in board_cards and connectors in board_edges. The frontend treats
# localStorage `nt-board-<id>` as an offline cache; the server is the source of
# truth. Images are stored once under data/board_images and referenced by URL.
# ---------------------------------------------------------------------------
def _list_boards():
    with _db() as conn:
        rows = conn.execute(
            "SELECT b.id, b.name, b.source_session_id, b.created_at, b.updated_at, "
            "(SELECT COUNT(*) FROM board_cards c WHERE c.board_id = b.id) AS node_count "
            "FROM boards b ORDER BY b.updated_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def _get_board(bid: str):
    with _db() as conn:
        row = conn.execute("SELECT * FROM boards WHERE id=?", (bid,)).fetchone()
    return dict(row) if row else None


def _create_board(name: str, source_session_id: str = "") -> dict:
    bid = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat()
    with _db() as conn:
        conn.execute(
            "INSERT INTO boards (id, name, source_session_id, created_at, updated_at) "
            "VALUES (?,?,?,?,?)",
            (bid, name or "Untitled board", source_session_id or "", now, now),
        )
    return {"id": bid, "name": name or "Untitled board",
            "source_session_id": source_session_id or "",
            "created_at": now, "updated_at": now, "node_count": 0}


def _rename_board(bid: str, name: str) -> bool:
    now = datetime.now(timezone.utc).isoformat()
    with _db() as conn:
        cur = conn.execute(
            "UPDATE boards SET name=?, updated_at=? WHERE id=?", (name, now, bid)
        )
        return cur.rowcount > 0


def _delete_board(bid: str) -> bool:
    # Unlink any image files owned by this board's image nodes.
    with _db() as conn:
        rows = conn.execute(
            "SELECT image FROM board_cards WHERE board_id=? AND kind='image' AND image!=''",
            (bid,),
        ).fetchall()
    for row in rows:
        m = re.search(r"/api/board/image/([^/]+)$", row["image"] or "")
        if m:
            for cand in IMAGES_DIR.iterdir():
                if cand.is_file() and cand.stem == m.group(1):
                    try:
                        cand.unlink()
                    except OSError:
                        pass
    with _db() as conn:
        cur = conn.execute("DELETE FROM boards WHERE id=?", (bid,))
        conn.execute("DELETE FROM board_cards WHERE board_id=?", (bid,))
        conn.execute("DELETE FROM board_edges WHERE board_id=?", (bid,))
    return cur.rowcount > 0


def _first_board_id() -> str:
    with _db() as conn:
        row = conn.execute(
            "SELECT id FROM boards ORDER BY updated_at DESC LIMIT 1"
        ).fetchone()
    return row["id"] if row else ""


def _list_board_nodes(board_id: str):
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, x, y, w, h, text, c, kind, image FROM board_cards "
            "WHERE board_id=? ORDER BY updated_at ASC",
            (board_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def _list_board_edges(board_id: str):
    with _db() as conn:
        rows = conn.execute(
            "SELECT id, from_id, to_id, color, label FROM board_edges "
            "WHERE board_id=? ORDER BY updated_at ASC",
            (board_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def _replace_board(board_id: str, nodes: list[dict], edges: list[dict]):
    """Full replace of nodes and edges scoped to one board."""
    now = datetime.now(timezone.utc).isoformat()
    seen_node_ids = set()
    seen_edge_ids = set()
    with _db() as conn:
        conn.execute("DELETE FROM board_cards WHERE board_id=?", (board_id,))
        conn.execute("DELETE FROM board_edges WHERE board_id=?", (board_id,))
        for node in nodes or []:
            nid = str(node.get("id") or "").strip()
            if not nid or nid in seen_node_ids:
                continue
            seen_node_ids.add(nid)
            conn.execute(
                "INSERT INTO board_cards "
                "(id, x, y, w, h, text, c, kind, image, board_id, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    nid,
                    float(node.get("x") or 0),
                    float(node.get("y") or 0),
                    float(node.get("w") or 220),
                    float(node.get("h") or 160),
                    node.get("text") or "",
                    int(node.get("c") if node.get("c") is not None else (node.get("color") or 0)),
                    str(node.get("kind") or "note"),
                    node.get("image") or "",
                    board_id,
                    now,
                ),
            )
        for edge in edges or []:
            eid = str(edge.get("id") or "").strip()
            if not eid or eid in seen_edge_ids:
                continue
            seen_edge_ids.add(eid)
            conn.execute(
                "INSERT INTO board_edges "
                "(id, from_id, to_id, color, label, board_id, updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (
                    eid,
                    str(edge.get("from") or edge.get("from_id") or ""),
                    str(edge.get("to") or edge.get("to_id") or ""),
                    int(edge.get("color") or 0),
                    edge.get("label") or "",
                    board_id,
                    now,
                ),
            )


def _append_board_nodes(board_id: str, new_nodes: list[dict]) -> list[dict]:
    """Append nodes to a board (used by the from-notes flow). Returns the inserted."""
    now = datetime.now(timezone.utc).isoformat()
    inserted = []
    with _db() as conn:
        for node in new_nodes:
            nid = str(node.get("id") or uuid.uuid4().hex[:12]).strip()
            conn.execute(
                "INSERT INTO board_cards "
                "(id, x, y, w, h, text, c, kind, image, board_id, updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    nid,
                    float(node.get("x") or 0),
                    float(node.get("y") or 0),
                    float(node.get("w") or 240),
                    float(node.get("h") or 150),
                    node.get("text") or "",
                    int(node.get("c") or 0),
                    str(node.get("kind") or "note"),
                    node.get("image") or "",
                    board_id,
                    now,
                ),
            )
            inserted.append({"id": nid, "text": node.get("text") or ""})
    return inserted


def _clear_board(board_id: str):
    with _db() as conn:
        conn.execute("DELETE FROM board_cards WHERE board_id=?", (board_id,))
        conn.execute("DELETE FROM board_edges WHERE board_id=?", (board_id,))


def _notes_to_nodes(notes_markdown: str) -> list[dict]:
    """Split AI meeting notes (markdown) into one node per top-level section.

    The notes prompt produces Summary / Key Points / Decisions / Action Items
    sections. Each becomes its own node, laid out in a gentle cascade. Falls
    back to a single node if there are no headings.
    """
    if not notes_markdown or not notes_markdown.strip():
        return []
    # Split on markdown headings (# or ##), keeping the heading with its body.
    parts = re.split(r"(?m)^(#{1,2}\s+.*)$", notes_markdown)
    sections = []
    # re.split produces [pre, heading, body, heading, body, ...]; reassemble.
    i = 1
    if len(parts) == 1:
        sections = [notes_markdown.strip()]
    else:
        if parts[0].strip():
            sections.append(parts[0].strip())
        while i < len(parts):
            heading = parts[i].strip()
            body = parts[i + 1].strip() if i + 1 < len(parts) else ""
            sections.append((heading + "\n" + body).strip() if body else heading)
            i += 2
    nodes = []
    for idx, text in enumerate(sections):
        if not text.strip():
            continue
        col = idx % 5  # cycle through speaker colors
        nodes.append({
            "x": 80 + (idx % 4) * 280,
            "y": 80 + (idx // 4) * 200,
            "w": 260, "h": 160,
            "text": text, "c": col, "kind": "note", "image": "",
        })
    return nodes


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
# HTML pages are served no-cache so an app update (new frontend) can never be
# masked by the WebView2 disk cache re-serving an old index.html.
_NO_CACHE = {"Cache-Control": "no-cache, no-store, must-revalidate"}


@app.get("/")
async def index():
    # The app opens straight into the Board — the primary canvas workspace — so it
    # feels like an app, not a marketing landing page. The sidebar on every screen
    # reaches the rest of the app. The launcher is still served at /index.html and
    # /launcher.html for an optional "home" view.
    return FileResponse(STATIC_DIR / "board.html", headers=_NO_CACHE)


@app.get("/launcher.html")
async def launcher():
    return FileResponse(STATIC_DIR / "index.html", headers=_NO_CACHE)


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
    source = file.filename or "recording"

    def event_stream():
        import whisperx

        t0 = time.time()

        def evt(type_, **kw):
            return json.dumps(
                {"type": type_, "elapsed": round(time.time() - t0, 1), **kw}
            ) + "\n"

        tmp_path = None
        try:
            # Models load lazily here (first transcription), not at startup.
            if STATE["whisper_model"] is None:
                yield evt(
                    "progress",
                    stage="Loading speech model (first run may download it)",
                    pct=2,
                )
                _ensure_whisper()

            yield evt("progress", stage="Preparing audio", pct=5)
            with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
                tmp.write(audio_bytes)
                tmp_path = tmp.name
            audio = whisperx.load_audio(tmp_path)

            yield evt("progress", stage="Transcribing", pct=12)
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
            if _ensure_diarizer() is not None:
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

            # Persist the finished session so it survives restarts.
            saved = None
            try:
                saved = _save_session(
                    transcript=transcript, segments=segments, notes=notes,
                    source=source, audio_bytes=audio_bytes, ext=ext,
                )
            except Exception as exc:  # noqa: BLE001
                print(f"[transcribe] WARNING: could not save session: {exc}")

            yield evt(
                "result", pct=100,
                transcript=transcript, segments=segments, notes=notes,
                num_speakers=num_speakers, warning=warning, session=saved,
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


# --- Board canvas (Miro-style nodes + edges) ---
class BoardNode(BaseModel):
    id: str
    x: float = 0.0
    y: float = 0.0
    w: float = 220.0
    h: float = 160.0
    text: str = ""
    c: int = 0
    kind: str = "note"
    image: str = ""


class BoardEdge(BaseModel):
    id: str
    # Accept either the frontend's `from`/`to` keys or the storage `from_id`/`to_id`.
    from_id: str = ""
    to_id: str = ""
    color: int = 0
    label: str = ""

    model_config = {"populate_by_name": True, "extra": "ignore"}

    @classmethod
    def from_frontend(cls, d: dict) -> "BoardEdge":
        """Build from a frontend edge dict that uses `from`/`to` keys."""
        return cls(
            id=d.get("id", ""),
            from_id=d.get("from") or d.get("from_id") or "",
            to_id=d.get("to") or d.get("to_id") or "",
            color=int(d.get("color") or 0),
            label=d.get("label") or "",
        )


class BoardState(BaseModel):
    nodes: list[BoardNode] = []
    # Edges are accepted as raw dicts because the frontend uses `from`/`to`
    # (a Python keyword) and we normalise to from_id/to_id for storage.
    edges: list[dict] = []
    # Back-compat: older clients still PUT { cards: [...] } with no edges.
    cards: list[BoardNode] | None = None


# --- Board CRUD (multiple named boards) ---
class BoardCreateReq(BaseModel):
    name: str = ""
    source_session_id: str = ""


class BoardRenameReq(BaseModel):
    name: str


class FromNotesReq(BaseModel):
    notes_markdown: str = ""
    title: str = ""


def _resolve_board(bid: str) -> str:
    """Resolve a board id, falling back to the first board. 404 if none exist."""
    if bid and _get_board(bid):
        return bid
    first = _first_board_id()
    if not first:
        raise HTTPException(status_code=404, detail="No boards exist.")
    return first


@app.get("/api/boards")
async def list_boards():
    return {"boards": _list_boards()}


@app.post("/api/boards")
async def create_board(req: BoardCreateReq):
    return _create_board(req.name, req.source_session_id)


@app.patch("/api/boards/{bid}")
async def rename_board(bid: str, req: BoardRenameReq):
    if not _rename_board(bid, req.name.strip()):
        raise HTTPException(status_code=404, detail="Board not found.")
    return {"id": bid, "name": req.name.strip()}


@app.delete("/api/boards/{bid}")
async def delete_board(bid: str):
    if not _delete_board(bid):
        raise HTTPException(status_code=404, detail="Board not found.")
    return {"deleted": bid}


@app.get("/api/all-notes")
async def all_notes():
    """Flatten all board nodes across all boards into a single searchable list.
    Used by the Library page — board nodes ARE the notes now."""
    result = []
    for board in _list_boards():
        for node in _list_board_nodes(board["id"]):
            if node.get("kind") == "image" and not node.get("text"):
                continue  # skip pure image nodes with no text
            # strip HTML for a plain-text preview
            raw = node.get("text") or ""
            preview = re.sub(r"<[^>]+>", " ", raw).replace("&nbsp;", " ").strip()[:120]
            result.append({
                "id": node["id"],
                "title": node.get("text", "").split("\n")[0][:60]
                          if not node.get("text", "").strip().startswith("<")
                          else preview[:60],
                "preview": preview,
                "board_id": board["id"],
                "board_name": board["name"],
                "kind": node.get("kind", "note"),
                "color": node.get("c", 0),
            })
    return {"notes": result}


@app.get("/api/boards/{bid}")
async def get_board_scoped(bid: str):
    bid = _resolve_board(bid)
    board = _get_board(bid)
    return {"board": board, "nodes": _list_board_nodes(bid), "edges": _list_board_edges(bid)}


@app.put("/api/boards/{bid}")
async def replace_board_scoped(bid: str, req: BoardState):
    bid = _resolve_board(bid)
    nodes = req.nodes if req.nodes else (req.cards or [])
    edges = [
        {"id": e.get("id", ""),
         "from_id": e.get("from") or e.get("from_id") or "",
         "to_id": e.get("to") or e.get("to_id") or "",
         "color": int(e.get("color") or 0),
         "label": e.get("label") or ""}
        for e in req.edges
    ]
    node_dicts = [n.model_dump() for n in nodes]
    _replace_board(bid, node_dicts, edges)
    return {"nodes": _list_board_nodes(bid), "edges": _list_board_edges(bid)}


@app.delete("/api/boards/{bid}/clear")
async def clear_board_scoped(bid: str):
    bid = _resolve_board(bid)
    _clear_board(bid)
    return {"deleted": True}


@app.post("/api/boards/{bid}/from-notes")
async def add_nodes_from_notes(bid: str, req: FromNotesReq):
    """Append AI notes as one-node-per-section to a board. Used by the
    post-transcribe 'send to board' flow."""
    bid = _resolve_board(bid)
    new_nodes = _notes_to_nodes(req.notes_markdown)
    if not new_nodes:
        raise HTTPException(status_code=400, detail="No notes to add.")
    inserted = _append_board_nodes(bid, new_nodes)
    return {"board_id": bid, "added": inserted, "count": len(inserted)}


# --- Back-compat aliases to the default/first board ---
@app.get("/api/board")
async def get_board():
    bid = _first_board_id()
    nodes = _list_board_nodes(bid) if bid else []
    return {"nodes": nodes, "edges": _list_board_edges(bid) if bid else [], "cards": nodes}


@app.put("/api/board")
async def replace_board(req: BoardState):
    bid = _first_board_id()
    if not bid:
        raise HTTPException(status_code=404, detail="No boards exist.")
    nodes = req.nodes if req.nodes else (req.cards or [])
    edges = [
        {"id": e.get("id", ""),
         "from_id": e.get("from") or e.get("from_id") or "",
         "to_id": e.get("to") or e.get("to_id") or "",
         "color": int(e.get("color") or 0),
         "label": e.get("label") or ""}
        for e in req.edges
    ]
    node_dicts = [n.model_dump() for n in nodes]
    _replace_board(bid, node_dicts, edges)
    return {"nodes": _list_board_nodes(bid), "edges": _list_board_edges(bid)}


@app.delete("/api/board")
async def clear_board():
    bid = _first_board_id()
    if bid:
        _clear_board(bid)
    return {"deleted": True}


class BoardChatRequest(BaseModel):
    cards: list[BoardNode] = []
    nodes: list[BoardNode] = []
    messages: list[ChatMessage] = []


@app.post("/api/board/chat")
async def board_chat(req: BoardChatRequest):
    # Accept either legacy `cards` or the new `nodes` field.
    nodes = req.nodes if req.nodes else req.cards
    cards = [n.model_dump() for n in nodes]
    context = _cards_to_context(cards)
    system_prompt = BOARD_SYSTEM_PROMPT_TEMPLATE.format(cards=context)
    messages = [{"role": m.role, "content": m.content} for m in req.messages]
    reply = _ollama_chat(system_prompt, messages)
    return {"reply": reply}


# --- Board images (stored once, referenced by URL in node JSON) ---
@app.post("/api/board/image")
async def upload_board_image(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Unsupported image type '{ext}'. Allowed: "
                f"{', '.join(sorted(ALLOWED_IMAGE_EXTENSIONS))}."
            ),
        )
    data = await file.read()
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Image too large ({len(data)} bytes). Limit is {MAX_IMAGE_BYTES // (1024*1024)} MB.",
        )
    img_id = uuid.uuid4().hex[:16]
    dest = IMAGES_DIR / f"{img_id}{ext}"
    dest.write_bytes(data)
    return {"id": img_id, "url": f"/api/board/image/{img_id}", "ext": ext}


@app.get("/api/board/image/{imgid}")
async def get_board_image(imgid: str):
    # Match the stored file regardless of its extension.
    for cand in IMAGES_DIR.iterdir():
        if cand.is_file() and cand.stem == imgid:
            return FileResponse(cand)
    raise HTTPException(status_code=404, detail="Image not found.")


@app.delete("/api/board/image/{imgid}")
async def delete_board_image(imgid: str):
    removed = False
    for cand in IMAGES_DIR.iterdir():
        if cand.is_file() and cand.stem == imgid:
            try:
                cand.unlink()
            except OSError:
                pass
            removed = True
    if not removed:
        raise HTTPException(status_code=404, detail="Image not found.")
    return {"deleted": imgid}


# --- Session library ---
class RenameRequest(BaseModel):
    title: str


@app.get("/api/sessions")
async def list_sessions():
    return _list_sessions()


@app.get("/api/sessions/{sid}")
async def get_session(sid: str):
    row = _get_session(sid)
    if not row:
        raise HTTPException(status_code=404, detail="Session not found.")
    row.pop("audio_path", None)
    row["audio_url"] = f"/api/sessions/{sid}/audio"
    return row


@app.get("/api/sessions/{sid}/audio")
async def get_session_audio(sid: str):
    row = _get_session(sid)
    if not row or not row.get("audio_path"):
        raise HTTPException(status_code=404, detail="No audio for this session.")
    audio_file = BASE_DIR / row["audio_path"]
    if not audio_file.exists():
        raise HTTPException(status_code=404, detail="Audio file missing.")
    return FileResponse(audio_file)


@app.patch("/api/sessions/{sid}")
async def rename_session(sid: str, req: RenameRequest):
    title = req.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="Title cannot be empty.")
    if not _rename_session(sid, title):
        raise HTTPException(status_code=404, detail="Session not found.")
    return {"id": sid, "title": title}


@app.delete("/api/sessions/{sid}")
async def delete_session(sid: str):
    if not _delete_session(sid):
        raise HTTPException(status_code=404, detail="Session not found.")
    return {"deleted": sid}


# --- General note taker (no AI required) ---
class NoteCreate(BaseModel):
    title: str
    content: str = ""


class NoteUpdate(BaseModel):
    title: str | None = None
    content: str | None = None


@app.get("/api/notes")
async def list_plain_notes():
    return _list_plain_notes()


@app.post("/api/notes")
async def create_plain_note(req: NoteCreate):
    title = req.title.strip() or "Untitled note"
    return _create_plain_note(title, req.content)


@app.get("/api/notes/{nid}")
async def get_plain_note(nid: str):
    note = _get_plain_note(nid)
    if not note:
        raise HTTPException(status_code=404, detail="Note not found.")
    return note


@app.patch("/api/notes/{nid}")
async def update_plain_note(nid: str, req: NoteUpdate):
    if req.title is not None:
        req.title = req.title.strip()
    if not _update_plain_note(nid, req.title, req.content):
        raise HTTPException(status_code=404, detail="Note not found.")
    return _get_plain_note(nid)


@app.delete("/api/notes/{nid}")
async def delete_plain_note(nid: str):
    if not _delete_plain_note(nid):
        raise HTTPException(status_code=404, detail="Note not found.")
    return {"deleted": nid}


# --- Runtime status (so the UI can show what's loaded / available) ---
@app.get("/api/status")
async def status():
    ollama_ok = False
    try:
        import ollama
        ollama.Client(host=OLLAMA_HOST).list()
        ollama_ok = True
    except Exception:  # noqa: BLE001
        ollama_ok = False

    cuda = False
    try:
        import torch
        cuda = torch.cuda.is_available()
    except Exception:  # noqa: BLE001
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


@app.get("/api/library-size")
async def library_size():
    """Local storage footprint: SQLite db + recorded audio + board images."""
    total = 0
    if DB_PATH.exists():
        total += DB_PATH.stat().st_size
    for d in (AUDIO_DIR, IMAGES_DIR):
        if d.exists():
            for f in d.iterdir():
                if f.is_file():
                    total += f.stat().st_size
    return {"bytes": total}


@app.get("/api/export")
async def export_library():
    """Stream a zip of the SQLite database + recorded audio + board images."""
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        if DB_PATH.exists():
            zf.write(DB_PATH, arcname=DB_PATH.name)
        if AUDIO_DIR.exists():
            for f in sorted(AUDIO_DIR.iterdir()):
                if f.is_file():
                    zf.write(f, arcname=f"audio/{f.name}")
        if IMAGES_DIR.exists():
            for f in sorted(IMAGES_DIR.iterdir()):
                if f.is_file():
                    zf.write(f, arcname=f"board_images/{f.name}")
    buf.seek(0)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="notetaker-library-{stamp}.zip"'},
    )


# --- Multi-screen page routes ---
# The launcher is served at "/" (FileResponse above). The other screens live
# under /static and the in-page links use relative paths ("board.html"), so
# they must also resolve at the root to keep nav working from the launcher.
_SCREENS = {"index", "library", "editor", "record", "board", "settings"}


@app.get("/{page}.html")
async def screen(page: str):
    if page not in _SCREENS:
        raise HTTPException(status_code=404, detail="Page not found.")
    file = STATIC_DIR / f"{page}.html"
    if not file.is_file():
        raise HTTPException(status_code=404, detail="Page not found.")
    return FileResponse(file, headers=_NO_CACHE)


# Static assets. The HTML references assets as relative "assets/..." which, from
# the root-served pages, resolves to "/assets/...". Mount that explicitly, plus
# the canonical "/static" mount for direct references.
# A middleware stamps no-cache on HTML/CSS/JS so WebView2 can't mask an updated
# frontend with a stale on-disk copy of the assets.
@app.middleware("http")
async def _no_cache_static(request, call_next):
    response = await call_next(request)
    path = request.url.path.lower()
    if path.endswith((".html", ".css", ".js")):
        response.headers.setdefault("Cache-Control", "no-cache, no-store, must-revalidate")
    return response

app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
