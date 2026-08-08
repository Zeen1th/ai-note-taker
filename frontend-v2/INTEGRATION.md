# Integration brief — hand this file to the backend AI

Goal: replace the single-page frontend of the FastAPI note-taker desktop app with the
finished multi-screen prototype, wired to the existing backend API. The prototype was
built for this app, reuses the app's own palettes and localStorage keys, and is fully
validated (HTML/CSS/JS lint-clean). All real logic stays server-side; the frontend only
swaps demo data for `fetch()` calls.

The backend AI should read this file, copy the files listed below, make the wiring
changes, then run the verification checklist at the end.

---

## 1. Source files to copy (one-time)

The sources are mirrored in this repo at `frontend-v2/` (same folder layout as below).
Copy from there — no need to reach into any external workspace:

| Source (repo: `frontend-v2/`) | Copy to (repo)              | Notes |
| ----------------------------- | --------------------------- | ----- |
| `index.html`                  | `static/index.html`         | Replace — becomes the launcher |
| `library.html`                | `static/library.html`       | Notes + recordings library |
| `editor.html`                 | `static/editor.html`        | Markdown note editor |
| `record.html`                 | `static/record.html`        | Capture + transcribe + AI rail |
| `board.html`                  | `static/board.html`         | New board canvas (grab/drop, type) |
| `settings.html`               | `static/settings.html`      | Appearance / capture / AI / storage |
| `assets/kinpaku.css`          | `static/assets/kinpaku.css` | Shared design system (app palettes) |
| `assets/app.js`               | `static/assets/app.js`      | Shared runtime (theme/palette/toasts) |

`brand-spec.md` is a design reference — read it, don't deploy it.

### 1a. Path gotcha (must fix)
Every screen references assets as `assets/kinpaku.css` and `assets/app.js` (relative).
When served from `/static/board.html` the browser asks for `/assets/...`, which 404s
because the mount is `/static`. Fix one of:

- A) Change each HTML `<link href="assets/...">` → `href="/static/assets/..."` (absolute), or
- B) Add one mount in `app.py`:
  `app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")`

Fonts are loaded from Google Fonts (WebView2 has network). Keep the combined font link.

### 1b. Route order in app.py
`GET /` already returns `static/index.html` (FileResponse) — that's the launcher now.
`app.mount("/static", ...)` is at line 767, after all `/api` routes — leave it there.

---

## 2. Existing API (reuse, do NOT reimplement)

Base: `http://127.0.0.1:8000` (desktop.py serves on port 8000).

- **Notes** — `GET /api/notes` → `[{id, title, created_at, updated_at}]` (no content in list);
  `GET /api/notes/{nid}` → full `{id, title, content, created_at, updated_at}`;
  `POST /api/notes` body `{title, content}`; `PATCH /api/notes/{nid}` body `{title?, content?}`;
  `DELETE /api/notes/{nid}` → `{deleted}`.
- **Sessions (recordings)** — `GET /api/sessions` (list, no audio blob);
  `GET /api/sessions/{sid}` → session + `audio_url`; `GET /api/sessions/{sid}/audio` → audio file;
  `PATCH /api/sessions/{sid}` body `{title}`; `DELETE /api/sessions/{sid}`.
- **Transcribe** — `POST /api/transcribe` multipart form `file` (blob or chosen file).
  Response is `application/x-ndjson`, one JSON object per line:
  `{"type":"progress","stage":"…","pct":90}` → `{"type":"result","pct":100,"transcript","segments","notes","num_speakers","warning","session"}` → `{"type":"error","detail":"…"}`.
  `segments` shape: `[{speaker: "Speaker 1", start, end, text}]` (speakers numbered by first
  appearance; `transcript` is `"Speaker 1: …\nSpeaker 2: …"` merged lines).
  Stages seen in practice: Loading model, Preparing audio, Transcribing, Aligning words,
  Identifying speakers, Writing notes.
- **Chat** — `POST /api/chat` body `{transcript, messages:[{role,content}]}` → `{reply}`.
  Scoped to a transcript (the transcribe result or a session's transcript).
- **Status** — `GET /api/status` → `{whisper, whisper_model, whisper_device, diarization, diarize_error, ollama, ollama_model, cuda}`. Use for the launcher's "AI ready" state and settings toggles.

---

## 3. Screen-by-screen wiring

### `record.html` — capture + transcribe + AI rail
- Recorder: keep the existing `navigator.mediaDevices` + MediaRecorder pipeline. On stop,
  `POST /api/transcribe` with the Blob (`new FormData()` → `file`). Read the NDJSON stream
  with a `fetch` body reader; drive the existing pipeline steps (Loading model → … → Writing
  notes) from each `progress.stage`, fill the progress bar with `pct`.
- File import: same endpoint with `input[type=file]`'s File.
- On `result`: fire the existing `nt-transcribe-done` event with `{duration}` so the existing
  handler runs; render `result.segments` into `.turn.sp-N` rows (replace `DEMO_SEGMENTS`);
  render `result.notes` as Markdown into the AI rail (replace `DEMO_SUMMARY`); surface
  `result.warning` if present (e.g. the single-speaker hint).
- On `error`: stop pipeline, toast `error.detail`.
- Rail chat: `POST /api/chat` with `{transcript: lastResult.transcript, messages}` → render
  `reply` as a bot message. Replace the demo `aiReply` object.
- If transcription hasn't run yet, the rail should prompt to transcribe first (backend returns
  400 "No transcript provided." otherwise).

### `board.html` — the new board canvas
Cards are `{id, x, y, w, text, c, kind}` (c = palette index 1-5). Two options:
- **Recommended**: add server persistence. In `_init_db()` add table
  `board_cards(id TEXT PRIMARY KEY, x REAL, y REAL, w REAL, text TEXT, c INTEGER, kind TEXT,
  updated_at TEXT)`. Add routes: `GET /api/board` → `{cards:[…]}`;
  `PUT /api/board` body `{cards:[…]}` (full replace, server merges by id / drops missing);
  `DELETE /api/board` → clears. The frontend loads on boot and PUTs on every mutation
  (debounced ~300 ms). Keep localStorage `nt-board` as an offline cache/seed.
- Simpler fallback: keep `localStorage` only. It already works, fully local, matches the app's
  posture — acceptable for v1. The AI can pick; note the choice.
- AI rail on the board has chips (summary / group / actions) + free chat. The board transcript
  isn't a recording, so **add** `POST /api/board/chat` body `{cards:[…], messages:[…]}` →
  `{reply}` (server builds a card-text context). Replace the demo `aiReply()`.

### `editor.html` — Markdown note editor
- Open with `?id=` → `GET /api/notes/{nid}`, fill title + body.
- New note → no id.
- Save (button + Ctrl+S): existing note → `PATCH /api/notes/{nid}`; new → `POST /api/notes`
  (`title` = first line or "Untitled note"). Then `window.location = 'library.html'`.
- The "Save note" button currently just navigates; wire the fetch before navigating.
- No AI needed here; the existing "AI" hint line can be dropped or left as copy.

### `library.html` — notes + recordings
- Notes list → `GET /api/notes`. Replace the hardcoded rows.
- Recordings list → `GET /api/sessions`. Each card opens `editor.html?id={sid}` for notes? No —
  recording cards open a session view; keep navigation to `record.html` or a session detail.
  Simplest correct v1: recording card "open" links to `record.html` (it can re-transcribe), or
  add a tiny session-detail read-only view showing transcript + notes + audio. Recommend
  keeping it simple: clicking a recording shows its saved transcript/notes in the AI rail via
  `GET /api/sessions/{sid}` (fields `transcript`, `segments`, `notes`, `audio_url`).
- Delete buttons → `DELETE /api/notes/{id}` / `DELETE /api/sessions/{id}`, then refresh.
- Category chips (Personal/Work/Reading): the backend `plain_notes` table has no category
  column. Decision: (a) add `category TEXT` to `plain_notes` + include in list payload, or
  (b) drop category filtering in the real build. Frontend already filters client-side, so (b)
  is zero backend work.
- Search/duplicates/empty states: already client-side; keep.

### `settings.html`
- Palette + theme already persist via `nt-palette` / `nt-theme` in localStorage — same keys the
  original app used, nothing to wire.
- Capture toggles (system audio, auto-transcribe), AI toggles (enable, diarisation, model
  select), storage actions are currently toast-only. Options: leave as UI-only (posture is
  "local-only"), or add `GET/PUT /api/settings` persisted in SQLite. Backend AI picks;
  `GET /api/status` already gives real read-only state for the model/diarization toggles.
- **Export** button → currently a toast. Add `GET /api/export` returning a zip of
  `data/sessions.db` + recorded audio (or note as not-yet-implemented). This is new work.

### `index.html` — launcher
- Static; no backend calls required. Optional polish: `GET /api/status` to render the
  "local · private / AI ready" hint with real state.

---

## 4. Runtime contract to preserve (assets/app.js)

- `window.nt`: `{ toast, toggleTheme, applyTheme, applyPalette, setPalette, cyclePalette }`.
  Palette cycle order: notebook → aurora → blueprint.
- localStorage keys `nt-theme`, `nt-palette` — do not rename (shared with original app).
- Event `nt-transcribe-done` fires with `{duration}` when a recording finishes. Keep the name;
  the wiring change moves where it fires from the simulated timer to the transcribe result.
- `data-od-id` attributes are stable hooks for automation; leave them in place.
- Desktop shell on every screen: titlebar (brand mark + winctl + theme + palette toggles),
  sidebar nav, footer "sqlite · local-only" and "v2.0 · kinpaku build". Keep it.

## 5. Design system (do not invent colors/fonts)

`static/assets/kinpaku.css` implements the app's own palettes:
`<html data-palette="notebook|aurora|blueprint" data-theme="light|dark">`. Use its tokens
(`--accent`, `--sp1..5`, `--grad`, `--bg`, `--surface`, `--ink`, `--seam`, …) and the combined
Google Fonts link present in every file. Details in `brand-spec.md`.

## 6. Demo content to replace (must not ship)

- `record.html`: `DEMO_SEGMENTS`, `DEMO_SUMMARY` → real `result.segments` / `result.notes`.
- `app.js` / `record.html`: demo chat answers object → `POST /api/chat`.
- `board.html`: `SEED` cards + `aiReply()` demo → `GET/PUT /api/board` + `POST /api/board/chat`
  (or documented localStorage-only choice).
- `library.html`: hardcoded note/recording rows → fetched lists.
- `editor.html`: hardcoded note → load/save via notes API.

## 7. Verification checklist (run before declaring done)

- All screens served from FastAPI (open `http://127.0.0.1:8000/` — no `file://`, no 404s).
- Assets load under `/static/assets/...` (or the added `/assets` mount).
- Notes: create → appears in library → open → edit → save → persisted in SQLite after restart.
- Recordings: delete works; audio_url plays.
- Transcribe: recording (or file import) streams progress through all stages, renders
  speaker-turn transcript + notes, chat answers from the transcript.
- Board: cards survive reload; drag/type/delete persist (server or localStorage per choice).
- Palette + theme persist across screens and restart (same keys as the original app).
- No demo/filler text visible anywhere in the built app.
