"""Desktop launcher for AI Note-Taker.

Starts the FastAPI/uvicorn server in a background thread and opens it in a native
window (pywebview + the OS WebView2 engine on Windows). Adds a system-tray icon:
closing the window hides it to the tray; the app keeps running in the background.

Run with:  python desktop.py
"""

import threading
import time
import urllib.request

import pystray
import uvicorn
import webview
from PIL import Image, ImageDraw

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}/"

# Module-level handles (NOT stored on a js_api object — pywebview would try to
# serialize the window's native COM object and crash).
window = None
tray = None
_quitting = False

# Splash shown while the server loads its models (first start is slow).
# Colours match the app's default "aurora" dark theme.
LOADING_HTML = """
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0}
  body{background:#0c0c10;color:#fbfbfd;display:flex;align-items:center;
       justify-content:center;font-family:'Segoe UI',system-ui,sans-serif;
       -webkit-user-select:none;user-select:none;
       background-image:radial-gradient(520px 300px at 80% -10%,rgba(236,72,153,0.16),transparent 70%)}
  .wrap{text-align:center}
  .logo{font-size:34px;margin-bottom:14px}
  .name{font-size:16px;font-weight:600;letter-spacing:.4px;font-family:'Consolas',monospace}
  .name b{background:linear-gradient(135deg,#ec4899,#8b5cf6);-webkit-background-clip:text;background-clip:text;color:transparent}
  .sub{font-size:12px;color:#9a9aa6;margin-top:8px;font-family:'Consolas',monospace}
  .ring{width:26px;height:26px;margin:22px auto 0;border:3px solid #2c2c34;
        border-top-color:#ec4899;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap">
  <div class="logo">🎙️</div>
  <div class="name">note<b>·</b>taker</div>
  <div class="sub">starting the local engine…</div>
  <div class="ring"></div>
</div></body></html>
"""


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


def _show_window(icon=None, item=None):
    if window:
        window.show()


def _quit(icon=None, item=None):
    global _quitting
    _quitting = True
    if tray:
        tray.stop()
    if window:
        window.destroy()


def _on_closing():
    """Closing the window hides it to the tray instead of quitting."""
    if _quitting:
        return True       # allow the real close
    if window:
        window.hide()
    return False          # cancel the close


def _run_server():
    config = uvicorn.Config("app:app", host=HOST, port=PORT, log_level="warning")
    uvicorn.Server(config).run()


def _on_ready():
    """Poll until the server answers, then swap the splash for the app."""
    for _ in range(240):  # up to ~2 min for first-run model downloads
        try:
            urllib.request.urlopen(URL, timeout=1)
            break
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    if window:
        window.load_url(URL)


def main():
    global window, tray

    threading.Thread(target=_run_server, daemon=True).start()

    window = webview.create_window(
        "AI Note-Taker",
        html=LOADING_HTML,
        width=1240,
        height=820,
        min_size=(940, 620),
        background_color="#0c0c10",
    )
    window.events.closing += _on_closing

    tray = pystray.Icon(
        "ai-note-taker",
        _tray_image(),
        "AI Note-Taker",
        menu=pystray.Menu(
            pystray.MenuItem("Open", _show_window, default=True),
            pystray.MenuItem("Quit", _quit),
        ),
    )
    tray.run_detached()

    webview.start(_on_ready)

    # webview.start() returns once the window is really destroyed (Quit).
    if tray:
        tray.stop()


if __name__ == "__main__":
    main()
