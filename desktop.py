"""Desktop launcher for AI Note-Taker.

Starts the FastAPI/uvicorn server in a background thread and opens the app in a
chromeless **browser app window** (Edge/Chrome `--app=`), plus a system-tray icon.

Why app-mode instead of an embedded webview: embedding a WebView2 *controller*
(via pywebview) proved unreliable on some Windows setups — `CreateCoreWebView2-
Controller` intermittently fails with HRESULT 0x8007139F ("the group or resource
is not in the correct state"), and the window silently never appears. Launching
the system browser in app-mode uses the full browser's own (battle-tested)
process + profile management, which does not hit that failure. The window is
chromeless (no tabs/URL bar), so it still feels like a native app.

Closing the window leaves the server running (the tray icon stays); click the
tray icon to reopen, or right-click -> Quit to exit fully.

Run with:  python desktop.py     (or the bundled notetaker.bat)
"""

import os
import subprocess
import threading
import time
import urllib.request
import webbrowser

import pystray
import uvicorn
from PIL import Image, ImageDraw

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}/"

# Dedicated browser profile for the app window, kept on the local C: drive under
# LOCALAPPDATA (a normal, conventional location) so it's isolated from the user's
# main browser profile while still persisting their theme/palette choice.
APP_PROFILE = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
    "AINoteTaker", "browser-profile",
)

WINDOW_SIZE = "1240,820"

tray = None
_quitting = False


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


def _open_app_window(icon=None, item=None):
    """Open the app in a chromeless window; fall back to the default browser."""
    browser = _find_browser()
    if browser:
        try:
            os.makedirs(APP_PROFILE, exist_ok=True)
            subprocess.Popen([
                browser,
                f"--app={URL}",
                f"--user-data-dir={APP_PROFILE}",
                "--no-first-run",
                "--no-default-browser-check",
                f"--window-size={WINDOW_SIZE}",
            ])
            return
        except Exception:  # noqa: BLE001 — fall back to a normal browser tab
            pass
    webbrowser.open(URL)


def _quit(icon=None, item=None):
    global _quitting
    _quitting = True
    if tray:
        tray.stop()


def _run_server():
    config = uvicorn.Config("app:app", host=HOST, port=PORT, log_level="warning")
    uvicorn.Server(config).run()


def _server_ready(timeout=1.0):
    try:
        urllib.request.urlopen(URL, timeout=timeout)
        return True
    except Exception:  # noqa: BLE001
        return False


def _wait_then_open():
    """Poll until the server answers (models load on startup), then open the window."""
    for _ in range(360):  # up to ~3 min for first-run model downloads
        if _quitting:
            return
        if _server_ready():
            _open_app_window()
            return
        time.sleep(0.5)


def main():
    global tray

    # Single instance: if a server is already up, just open another window
    # against it and exit — the existing process owns the tray icon.
    if _server_ready():
        _open_app_window()
        return

    threading.Thread(target=_run_server, daemon=True).start()
    threading.Thread(target=_wait_then_open, daemon=True).start()

    tray = pystray.Icon(
        "ai-note-taker",
        _tray_image(),
        "AI Note-Taker — starting…",
        menu=pystray.Menu(
            pystray.MenuItem("Open", _open_app_window, default=True),
            pystray.MenuItem("Quit", _quit),
        ),
    )
    tray.run()  # blocks until _quit() stops it; the daemon server thread then exits


if __name__ == "__main__":
    main()
