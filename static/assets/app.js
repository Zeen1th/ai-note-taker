/* note·taker — shared runtime: theme, palette, toasts.
   Recorder + transcribe streaming + chat are wired per-screen against the
   real /api/* endpoints (see record.html / board.html) — never simulated. */
(function () {
  'use strict';

  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------- palette + theme ---------- */
  const PALETTES = ['notebook', 'aurora', 'blueprint'];

  function applyPalette() {
    const saved = localStorage.getItem('nt-palette');
    const p = PALETTES.includes(saved) ? saved : 'notebook';
    document.documentElement.setAttribute('data-palette', p);
  }
  function currentPalette() {
    const attr = document.documentElement.getAttribute('data-palette');
    return PALETTES.includes(attr) ? attr : 'notebook';
  }
  function applyTheme() {
    const saved = localStorage.getItem('nt-theme');
    let dark;
    if (saved) {
      dark = saved === 'dark';
    } else {
      const sysDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      dark = currentPalette() === 'notebook' ? false : sysDark;
    }
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    document.body.classList.toggle('is-light', !dark);
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem('nt-theme', next);
    applyTheme();
  }
  function setPalette(p) {
    if (!PALETTES.includes(p)) return;
    localStorage.setItem('nt-palette', p);
    document.documentElement.setAttribute('data-palette', p);
    applyTheme();
  }
  function cyclePalette() {
    const i = PALETTES.indexOf(currentPalette());
    setPalette(PALETTES[(i + 1) % PALETTES.length]);
  }

  /* ---------- toasts ---------- */
  function toast(message) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.innerHTML = toastIcon() + message;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), 2600);
  }
  function toastIcon() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  }

  /* ---------- boot ----------
     Window controls (drag / resize / min / max / close) are the native OS
     titlebar, themed dark in desktop.py. The in-app `.titlebar` is a brand +
     nav strip; its `.winctl` cluster is hidden (CSS) to avoid duplicate
     controls. So nothing window-related needs wiring here — just theme. */
  document.addEventListener('DOMContentLoaded', () => {
    applyPalette();
    applyTheme();
    $$('[data-theme-toggle]').forEach((t) => t.addEventListener('click', toggleTheme));
    $$('[data-palette-toggle]').forEach((t) => t.addEventListener('click', cyclePalette));
  });

  window.nt = { toast, toggleTheme, applyTheme, applyPalette, setPalette, cyclePalette };
})();
