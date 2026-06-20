"""Desktop launcher for AI Note-Taker.

Starts the FastAPI/uvicorn server in a background thread and opens it inside a
native, frameless window (pywebview + the OS WebView2 engine on Windows) with a
custom title bar. The web UI is identical to the browser version.

Run with:  python desktop.py
"""

import threading
import time
import urllib.request

import uvicorn
import webview

HOST = "127.0.0.1"
PORT = 8000
URL = f"http://{HOST}:{PORT}/"

# The window lives at module scope (NOT as an attribute on the js_api object) so
# pywebview doesn't try to serialize the window's native COM object into the JS
# bridge — doing so triggers recursion / cross-thread WebView2 errors.
window = None

# Splash shown while the server loads its models (first start is slow).
# Colours match the app's "blueprint" dark theme (navy paper + cyan grid).
LOADING_HTML = """
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0}
  body{background:#0a1424;color:#eaf2ff;display:flex;align-items:center;
       justify-content:center;font-family:'Segoe UI',system-ui,sans-serif;
       -webkit-user-select:none;user-select:none;
       background-image:linear-gradient(rgba(120,170,255,0.07) 1px,transparent 1px),
                        linear-gradient(90deg,rgba(120,170,255,0.07) 1px,transparent 1px);
       background-size:28px 28px}
  .wrap{text-align:center}
  .logo{font-size:34px;margin-bottom:14px}
  .name{font-size:16px;font-weight:600;letter-spacing:.4px;
        font-family:'Consolas',monospace}
  .name b{color:#4d9fff}
  .sub{font-size:12px;color:#8298bd;margin-top:8px;font-family:'Consolas',monospace}
  .ring{width:26px;height:26px;margin:22px auto 0;border:3px solid #22304d;
        border-top-color:#4d9fff;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap">
  <div class="logo">🎙️</div>
  <div class="name">note<b>·</b>taker</div>
  <div class="sub">starting the local engine…</div>
  <div class="ring"></div>
</div></body></html>
"""


class Api:
    """Window controls called from the custom title bar via window.pywebview.api."""

    def __init__(self):
        self._maximized = False

    def minimize(self):
        if window:
            window.minimize()

    def toggle_maximize(self):
        if not window:
            return
        if self._maximized:
            window.restore()
        else:
            window.maximize()
        self._maximized = not self._maximized

    def close(self):
        if window:
            window.destroy()


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
    global window
    threading.Thread(target=_run_server, daemon=True).start()

    window = webview.create_window(
        "AI Note-Taker",
        html=LOADING_HTML,
        js_api=Api(),
        frameless=True,
        easy_drag=False,
        width=1240,
        height=820,
        min_size=(940, 620),
        background_color="#0a1424",
    )
    webview.start(_on_ready)


if __name__ == "__main__":
    main()
