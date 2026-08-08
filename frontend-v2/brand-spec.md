# Brand spec — note·taker, in the app's own palettes

Source: the actual app's frontend (`S:\!Dev\AI note taker\New AI note taker\static\index.html`) — the `data-palette` × `data-theme` system it already ships with. The prototype reuses these palettes and fonts verbatim; nothing is invented.

## System in one sentence

Three switchable palettes, each with light + dark: **notebook** (warm paper, terracotta ink, serif + handwriting), **blueprint** (navy graph paper, blue accent, geometric sans), **aurora** (dark neutral + pink→purple→blue gradient). The palette is the product's identity — the note taker first, AI as an optional secondary rail.

## Palette switching

- `data-palette` on `<html>`: `notebook` (default) / `aurora` / `blueprint`.
- `data-theme` on `<html>`: `light` / `dark`.
- Persisted in `localStorage` as `nt-palette` and `nt-theme` (shared with the real app).
- Default theme: notebook prefers light (paper); other palettes follow the system.
- Cycling order: `notebook → aurora → blueprint` (mirrors the app's own toggle).

## Tokens

Base: `--font-display` Space Grotesk · `--font-body` Inter · `--font-mono` JetBrains Mono. Derived tokens resolve lazily via `color-mix()`: `--patina = --accent-2`, `--accent-text`, `--faint`, `--disabled`, `--border-strong`, `--accent-pale`, `--accent-deep`, `--patina-pale`, `--patina-deep`, `--accent-soft`, `--seam`.

Every palette block sets: `--bg --bg-deep --surface --surface-2 --surface-3 --fg --text --muted --border --accent --accent-2 --grad --on-accent --warn --warn-2 --grid --glow --sp1..--sp5 --shadow-panel --shadow-lift`.

| Palette | Accent / accent-2 | Gradient | Speaker `--sp1..5` |
|---|---|---|---|
| notebook light | `#a8432a` / `#c8623f` | `#c8623f→#a8432a` | terracotta, navy, green, purple, amber |
| notebook dark | `#e0895f` / `#c8623f` | `#e0895f→#c8623f` | soft terracotta, slate, sage, lilac, gold |
| blueprint light | `#2563eb` / `#06b6d4` | `#2563eb→#06b6d4` | blue, cyan, amber, violet, magenta |
| blueprint dark | `#4d9fff` / `#22d3ee` | `#4d9fff→#22d3ee` | light blue, cyan, amber, purple, pink |
| aurora dark | `#ec4899` / `#8b5cf6` | `#ec4899→#8b5cf6→#3b82f6` | pink, violet, blue, cyan, amber |
| aurora light | `#db2777` / `#7c3aed` | `#db2777→#7c3aed→#3b82f6` | magenta, violet, blue, cyan, amber |

## Type

| Palette | Display (`--font-display`) | Body (`--font-body`) | Wordmark (`--wordmark`) |
|---|---|---|---|
| notebook | Newsreader (serif) | Onest | Caveat (handwriting) |
| blueprint | Space Grotesk | Inter | — (display face) |
| aurora | Space Grotesk | Inter | — (display face) |

Display sizes keep negative tracking; ALL-CAPS labels keep `letter-spacing ≥ 0.06em`. Notebook renders the brand name in Caveat, un-capped, at a larger size.

## Presence touches (faithful to the app)

1. `body::before` — a fixed corner glow (`--glow`) plus a 28px graph-paper grid (`--grid`). Blueprint shows the grid; aurora and notebook keep `--grid: transparent` and only show the glow.
2. Notebook surfaces are paper: `--paper-dot` dot grid + a terracotta `--margin-rule` on `.notes` and the editor body.
3. Brand mark uses `--grad` with a `--glow` shadow, so it re-colors with every palette.
4. Status dots pulse via `--accent-soft`.
5. Speaker turns use `--sp1..--sp5`, so transcripts re-color per palette and per theme.

## Posture rules

1. The palette is the identity — accent ≤ 2 visible uses per screen; `--sp1..5` reserved for speaker turns and charts.
2. Hairlines before shadows. 1px `--border` rules; shadows only via `--shadow-panel` / `--shadow-lift`.
3. Small radii (2–6px buttons/controls, 8px cards). No glass, no bounce easing.
4. Text on gradient/accent uses `--on-accent`; accent is never used for small text on light paper.
5. Never pure black / pure white; surfaces are warm and material per palette.
6. AI is a secondary module — the product is a note taker first.
