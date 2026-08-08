# AI Note-Taker

A fully **local** note taker that works two ways:

**📝 General notes (no AI needed).** A plain Markdown note editor — create,
edit, preview, searchless-but-simple library of notes stored in SQLite.
The app **starts instantly** (~2s) and needs no GPU, no Ollama, and no models.

**🎙️ AI transcription (on demand).** Upload an audio or video recording and it

1. **Transcribes** it and **identifies speakers** (Speaker 1, Speaker 2, …) with WhisperX.
2. **Generates structured notes** from the speaker-labeled transcript using a local LLM (Ollama / Qwen3).
3. Shows the **transcript** and the **notes** in the browser.
4. Lets you **chat** with the local LLM about the recording.
5. **Saves every session** to a local library so you can revisit, rename, or delete past recordings.

The WhisperX / diarization models load **lazily on first transcription**
— not at startup — and Ollama is only contacted when you actually need
notes or chat. No external APIs, no API keys, no cloud calls — everything
runs on your machine. Target hardware: a GPU with ~12 GB VRAM.

## Pipeline

Each recording runs through these stages — green runs on the **GPU**, grey on the
**CPU**. Transcription/alignment/diarization can run on either device
(`WHISPER_DEVICE`); the LLM (notes + chat) always runs on the GPU via Ollama.

<p align="center">
  <img src="docs/pipeline.svg" alt="AI Note-Taker pipeline" width="560">
</p>

---

## Prerequisites

### 1. Ollama (the local LLM)
Install [Ollama](https://ollama.com/), then pull a model:

```bash
ollama pull qwen3:14b      # default (~9 GB VRAM)
# or, for more speed / less VRAM:
ollama pull qwen3:8b
```

Ollama serves at `http://localhost:11434` by default. Leave it running.

### 2. ffmpeg (required by WhisperX)
WhisperX uses ffmpeg to decode audio/video.

- **Windows:** `winget install ffmpeg` (or `choco install ffmpeg`), or download from
  https://ffmpeg.org and add the `bin` folder to your `PATH`.
- **macOS:** `brew install ffmpeg`
- **Linux:** `sudo apt install ffmpeg`

Verify with `ffmpeg -version`.

### 3. Hugging Face token (for speaker diarization)
The pyannote diarization model requires a free Hugging Face account:

1. Create an account at https://huggingface.co.
2. Accept the model terms (visit each model page and click *Agree*). The
   installed WhisperX (3.8.x / pyannote-audio 4.x) defaults to
   **`pyannote/speaker-diarization-community-1`**, so accept that one. Older
   WhisperX used `pyannote/speaker-diarization-3.1` (+ `pyannote/segmentation-3.0`);
   accepting those too does no harm.
3. Create an access token: https://huggingface.co/settings/tokens.
4. Put it in your `.env` as `HF_TOKEN` (see below).

> Without `HF_TOKEN`, transcription still works but everything is labeled
> "Speaker 1" (no diarization).

---

## Install

```bash
python -m venv .venv
# Windows (PowerShell):
.\.venv\Scripts\Activate.ps1
# macOS / Linux:
# source .venv/bin/activate
```

**Install PyTorch first**, matching your setup — WhisperX depends on it and the
right build is not installed automatically. Pick the command from
https://pytorch.org/get-started/locally/. Examples:

```bash
# NVIDIA GPU (CUDA 12.1):
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121

# CPU only:
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
```

Then install the rest:

```bash
pip install -r requirements.txt
```

Copy the env template and fill it in:

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

Edit `.env` and set `HF_TOKEN`. Defaults for everything else are fine.

---

## Run

Run uvicorn **from the venv**. Either activate it first:

```powershell
# Windows (PowerShell):
.\.venv\Scripts\Activate.ps1   # prompt should now show (.venv)
python -m uvicorn app:app --reload
```

…or, without activating, call the venv's Python directly (foolproof):

```powershell
.\.venv\Scripts\python.exe -m uvicorn app:app --reload
```

> ⚠️ Don't run bare `uvicorn app:app` unless the venv is activated — a global
> `uvicorn` will use the wrong Python and fail with `ModuleNotFoundError: No
> module named 'dotenv'`.

Open http://localhost:8000, choose a recording (`.mp3 .mp4 .m4a .wav .mov .webm`),
and click **Transcribe** — or just start typing a plain note: that works
immediately with no setup at all.

> ⏳ **First transcription is slow:** the Whisper + alignment + diarization
> models download and load the first time you transcribe (not at startup —
> the app itself opens in ~2s). They are cached afterwards.
>
> ⚡ **Faster transcription startup:** once the models are cached, set `HF_HUB_OFFLINE=1` in
> `.env` to skip Hugging Face's per-launch update checks — this cuts model
> load time from ~50s to ~12s. (Set it back to `0` if you change `WHISPER_MODEL` to one
> you haven't downloaded yet.)

### Desktop app

Prefer a native window instead of the browser? Run:

```powershell
.\.venv\Scripts\python.exe desktop.py
```

This starts the server for you and opens the app in a **real native window**
(pywebview + the OS WebView2 engine) — its own title bar, taskbar entry and
icon, no browser chrome. It shows an instant splash while the models load and
swaps to the app once the server is ready. It also adds a **system-tray icon**:
closing the window hides it to the tray (the server keeps running); click the
tray icon to reopen, or right-click → **Quit** to exit fully. On Windows,
double-clicking `notetaker.bat` does the same (no console window).

> **Reliability / fallback.** Embedding the WebView2 *controller* occasionally
> fails on Windows (`HRESULT 0x8007139F`, "the group or resource is not in the
> correct state") and the native window won't appear. When that happens the
> launcher automatically falls back to a chromeless browser app-window
> (Edge/Chrome `--app=`, or your default browser) so the app *always* opens.
> Under `pythonw` (no console) startup is logged to
> `%LOCALAPPDATA%\AINoteTaker\desktop.log` for troubleshooting.

---

## Configuration (`.env`)

| Variable               | Default                  | Notes                                                   |
| ---------------------- | ------------------------ | ------------------------------------------------------- |
| `OLLAMA_MODEL`         | `qwen3:14b`              | Use `qwen3:8b` for more speed.                          |
| `OLLAMA_HOST`          | `http://localhost:11434` | Local Ollama server.                                    |
| `WHISPER_MODEL`        | `base`                   | `tiny`/`base`/`small`/`medium`/`large-v3`. `large-v3-turbo` = multilingual + fast; `distil-large-v3` = English-only, fastest. |
| `WHISPER_LANGUAGE`     | *(empty)*                | Empty = **auto-detect** the language per recording. Set e.g. `en`/`ar` to force one. (English-only models like `distil-large-v3` ignore this.) |
| `WHISPER_DEVICE`       | `cpu`                    | `cuda` to run WhisperX on the GPU (needs spare VRAM).   |
| `WHISPER_COMPUTE_TYPE` | `int8`                   | Use `float16` on GPU.                                   |
| `HF_TOKEN`             | *(empty)*                | Required for speaker diarization.                       |

### VRAM plan (12 GB)
- Run the **LLM on the GPU** (`qwen3:14b` ≈ 9 GB).
- Run **WhisperX on the CPU** (`WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`).
  It's a one-shot batch step, so CPU is fine and the GPU stays free for the model.
- **Alternative (GPU transcription):** use a small Whisper model
  (`WHISPER_MODEL=small`, `WHISPER_DEVICE=cuda`, `WHISPER_COMPUTE_TYPE=float16`)
  together with `qwen3:8b` so both fit in 12 GB.

### GPU transcription (optional)
Running WhisperX on the GPU is much faster than CPU. To enable it:

1. Install the **CUDA build of PyTorch** (matching your CUDA version), e.g.:
   ```bash
   pip install --upgrade "torch==2.8.0" "torchaudio==2.8.0" --index-url https://download.pytorch.org/whl/cu128
   ```
   (The CUDA build also runs CPU mode, so you don't need a separate environment.)
2. Set in `.env`: `WHISPER_DEVICE=cuda` and `WHISPER_COMPUTE_TYPE=float16`.
3. Restart. The app prints the detected GPU at startup, and exposes torch's
   bundled cuDNN/cuBLAS to CTranslate2 automatically (no separate cuDNN install).

If CUDA isn't actually available, the app warns and falls back to CPU. Watch
VRAM: WhisperX on GPU shares the card with Ollama, so a heavy LLM + a game can
exhaust 12 GB.

---

## How it works

- `GET /` — single-page frontend with a **Notes** section (plain Markdown
  notes, no AI) and a **Recordings** section (AI sessions).
- `GET/POST/PATCH/DELETE /api/notes[/{id}]` — the general note taker: plain
  Markdown notes stored in the same SQLite db. Works with no GPU / Ollama /
  WhisperX installed.
- `POST /api/transcribe` — saves the upload to a temp file, lazily loads
  WhisperX (transcribe → align → diarize → assign speakers), builds a
  speaker-labeled `transcript` + `segments`, generates `notes` via Ollama,
  and returns `{ transcript, segments, notes }`.
- `POST /api/chat` — body `{ transcript, messages }`. The transcript is sent in
  the system prompt with each request (the backend is **stateless**); returns
  `{ reply }`.
- `GET /api/status` — what's loaded right now (Whisper model, diarization,
  Ollama reachability, CUDA) so the UI can show "AI ready / on demand".
- `GET/PATCH/DELETE /api/sessions[/{id}]` — the saved-session library. Each
  finished transcription is stored in a local SQLite db (`data/sessions.db`)
  with its audio under `data/audio/`, so it survives restarts.

`SPEAKER_00 / SPEAKER_01 / …` from WhisperX are mapped to `Speaker 1 / Speaker 2`
in order of first appearance.

## Project structure

```
app.py              FastAPI backend (WhisperX + Ollama + notes + sessions)
desktop.py          Native desktop window launcher (pywebview)
requirements.txt
static/index.html   Single-page frontend (notes editor + transcription UI)
docs/pipeline.svg   Pipeline diagram
data/               Saved sessions + plain notes (SQLite) + audio — git-ignored, created at runtime
.env.example
README.md
```

## Not included (future polish)
Renaming speakers within the transcript, setting the expected number of speakers,
chunking very long recordings, audio playback synced to the transcript, search
across saved sessions and notes, and exporting notes/transcripts to files.
