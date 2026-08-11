# note·taker — Project Guide for AI Agents

Everything an AI agent (or new session) needs to work on this project correctly and avoid the traps we hit before.

## What this app is

**note·taker** is a Windows desktop app for turning voice recordings into structured visual notes:

1. **Capture** — record audio (mic / system audio), stream-transcribe with WhisperX (speaker diarization), generate AI notes.
2. **Board** — a Miro-style infinite canvas with notes, image references, container folders, layout groups, connectors, tags, and an AI chat that answers questions about the board.
3. **Workspace** — a container card opens as a Notion-style list view with quick-add.
4. **Library / Settings** — past recordings, palette/theme/AI config.
5. Ships as a signed, auto-updating NSIS installer from GitHub releases.

## Repo layout

- Workspace root = git repo root (`S:\!Dev\AI note taker\New AI note taker`). Git paths are prefixed `tauri-app/...`.
- `.env` (repo root) — local AI config: **Ollama** (`qwen3:8b`, `localhost:11434`), **WhisperX** (`large-v3-turbo`, CUDA), pyannote diarization. **Contains a real `HF_TOKEN` secret — never print it, never commit it.**
- The app lives entirely in **`tauri-app/`**. (Older Python/pywebview app was removed; `data/`, `__pycache__`, `_*.log` at root are leftovers.)
- `src-tauri/tauri.key` (+ `.key.pub`) — updater signing key. **Gitignored. Never delete, never regenerate** (see Signing below).

## Architecture

| Layer | Tech | Where |
|---|---|---|
| Shell + UI | React 19 + TypeScript + Vite | `tauri-app/src/` |
| State | Zustand (single store) | `src/store/boardStore.ts`, `tagStore.ts` |
| Editor | TipTap 2 (ProseMirror), custom extensions | `src/components/editor/` + `src/lib/editor/extensions.ts` |
| Backend IPC | Rust (Tauri 2), commands | `src-tauri/src/lib.rs`, `commands.rs` |
| Database | SQLite via rusqlite (bundled) | `src-tauri/src/db.rs` |
| AI sidecar | Python FastAPI (WhisperX local, always; Ollama or OpenAI-compatible API for chat) | `src-tauri/python/sidecar.py` (bundled into installer) |

### Frontend code map (`tauri-app/src/`)

- `App.tsx` — everything: titlebar, sidebar (boards), toolbar, board canvas, pan/zoom, selection, drag/resize, image paste/drop, internal-link navigation, board AI chat, trash panel, **Markdown export**, workspace list view.
- `components/`
  - `BoardNode.tsx` — a board card: note / reference (image) / container / group; inline TipTap editor, tags, drag, 8-way resize, image wheel-zoom, children chips, bubble format bar.
  - `BoardEdge.tsx` — SVG connector with label + delete.
  - `NoteModal.tsx` — fullscreen-ish focused editor (rich toolbar).
  - `Capture.tsx` — recording + streaming transcription UI.
  - `Library.tsx` — past recording sessions.
  - `Settings.tsx` — palette/theme/density, recording options, AI model info, data location.
  - `UpdateModal.tsx` — `useUpdater` hook + changelog/download/install UI.
  - `ContextMenu.tsx`, `editor/format.tsx` (toolbars + link picker), `editor/slashMenu.tsx`, `editor/tagMenu.tsx`, `editor/RichEditor.tsx`.
- `lib/`
  - `types.ts` — TS interfaces; **mirror of the Rust structs** (`BoardNode.kind`: `note | reference | node | group`).
  - `tauri.ts` — `invoke()` wrappers for every Rust command + window controls.
  - `editor/markdown.ts` — TipTap JSON → Markdown (`docToMarkdown`), `htmlToText`. `internalLink` marks render as `[[label]]`.
  - `editor/extensions.ts` — all TipTap extensions, **InternalLink mark** + `setInternalLinkHandler()` navigation hook.
  - `exportBoard.ts` — `buildBoardMarkdown()` AI-oriented board export.
  - `dialogs.tsx` — `showPrompt` / `showConfirm` / `showCustom(title, body)` dialog host.
  - `toast.tsx`, `markdown.ts` (render for chat).
- `store/boardStore.ts` — nodes, edges, view, selection, tag filter, trash, undo/redo history, `scheduleSave()` (debounced `put_board`).

### Rust code map (`tauri-app/src-tauri/src/`)

- `lib.rs` — Tauri builder, `AppState { db, sidecar }`, command registration, `boardimg://` protocol handler (serves `data/board_images/*`), `save_markdown_export`, startup migration of legacy portable data → OS app-data dir.
- `commands.rs` — board CRUD (list/create/get/put/delete/rename), tags, trash commands.
- `db.rs` — SQLite schema + queries.
- `ai_sidecar.rs` — spawns the bundled Python sidecar (prefers a `.venv` next to the script, then PATH); `get_sidecar_url` lazily starts it (port 8766) and waits for the port to open (30 s timeout, output streamed to `data/sidecar.log`).

### Data

- DB + images live in the **OS app-data dir** (`.../note.taker/data/sessions.db` + `board_images/`). A one-time migration copies legacy portable `data/` next to the exe.
- Schema: `boards`, `board_cards` (x, y, w, h, text, c=color 0-5, kind, image, parent_id, tags…), `board_edges` (from_id, to_id, color, label), `tags`, `trash`.

## How we operate

### Communication style
- Be concise. No emojis unless asked. Fewer than ~4 lines when answering questions.
- The user runs long builds themselves and dislikes waiting on agent-side builds. For a release, prepare everything (version bumps, docs, release notes) and give the user **one copy-paste command**, then continue when they say "done".
- All conversation here is English; the app UI is bilingual (English/Arabic, RTL supported via `dir: auto`).

### Dev loop
- `npm run dev` (vite dev server, port 1420) or `npm run tauri dev` for the full shell.
- Typecheck + build frontend: `npm run build` (`tsc && vite build`) — run this before declaring any TS work done.
- Rust check: `cargo check` in `src-tauri/`.
- Tauri CLI quirk: `npx tauri ...` mangles args. Use `node node_modules\@tauri-apps\cli\tauri.js <cmd>` for the CLI directly (e.g. `signer`).

### Release workflow (beta flow — follows this exactly)
1. Bump version in **both** `src-tauri/tauri.conf.json` (`"version"` **and** the updater `endpoints` URL `.../download/v0.2.0-beta.N/latest.json`) and `src-tauri/Cargo.toml`.
2. User builds:
   ```powershell
   cd "S:\!Dev\AI note taker\New AI note taker\tauri-app"
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "src-tauri\tauri.key" -Raw; $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''; npm run tauri build
   ```
   Press **Enter** when it prompts for the password (the key has an empty password). Output lands in `src-tauri\target\release\bundle\nsis\`.
3. **Write `latest.json` manually** (the build's copy is stale) with: `version`, `platforms."windows-x86_64".{url, signature}`, `pub_date`, `notes`. The `url` uses the **`note.taker_0.2.0-beta.N_x64-setup.exe`** asset name (dot instead of the `·` in the file name), and `signature` = the `.sig` file content verbatim.
4. Create the release (assets: exe renamed to dot form, `.sig`, `latest.json`):
   ```
   gh release create v0.2.0-beta.N "src-tauri\target\release\bundle\nsis\note·taker_0.2.0-beta.N_x64-setup.exe#note.taker_0.2.0-beta.N_x64-setup.exe" "...exe.sig" "...latest.json" --title "v0.2.0-beta.N" --notes "..."
   ```
5. **Critical rule**: the updater endpoint is **version-pinned** (each build checks `v0.2.0-beta.N/latest.json`). After shipping N+1, you MUST re-upload the new `latest.json` to the previous release too: `gh release upload v0.2.0-beta.N latest.json --clobber` — otherwise installed users see "up to date" forever.

### Signing key — do not break this
- `src-tauri/tauri.key` + `.pub` (gitignored). Pubkey is baked into `tauri.conf.json` and into every compiled exe.
- It was **rotated at beta.4** because the old key's password was lost. Consequences: beta.2/3 installers (old pubkey) can never auto-update again — they're stuck unless the user reinstalls manually. The new key (id `98C11F90F78AACD9`) has an **empty password**.
- Never regenerate the key again — it silently kills auto-update for everyone on the current build. If a password prompt appears, press Enter.

### Git
- Only commit when explicitly asked. There is a large amount of uncommitted work in the repo (features shipped in beta.3–5 are mostly uncommitted).
- Release tags: `v0.2.0-beta.N` on GitHub (Zeen1th/ai-note-taker); beta.3+ are non-prerelease "Latest".

## Known pitfalls / traps
- `latest.json` staleness (see step 5 above) — the #1 update bug.
- Old key rotation history — never repeat it.
- `npx tauri` arg mangling — use the node wrapper path directly.
- `store_board_image` takes `Vec<u8>` by value; the unused-variable (`pad`) and used-before-declaration TS errors will be caught by `npm run build`.
- Board `kind` strings are `note|reference|node|group` — keep TS and Rust in sync.
- `latest.json`/`.sig`/installer must all be consistent — the updater verifies the signature against the pubkey in the running app.
- **AI engine needs its own Python env**: `src-tauri/python/.venv` (gitignored) is preferred by `ai_sidecar.rs`; if it's missing the sidecar falls back to PATH `python`, which may lack whisperx. Recreate with `py -3.11 -m venv` + `pip install -r src-tauri/python/requirements.txt`. If the CUDA torch got installed as `+cpu` by accident, fix with `pip install --index-url https://download.pytorch.org/whl/cu128 torch torchaudio`.
- Sidecar speaks **Ollama's HTTP API** directly (no `ollama` pip package — don't add it back). API-key mode is the no-install alternative.
- **Transcription is always local (WhisperX)** — the `provider` cfg only selects which LLM writes notes/chat (Ollama or OpenAI-compatible API). Never route STT to an API again; OpenRouter etc. have no `/audio/transcriptions`.
- **Stale sidecar processes**: an orphaned sidecar from an older build keeps answering on the old port (bumped 8765→8766 to invalidate them). If AI behaves oddly after an update, kill lingering `python` processes listening on 876x.
- WhisperX runs offline from the HF cache (`HF_HUB_OFFLINE=1` in `.env`); after changing `WHISPER_MODEL`/`DIARIZE_MODEL` set it to 0 once so the new model downloads.
- **Ollama models must be chat-capable**: some installed models (e.g. `qwen2.5-coder:7b`) are completion-only or corrupt and reject `/api/chat` with HTTP 400/404. `sidecar._ollama_models()` filters them via `/api/show` template checks — a 404 there means the model's blobs are broken (`ollama rm` it). A corrupt model can linger: `/api/tags` lists it but `/api/show`/`/api/chat` reject it.

## Session tips
- Read `src/lib/types.ts` first — it defines the whole data model.
- `App.tsx` is the hub for wiring new features (toolbar buttons, dialogs, navigation).
- New Rust commands: add `#[tauri::command]` in `lib.rs` (or `commands.rs`) + register in `invoke_handler`, then add a typed wrapper in `src/lib/tauri.ts`, then check `src-tauri/capabilities/default.json` if the command needs new permissions.
