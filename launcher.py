"""Source Worker launcher — standalone desktop app window.

Shows a splash instantly, starts the server in the background, then displays the
UI. Window strategy, most-preferred first: pywebview (embedded WebView2) → Edge/
Chrome `--app` (chromeless window) → default browser. uvicorn runs in a daemon
thread; readiness is checked via a socket connect (reliable in frozen builds).
"""
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

_SPLASH = """\
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Source Worker</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0d1117;display:flex;align-items:center;justify-content:center;height:100vh;
font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#c9d1d9;overflow:hidden}
.wrap{text-align:center}
.logo{font-size:64px;color:#4f8cff;text-shadow:0 0 22px rgba(79,140,255,.6);margin-bottom:18px;animation:pulse 2s ease-in-out infinite}
h1{font-size:22px;font-weight:700;color:#e6edf3;margin-bottom:8px}h1 span{color:#4f8cff}
p{font-size:13px;color:#6e7681;margin-bottom:30px}
.bar{width:210px;height:3px;background:#21262d;border-radius:3px;margin:0 auto;overflow:hidden;position:relative}
.bar::after{content:'';position:absolute;left:-40%;top:0;width:40%;height:100%;
background:linear-gradient(90deg,transparent,#4f8cff,#9a6bff,transparent);animation:slide 1.2s ease-in-out infinite}
@keyframes slide{0%{left:-40%}100%{left:100%}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
</style></head><body><div class="wrap"><div class="logo">⬡</div>
<h1>Source<span>Worker</span></h1><p>Starting your digital worker…</p><div class="bar"></div></div></body></html>
"""


def find_browser():
    for c in [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
    ]:
        if os.path.isfile(c):
            return c
    for n in ("msedge", "chrome", "chromium"):
        w = shutil.which(n)
        if w:
            return w
    return None


def main():
    data_dir = Path(os.getenv("SOURCE_WORKER_DATA") or (Path(os.getenv("LOCALAPPDATA") or Path.home()) / "SourceWorker"))
    data_dir.mkdir(parents=True, exist_ok=True)
    logfile = data_dir / "source-worker.log"

    def log(m):
        try:
            with logfile.open("a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {m}\n")
        except Exception:
            pass

    if sys.stdout is None or sys.stderr is None:
        _l = open(logfile, "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stdout or _l
        sys.stderr = sys.stderr or _l

    log("launcher start")
    if getattr(sys, "frozen", False):
        os.environ.setdefault("SOURCE_WORKER_STATIC", str(Path(sys._MEIPASS) / "static"))

    port = int(os.getenv("SOURCE_WORKER_PORT", "8785"))
    url = f"http://127.0.0.1:{port}"

    import uvicorn
    from server import app

    def start_server():
        uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")).run()

    def wait_ready():
        for _ in range(400):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                    return True
            except OSError:
                time.sleep(0.12)
        return False

    threading.Thread(target=start_server, daemon=True).start()

    # 1. pywebview (embedded), with an instant splash that swaps to the app when ready
    try:
        import webview

        window = webview.create_window("Source Worker", html=_SPLASH, width=1320, height=880, min_size=(980, 640))

        def on_ready():
            if wait_ready():
                log("server ready -> webview")
                window.load_url(url)
        webview.start(func=on_ready, gui="edgechromium")
        os._exit(0)
    except Exception as e:
        log(f"pywebview unavailable ({e})")

    # 2. Edge/Chrome --app (chromeless window)
    wait_ready()
    browser = find_browser()
    log(f"fallback browser={browser}")
    if browser:
        try:
            profile = tempfile.mkdtemp(prefix="SourceWorker_")
            proc = subprocess.Popen([browser, f"--app={url}", f"--user-data-dir={profile}",
                                     "--no-first-run", "--no-default-browser-check", "--window-size=1320,880"])
            log("launched --app window")
            proc.wait()
            os._exit(0)
        except Exception as e:
            log(f"--app launch failed: {e}")

    # 3. default browser
    import webbrowser
    webbrowser.open(url)
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
