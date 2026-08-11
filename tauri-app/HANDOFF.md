# note·taker — HANDOFF (current state, v0.2.0-beta.5)

> For the full agent guide (architecture, code map, release workflow, traps) read **`AGENTS.md`** at the repo root.

## Quick start
```powershell
cd "S:\!Dev\AI note taker\New AI note taker\tauri-app"
npm run dev                 # vite only (port 1420)
npm run tauri dev           # full app shell (first Rust build ~5 min, then ~10 s)
npm run build               # tsc && vite build — must pass before any TS work is "done"
cargo check                 # in src-tauri/ — must pass before any Rust work is "done"
```

## Current status
- **Version: 0.2.0-beta.5**, live on GitHub (Zeen1th/ai-note-taker) as non-prerelease "Latest".
- Latest shipped feature: **Markdown board export** (toolbar → Export → preview/copy/save into `Documents\note-taker exports\`, AI-oriented structure: notes + tags, image refs, containers with children, groups, `A —label—> B` relationships).
- Auto-update verified working **beta.4 → beta.5** (after re-uploading the new `latest.json` onto the beta.4 release — see AGENTS.md step 5).

## Release history
| Tag | Key | Auto-update | Notes |
|---|---|---|---|
| v0.2.0-beta.1 | old | — | first Tauri release |
| v0.2.0-beta.2 | old | — | updater E2E test (version bump only) |
| v0.2.0-beta.3 | old | ✗ | paste images, wheel-zoom, font picker, resize, groups, icon |
| v0.2.0-beta.4 | **new** (empty pass) | ✓ (for beta.4+) | internal links, link picker, key rotation |
| v0.2.0-beta.5 | new | ✓ | Markdown export |

**Legacy users**: anyone still on beta.2/3 must install beta.4+ manually once (old pubkey baked in — can never auto-update). Beta.4+ update fine.

## What's built (all shipped)
- **Capture**: mic/system-audio recording (MediaRecorder → webm), streaming WhisperX transcription with speaker diarization (colored turns), AI notes, send-to-board.
- **Board**: infinite canvas pan/zoom, notes/references/containers/groups, connectors with labels, 8-way resize, drag-reparent into containers, multi-select, arrange grid, fit-to-view, view persistence per board, board AI chat ("Ask the board").
- **Notes**: TipTap editor (bold/italic/underline/strike/code/lists/quotes/links, font size/family, colors/highlights, images), slash menu, tag menu (`#tag`), bubble + static toolbars, focus-mode modal, **internal links** (pick any note/image/node/group; click to jump), undo/redo.
- **Tags**: global tag store, colors, toolbar filter chips.
- **Images**: paste from clipboard (11 types), drag-drop from OS, image picker, `boardimg://` protocol, wheel-zoom on hover.
- **Workspace**: container opens as Notion-style list with quick-add and move-back-to-board.
- **Library**: past recording sessions. **Trash**: restore/deletable deleted cards.
- **Settings**: palette (3) × theme (light/dark), density, recording options (system audio, auto-transcribe, format, AI notes), model info, data location.
- **Updater**: `useUpdater` hook — silent startup check, titlebar check button, changelog dialog, download progress, install.

## Not done / open ideas
- Large uncommitted work: everything since ~beta.3 (tags, Library, UpdateModal, internal links, export, icon, capture/settings upgrades) is uncommitted — **54 changed/untracked files**. Ask the user before committing.
- Possible next features (discuss first): copy board as JSON for deeper AI context, printable/PDF export, image export inside markdown, touch support, session-to-board auto-link, more capture sources.
- `data/`, `__pycache__`, `_*.log` at repo root are old-app leftovers — can be cleaned.

## How to ship the next beta (abbreviated — full detail in AGENTS.md)
1. Bump `0.2.0-beta.N` in `tauri.conf.json` (version **and** updater endpoint URL) + `Cargo.toml`.
2. Give the user the one-liner build command (with `TAURI_SIGNING_PRIVATE_KEY` env from `src-tauri\tauri.key`, empty password).
3. After "done": write `latest.json` manually, `gh release create`, and **re-upload `latest.json` to the previous release** (`--clobber`).

## Known traps
- `latest.json` version-pinning (see above) — if a user says "up to date" wrongly, it's this.
- Never regenerate `src-tauri/tauri.key`.
- Never print/commit `.env` (`HF_TOKEN`).
- `npx tauri` mangles args; use `node node_modules\@tauri-apps\cli\tauri.js`.
