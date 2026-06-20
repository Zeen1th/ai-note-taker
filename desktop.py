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
LOADING_HTML = """
<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{height:100%;margin:0}
  body{background:#0f1115;color:#e6e8ec;display:flex;align-items:center;
       justify-content:center;font-family:system-ui,Segoe UI,sans-serif;
       -webkit-user-select:none;user-select:none}
  .wrap{text-align:center}
  .logo{font-size:34px;margin-bottom:14px}
  .name{font-size:17px;font-weight:600;letter-spacing:.2px}
  .sub{font-size:13px;color:#9aa3b2;margin-top:8px}
  .ring{width:26px;height:26px;margin:22px auto 0;border:3px solid #2a2f3a;
        border-top-color:#6ea8fe;border-radius:50%;animation:s .8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
</style></head><body><div class="wrap">
  <div class="logo">🎙️</div>
  <div class="name">AI Note-Taker</div>
  <div class="sub">Starting the local engine…</div>
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
        background_color="#0f1115",
    )
    webview.start(_on_ready)


if __name__ == "__main__":
    main()
