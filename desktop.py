"""Desktop launcher for AI Note-Taker.

Opens the app in a real **native window** (pywebview + the OS WebView2 engine):
its own title bar, taskbar entry and icon, no browser chrome — it looks and
feels like a native app, not a website.

Reliability: embedding the WebView2 controller occasionally fails on Windows
(HRESULT 0x8007139F, "the group or resource is not in the correct state") and the
native window never appears. To make the app *always* open, we detect that case
and automatically fall back to a chromeless browser app-window (Edge/Chrome
`--app=`). So: native window normally; browser app-window only if the native
engine refuses to start.

Startup shows an instant splash (the server needs ~15s on first launch to load
the Whisper + diarization models); the window swaps to the app the moment the
server answers.

Closing the window hides it to the system tray (the server keeps running); click
the tray icon to reopen, or right-click -> Quit to exit fully.

Run with:  python desktop.py     (or the bundled notetaker.bat)
"""

import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

# Native (OS) titlebar is kept — it gives reliable drag, edge-resize, and
# min/max/close for free. We theme it dark (DWMWA_USE_IMMERSIVE_DARK_MODE) so it
# matches the app instead of being a jarring white strip. The in-app `.titlebar`
# is therefore a *brand / nav strip*, not window chrome — its window-control
# glyphs stay but are inert decoration; the real controls live in the OS bar.
import webview as _wv  # noqa: F401  (kept for API stability / future use)


def _apply_dark_titlebar(hwnd):
    """Make the native OS titlebar dark so it fits the app's design.

    No-op on pre-Win10 or if the DWM call fails — the bar just stays light,
    which is ugly but fully functional (drag / resize / controls all work).
    """
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        dwm = ctypes.windll.dwmapi
        DWMWA_USE_IMMERSIVE_DARK_MODE = 20      # Win10 1809+ (newer builds)
        DWMWA_CAPTION_COLOR = 35                 # Win11 22000+
        DWMWA_BORDER_COLOR = 34                  # Win11 22000+
        BOOL = ctypes.c_int
        hwnd = wintypes.HWND(hwnd)
        # Dark mode on.
        dwm.DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE,
                                  ctypes.byref(BOOL(1)), ctypes.sizeof(BOOL))
        # Caption + border color = the app's notebook dark surface (#241f18).
        for attr, color in ((DWMWA_CAPTION_COLOR, 0x181F24), (DWMWA_BORDER_COLOR, 0x181F24)):
            # COLORREF is 0x00BBGGRR; #241f18 -> R=24 G=1f B=18 -> 0x00181F24
            dwm.DwmSetWindowAttribute(hwnd, attr,
                                      ctypes.byref(ctypes.c_uint(color)),
                                      ctypes.sizeof(ctypes.c_uint))
        # Force a frame redraw so the change shows immediately.
        SWP_NOSIZE = 0x0001
        SWP_NOMOVE = 0x0002
        SWP_NOZORDER = 0x0004
        SWP_FRAMECHANGE = 0x0020
        user32.SetWindowPos(hwnd, 0, 0, 0, 0, 0,
                            SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGE)
    except Exception:  # noqa: BLE001 — theming is cosmetic, never fatal
        pass

import pystray
import uvicorn
from PIL import Image, ImageDraw

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}/"
LOCK_PORT = 8766  # dedicated localhost port used purely as a single-instance lock

APP_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "AINoteTaker"
)
# Dedicated WebView2 user-data folder for the native window, and a separate
# profile for the browser fallback — both on the local C: drive (a normal spot).
WEBVIEW_STORAGE = os.path.join(APP_DIR, "webview")
APP_PROFILE = os.path.join(APP_DIR, "browser-profile")
SPLASH_FILE = os.path.join(APP_DIR, "loading.html")
LOG_FILE = os.path.join(APP_DIR, "desktop.log")

WINDOW_SIZE = "1240,820"

window = None
tray = None
_native_active = False
_lock_sock = None
_quitting = False

# Notebook-themed splash shown while the server loads its models. Static version
# for the native window (Python swaps it for the app when ready).
SPLASH_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
 html,body{height:100%;margin:0}
 body{background:radial-gradient(1200px 700px at 50% -10%,#efe8d8,#e2d9c6);
   display:flex;align-items:center;justify-content:center;color:#3b3325;
   font-family:'Segoe UI',system-ui,sans-serif;-webkit-user-select:none;user-select:none}
 .wrap{text-align:center}
 .logo{font-size:42px;margin-bottom:8px}
 .name{font-size:27px;font-weight:700;color:#a8432a;
   font-family:'Segoe Script','Bradley Hand','Comic Sans MS',cursive}
 .sub{margin-top:12px;font-size:13px;color:#6f6553}
 .ring{width:26px;height:26px;margin:24px auto 0;border:3px solid rgba(70,58,36,.18);
   border-top-color:#a8432a;border-radius:50%;animation:s .8s linear infinite}
 @keyframes s{to{transform:rotate(360deg)}}
</style></head><body>
 <div class="wrap">
 <div class="logo">&#127908;</div>
 <div class="name">note&#183;taker</div>
 <div class="sub">starting the local engine&#8230; first launch loads models (~15s)</div>
 <div class="ring"></div>
</div></body></html>
"""

# Splash for the browser fallback: same look, but it polls the server itself and
# replaces itself with the app (Python can't drive a browser window from here).
SPLASH_HTML_POLL = SPLASH_HTML.replace(
    "</div></body></html>",
    """</div><script>
 var APP='http://127.0.0.1:8000/',n=0;
 function poll(){n++;fetch(APP,{mode:'no-cors',cache:'no-store'})
   .then(function(){location.replace(APP);})
   .catch(function(){ n>360 ? location.replace(APP) : setTimeout(poll,500); });}
 poll();
</script></body></html>""",
)


def _setup_logging():
    """Give the process a real stdout/stderr.

    Under pythonw.exe (the no-console launcher used by notetaker.bat) sys.stdout
    and sys.stderr are None, so any library on the model-loading path that writes
    to them (tqdm, HuggingFace, Lightning) can error or stall — and every failure
    is otherwise invisible. Redirecting to a log file makes the app both robust
    and diagnosable (see %LOCALAPPDATA%\\AINoteTaker\\desktop.log).
    """
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        os.makedirs(APP_DIR, exist_ok=True)
        logf = open(LOG_FILE, "a", buffering=1, encoding="utf-8", errors="replace")
        if sys.stdout is None:
            sys.stdout = logf
        if sys.stderr is None:
            sys.stderr = logf
    except Exception:  # noqa: BLE001 — logging must never block startup
        pass


def _tray_image():
    """A small blueprint-blue mic glyph for the tray icon."""
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse([4, 4, 60, 60], fill=(37, 99, 235, 255))      # blue disc
    d.rounded_rectangle([26, 16, 38, 38], radius=6, fill=(255, 255, 255, 255))  # mic body
    d.arc([23, 24, 41, 44], start=0, end=180, fill=(255, 255, 255, 255), width=3)  # cradle
    d.line([32, 44, 32, 50], fill=(255, 255, 255, 255), width=3)  # stem
    d.line([25, 50, 39, 50], fill=(255, 255, 255, 255), width=3)  # base
    return img


def _acquire_lock():
    """Single-instance guard that works even before the server binds its port.

    Binds a dedicated localhost port; the OS frees it when the process exits. If
    the bind fails, another instance already owns it.
    """
    global _lock_sock
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((HOST, LOCK_PORT))
        s.listen(1)
        _lock_sock = s  # keep a reference so it isn't garbage-collected
        return True
    except OSError:
        s.close()
        return False


def _server_ready(timeout=1.0):
    try:
        urllib.request.urlopen(URL, timeout=timeout)
        return True
    except Exception:  # noqa: BLE001
        return False


def _run_server():
    config = uvicorn.Config("app:app", host=HOST, port=PORT, log_level="warning")
    uvicorn.Server(config).run()


# ---- Native window (pywebview) ----

class WindowApi:
    """JS bridge exposed as `window.pywebview.api.*` inside the page.

    The window object is created by the same create_window() call that takes this
    instance as js_api, so it is wired in afterwards via ``bind()``. Public
    methods (no leading underscore) become ``window.pywebview.api.<method>()``,
    returning Promises to JS. All no-op gracefully if the window isn't bound.
    """

    def __init__(self):
        self._win = None

    def bind(self, win):
        self._win = win
    bind._serializable = False  # internal wiring; not exposed to JS

    def minimize(self):
        if self._win is not None:
            self._win.minimize()

    def toggle_maximize(self):
        if self._win is None:
            return
        # The native OS bar is the real maximize control; this stays available
        # for any future in-app control (e.g. browser fallback showing .winctl).
        if self._win.evaluate_js("document.documentElement.classList.contains('is-maximized')"):
            self._win.restore()
        else:
            self._win.maximize()

    def close(self):
        # Mirror _on_closing: hide to tray, don't destroy. Real quit is the tray
        # menu's job, so the close glyph keeps the app's "runs in the tray" feel.
        if self._win is not None:
            self._win.hide()

    def is_maximized(self):
        return bool(self._win and self._win.evaluate_js(
            "document.documentElement.classList.contains('is-maximized')"))


_win_api = WindowApi()


def _load_app_when_ready():
    """Poll the server; swap the native splash for the app once it answers."""
    for _ in range(600):  # up to ~5 min for first-run model downloads
        if _quitting:
            return
        if _server_ready():
            try:
                if window is not None:
                    window.load_url(URL)
            except Exception:  # noqa: BLE001
                pass
            return
        time.sleep(0.5)


def _on_closing():
    """Closing the window hides it to the tray instead of quitting."""
    if _quitting:
        return True       # allow the real close
    if window is not None:
        window.hide()
    return False          # cancel the close


def _eval_js_safe(js):
    """evaluate_js is only valid while the window exists and is loaded."""
    if window is None:
        return
    try:
        window.evaluate_js(js)
    except Exception:  # noqa: BLE001 — window not ready / already gone
        pass


def _run_native():
    """Show the native window and block until it's destroyed.

    Returns True if the window ended because the user quit (normal), False if the
    WebView2 engine failed to initialise (so the caller can fall back).
    """
    global window, _native_active
    try:
        import webview
    except Exception:  # noqa: BLE001 — pywebview missing
        return False
    try:
        os.makedirs(WEBVIEW_STORAGE, exist_ok=True)
        window = webview.create_window(
            "AI Note-Taker",
            html=SPLASH_HTML,
            js_api=_win_api,
            width=1240,
            height=820,
            min_size=(940, 620),
            background_color="#e9e1ce",
        )
        _win_api.bind(window)

        # Theme the native OS titlebar dark to match the app once the form exists.
        def _on_shown(*a):
            try:
                form = getattr(window, "native", None)
                if form is not None:
                    _apply_dark_titlebar(int(form.Handle.ToInt32()))
            except Exception:  # noqa: BLE001
                pass

        window.events.closing += _on_closing
        window.events.shown += _on_shown
        _native_active = True
        threading.Thread(target=_load_app_when_ready, daemon=True).start()
        webview.start(private_mode=False, storage_path=WEBVIEW_STORAGE)
    except Exception:  # noqa: BLE001
        _native_active = False
        return False
    _native_active = False
    # webview.start() returns when the window is destroyed. If we didn't ask to
    # quit, the engine failed to stay up (0x8007139F) — signal a fallback.
    return _quitting


# ---- Browser app-window fallback ----

def _find_browser():
    """Locate a Chromium browser that supports --app mode (Edge, then Chrome)."""
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    local = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for path in candidates:
        if path and os.path.exists(path):
            return path
    return None


def _splash_url():
    return "file:///" + SPLASH_FILE.replace("\\", "/")


def _write_splash():
    try:
        os.makedirs(APP_DIR, exist_ok=True)
        with open(SPLASH_FILE, "w", encoding="utf-8") as f:
            f.write(SPLASH_HTML_POLL)
        return True
    except Exception:  # noqa: BLE001
        return False


def _open_browser_window(url):
    """Open a chromeless browser app-window at `url` (fallback shell)."""
    browser = _find_browser()
    if not browser:
        webbrowser.open(url if url.startswith("http") else URL)
        return
    try:
        os.makedirs(APP_PROFILE, exist_ok=True)
        subprocess.Popen([
            browser,
            f"--app={url}",
            f"--user-data-dir={APP_PROFILE}",
            "--no-first-run",
            "--no-default-browser-check",
            f"--window-size={WINDOW_SIZE}",
        ])
    except Exception:  # noqa: BLE001
        webbrowser.open(URL)


def _run_fallback():
    """Browser app-window shell; blocks until the user quits from the tray."""
    _write_splash()
    _open_browser_window(_splash_url())
    while not _quitting:
        time.sleep(0.5)


# ---- Tray + lifecycle ----

def _show(icon=None, item=None):
    """Tray 'Open' — reopen the native window, or a browser window in fallback."""
    if _native_active and window is not None:
        try:
            window.show()
            return
        except Exception:  # noqa: BLE001
            pass
    _open_browser_window(URL if _server_ready() else _splash_url())


def _quit(icon=None, item=None):
    global _quitting
    _quitting = True
    if window is not None:
        try:
            window.destroy()
        except Exception:  # noqa: BLE001
            pass
    if tray is not None:
        tray.stop()


def _disable_webview_cache():
    """Force WebView2 to never serve stale static assets from its disk cache.

    Problem: WebView2 caches kinpaku.css / app.js on disk and re-serves the old
    copy after an update, ignoring HTTP Cache-Control headers. That made every
    frontend change invisible until the cache was hand-cleared. We append
    Chromium flags that disable the HTTP disk cache entirely. Local dev server
    is fast, so always re-fetching is fine and guarantees a code change always
    shows up. Patched at runtime (not in the venv) so it survives reinstalls.
    """
    try:
        from webview.platforms import edgechromium

        _orig_init = edgechromium.EdgeChrome.__init__

        def _patched(self, *a, **kw):
            _orig_init(self, *a, **kw)
            # Append to whatever AdditionalBrowserArguments pywebview already set.
            # --disable-cache stops the HTTP disk cache so a CSS/JS edit always shows.
            # (Avoid --incognito: it conflicts with pywebview's own profile handling.)
            flags = " --disable-cache"
            try:
                self.webview.CreationProperties.AdditionalBrowserArguments += flags
            except Exception:  # noqa: BLE001
                pass

        edgechromium.EdgeChrome.__init__ = _patched
    except Exception:  # noqa: BLE001 — non-fatal; cache just stays on
        pass


def main():
    global tray

    _setup_logging()  # valid stdout/stderr + a persistent log under pythonw
    _disable_webview_cache()  # never serve stale CSS/JS from the WebView2 cache

    # Single instance: if we can't grab the lock, another instance is already
    # running or starting. Best effort: open a browser window against it if the
    # server is up, then exit — the existing process owns the window + tray.
    if not _acquire_lock():
        if _server_ready():
            _open_browser_window(URL)
        return

    threading.Thread(target=_run_server, daemon=True).start()

    # Tray in its own thread so the native GUI can own the main thread.
    tray = pystray.Icon(
        "ai-note-taker",
        _tray_image(),
        "AI Note-Taker",
        menu=pystray.Menu(
            pystray.MenuItem("Open", _show, default=True),
            pystray.MenuItem("Quit", _quit),
        ),
    )
    tray.run_detached()

    # Native window first; fall back to a browser app-window if WebView2 refuses.
    if not _run_native() and not _quitting:
        _run_fallback()

    if tray is not None:
        tray.stop()


if __name__ == "__main__":
    main()
