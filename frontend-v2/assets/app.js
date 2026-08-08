/* note·taker — shared runtime: theme, toasts, recorder timers, chat simulation. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);
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

  /* ---------- recorder simulation (record.html) ---------- */
  const PIPELINE = ['Loading model', 'Preparing audio', 'Transcribing', 'Aligning words', 'Identifying speakers', 'Writing notes'];

  function initRecorder() {
    const btn = $('#recBtn');
    if (!btn) return;
    const timer = $('#recTimer');
    const list = $('#pipeList');
    const fill = $('#progFill');
    const status = $('#recStatus');
    let recording = false;
    let interval = null;
    let elapsed = 0;

    btn.addEventListener('click', () => {
      if (recording) { stop(); return; }
      start();
    });

    function start() {
      recording = true;
      elapsed = 0;
      btn.classList.add('recording');
      btn.innerHTML = stopIcon();
      timer.textContent = '00:00';
      status.textContent = 'Recording — press stop to transcribe.';
      interval = setInterval(() => {
        elapsed++;
        timer.textContent = fmt(elapsed);
      }, 1000);
      list.innerHTML = '';
      fill.style.width = '0%';
    }

    function stop() {
      recording = false;
      clearInterval(interval);
      btn.classList.remove('recording');
      btn.innerHTML = recIcon();
      const total = elapsed;
      status.textContent = 'Transcribing locally… models load on first use.';
      runPipeline(total);
    }

    function runPipeline(total) {
      list.innerHTML = PIPELINE.map((s) =>
        '<div class="pipe-step" data-step><div class="pipe-ico">' + circle() + '</div><span class="pipe-name"></span><span class="pipe-meta"></span></div>'
      ).join('');
      const steps = $$('[data-step]', list);
      steps.forEach((el, i) => {
        el.querySelector('.pipe-name').textContent = PIPELINE[i];
      });
      let i = 0;
      const tick = () => {
        if (i > 0) {
          const prev = steps[i - 1];
          prev.classList.remove('running');
          prev.classList.add('done');
          prev.querySelector('.pipe-ico').innerHTML = check();
          prev.querySelector('.pipe-meta').textContent = (total / 2 / PIPELINE.length).toFixed(0) + 's';
        }
        if (i >= PIPELINE.length) {
          fill.style.width = '100%';
          status.textContent = 'Transcription complete.';
          const evt = new CustomEvent('nt-transcribe-done', { detail: { duration: total } });
          document.dispatchEvent(evt);
          return;
        }
        const cur = steps[i];
        cur.classList.add('running');
        cur.querySelector('.pipe-meta').textContent = '';
        fill.style.width = Math.round(((i + 1) / PIPELINE.length) * 100) + '%';
        i++;
        setTimeout(tick, 900);
      };
      tick();
    }

    function fmt(s) {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    }
  }

  function recIcon() {
    return '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="9"/></svg>';
  }
  function stopIcon() {
    return '<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';
  }
  function check() {
    return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  }
  function circle() {
    return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><circle cx="12" cy="12" r="8"/></svg>';
  }

  /* ---------- chat simulation (record.html) ---------- */
  function initChat() {
    const sendBtn = $('#chatSend');
    if (!sendBtn) return;
    const input = $('#chatInput');
    const log = $('#chatLog');
    const chips = $$('.chip');
    const answers = {
      summary: 'The call covered the Q3 feature plan. The team agreed to ship search first, defer the mobile app to Q4, and keep the current AI module as an optional layer on top of plain notes.',
      actions: 'Action items:\n1. Mia — write the search spec (due Friday)\n2. Rohan — spike the fuzzy-matching index (due Monday)\n3. You — confirm data-export format before Wed',
      decisions: 'Decisions made: search ships in Q3, mobile slides to Q4, AI notes stay optional, no new dependencies this quarter.',
      keypoints: 'Key points per speaker:\n· Mia — users ask for search every week; it is the top request\n· Rohan — an index on SQLite is enough for the first version\n· You — export stays local-only, nothing leaves the machine',
    };

    function send(text) {
      if (!text.trim()) return;
      push('user', text);
      input.value = '';
      setTimeout(() => {
        let reply = 'That is outside the demo — try one of the prompt chips above.';
        if (text.toLowerCase().includes('summary')) reply = answers.summary;
        else if (text.toLowerCase().includes('action')) reply = answers.actions;
        else if (text.toLowerCase().includes('decision')) reply = answers.decisions;
        else if (text.toLowerCase().includes('key point')) reply = answers.keypoints;
        push('bot', reply);
      }, 700);
    }

    function push(role, text) {
      const el = document.createElement('div');
      el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
      if (role === 'bot') {
        el.innerHTML = '<span class="msg-role">Note taker</span>' + esc(text).replace(/\n/g, '<br>');
      } else {
        el.textContent = text;
      }
      log.appendChild(el);
      log.scrollTop = log.scrollHeight;
    }

    sendBtn.addEventListener('click', () => send(input.value));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(input.value); });
    chips.forEach((chip) => chip.addEventListener('click', () => send(chip.dataset.prompt)));
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  /* ---------- boot ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    applyPalette();
    applyTheme();
    const toggles = $$('[data-theme-toggle]');
    toggles.forEach((t) => t.addEventListener('click', toggleTheme));
    const palToggles = $$('[data-palette-toggle]');
    palToggles.forEach((t) => t.addEventListener('click', cyclePalette));
    initRecorder();
    initChat();
  });

  window.nt = { toast, toggleTheme, applyTheme, applyPalette, setPalette, cyclePalette };
})();
