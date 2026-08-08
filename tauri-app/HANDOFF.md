# note·taker — Tauri 2 Rewrite Handoff

## Quick Start
```bash
cd tauri-app
npm run tauri dev
```
First build compiles 384 Rust crates (~5 min). After that, launches in ~10s.

## Architecture
```
tauri-app/
├── src-tauri/                    Rust backend
│   ├── src/
│   │   ├── main.rs               Entry point
│   ├── src/lib.rs                Tauri builder, state, command registration
│   ├── src/db.rs                 SQLite (rusqlite) — boards, nodes, edges
│   ├── src/commands.rs           #[tauri::command] IPC layer
│   ├── src/ai_sidecar.rs         Spawns Python sidecar for WhisperX/Ollama
│   ├── Cargo.toml                Rust deps (rusqlite, uuid, chrono, which)
│   ├── tauri.conf.json           Frameless window, no decorations
│   └── python/
│       ├── sidecar.py            FastAPI: transcribe, chat, board/chat, status
│       └── requirements.txt      AI deps only (whisperx, ollama, fastapi)
│
├── src/                          React frontend (TypeScript)
│   ├── App.tsx                   Shell: titlebar, sidebar, board canvas, routing
│   ├── main.tsx                  React entry
│   ├── components/
│   │   ├── BoardNode.tsx         Draggable/resizable node (rich text, color)
│   │   ├── BoardEdge.tsx         SVG bezier connectors (auto-route)
│   │   ├── NoteModal.tsx         Blurred-overlay focused editor
│   │   ├── ContextMenu.tsx       Right-click menu
│   │   └── Capture.tsx           Recording + streaming transcription
│   ├── store/
│   │   └── boardStore.ts         Zustand store (nodes, edges, view, selection)
│   ├── lib/
│   │   ├── tauri.ts              invoke() wrappers + window controls
│   │   └── types.ts              TS interfaces (Board, BoardNode, BoardEdge)
│   ├── styles/
│   │   ├── theme.css             3 palettes × light/dark (ported from kinpaku.css)
│   │   └── app.css               Layout, nodes, edges, modal, capture
│   ├── index.html                Fonts + initial palette
│   └── package.json              React, Zustand, @tauri-apps/api
```

## What's Built (Sessions 1-4)

### ✅ Board Canvas
- Pan/zoom (drag empty space, scroll wheel, spacebar-drag)
- Double-click to add notes
- Draggable nodes (document-level listeners, 4px threshold, group drag)
- Resizable nodes (corner handle)
- Rich text body (contentEditable, HTML storage, paste sanitization)
- Node title (separate from content, double-click to rename)
- Color bar + dot (5 palette speaker colors + accent)
- SVG bezier connectors with auto-routing + arrowheads
- Edge labels + click-to-delete
- Multi-select (rubber-band marquee, shift-click toggle)
- Auto-layout (Arrange button → non-overlapping grid)
- Fit-to-view + Home buttons
- View persistence (pan/zoom saved to localStorage per board)

### ✅ Multi-Board
- Sidebar board list (create/switch/rename/delete)
- Each board has its own nodes + edges (board_id scoped)
- SQLite stores everything — survives restarts

### ✅ Modal Note Editor
- Blurred backdrop overlay
- Full formatting toolbar: Bold, Italic, Strikethrough, H1/H2, Lists, Quote, Font size, Link
- Real-time save back to the node

### ✅ Context Menu
- Right-click node: Open in focus mode, Rename, Delete
- Right-click canvas: Add note, Arrange, Fit, New board

### ✅ Capture Screen
- MediaRecorder (mic → webm)
- Streaming NDJSON transcription (6-stage pipeline progress)
- Speaker-colored transcript turns
- AI notes rendering
- "Send to board" prompt after transcription

### ✅ Frameless Window
- `decorations: false` — no OS titlebar
- `data-tauri-drag-region` on titlebar
- Window controls via Tauri API (minimize/maximize/close)
- Palette/theme toggle in titlebar

### ✅ Python Sidecar
- Spawns lazily when AI is first needed
- Same WhisperX + diarization + Ollama pipeline
- CORS-enabled for the Tauri frontend
- Auto-stops on app exit

## Rust IPC Commands
| Command | Purpose |
|---|---|
| `list_boards` | Get all boards with node counts |
| `create_board` | Create a new board |
| `get_board` | Load a board's nodes + edges |
| `put_board` | Full-replace nodes + edges (debounced) |
| `delete_board_cmd` | Delete board + its nodes + edges |
| `rename_board_cmd` | Rename a board |
| `get_sidecar_url` | Spawn/get the Python AI sidecar URL |

## Python Sidecar Endpoints (port 8765)
| Endpoint | Purpose |
|---|---|
| `GET /api/status` | What AI models are loaded |
| `POST /api/transcribe` | Streaming transcription (NDJSON) |
| `POST /api/chat` | Chat over a transcript |
| `POST /api/board/chat` | Chat over board nodes |

## SQLite Schema
```
boards:        id, name, source_session_id, created_at, updated_at
board_cards:   id, x, y, w, h, text, c, kind, image, board_id, updated_at
board_edges:   id, from_id, to_id, color, label, board_id, updated_at
```
DB location: next to the executable in `data/sessions.db`.

## What's Left (Session 5+)
- [ ] **Settings screen** — palette/theme/AI config (currently only titlebar toggles)
- [ ] **Image nodes** — upload + inline resize in React (Rust image routes not yet ported)
- [ ] **Board AI chat** — the `/api/board/chat` sidecar endpoint exists but no UI wired
- [ ] **Drag-drop images** onto canvas
- [ ] **Sessions library** — list/delete past recordings
- [ ] **Export** — zip of DB + audio + images
- [ ] **Installer** — `tauri build` → `.exe` / `.msi`
- [ ] **App icon** — custom icon set (currently Tauri defaults)
- [ ] **Keyboard shortcuts** — Ctrl+B/I in rich text, Ctrl+S, etc.
- [ ] **Undo/redo** — not implemented
- [ ] **Touch support** — pointer events work but untested on touchscreens

## Key Design Decisions
1. **Rust handles all non-AI operations** (SQLite, file I/O) — no HTTP server for normal operations
2. **Python sidecar only for AI** — spawned lazily, talks via fetch on port 8765
3. **Zustand for state** — lightweight, no boilerboard
4. **CSS design system** — 3 palettes × light/dark, same tokens as the old kinpaku.css
5. **Frameless window** — native Tauri drag, reliable on all platforms

## Old App
The original pywebview + FastAPI app lives in the repo root (`app.py`, `desktop.py`, `static/`). It still works via `notetaker.bat`. The Tauri rewrite is in `tauri-app/`.

## Tech Stack
- **Tauri 2.11** — app shell, IPC, bundling
- **React 19** + **TypeScript** — frontend
- **Zustand** — state management
- **rusqlite** (bundled SQLite) — local database
- **Python 3.12** + FastAPI + WhisperX + Ollama — AI sidecar
- **Vite** — dev server + build
