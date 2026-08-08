# AI Note Taker

A local-first, offline voice-meeting notebook: record, transcribe, and organize notes on an infinite canvas. Built with **Tauri 2**, **React 19**, **TypeScript**, and **Rust/SQLite**.

## Features

- **Infinite canvas board** — drag, resize, color, and connect notes; zoom/pan, rubber-band multi-select, group drag, and double-click to rename.
- **Notion-style rich text** — TipTap editor in every note: slash commands (`/`), floating format bar, heading blocks, checklists, quotes, code blocks with syntax highlighting, text colors, highlights, links, and Markdown export.
- **RTL-ready** — per-block `dir="auto"`, so English and Arabic type naturally in the same note.
- **Focus mode** — open any note in a distraction-free editor with a sticky formatting toolbar.
- **Voice capture** — record meetings/memos, local transcription, transcript library, chat and AI summary.
- **Everything local** — Rust backend with SQLite persistence; nothing leaves your machine unless you call an AI endpoint with your own key.

## Development

```bash
cd tauri-app
npm install
npm run tauri dev
```

Build a production bundle:

```bash
npm run tauri build
```

## Structure

- `tauri-app/src` — React frontend (board, notes, capture, settings)
- `tauri-app/src-tauri` — Rust backend (SQLite, filesystem, system commands)

## License

MIT — see [LICENSE](LICENSE).
