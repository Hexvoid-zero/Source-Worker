"""Source Worker launcher — standalone desktop app window.

Shows a splash instantly, starts the server in the background, then displays the
UI. Window strategy, most-preferred first: pywebview (embedded WebView2) → Edge/
Chrome `--app` (chromeless window) → default browser. uvicorn runs in a daemon
thread; readiness is checked via a socket connect (reliable in frozen builds).
"""
import os
import sys
import tempfile
import threading
import time
from pathlib import Path

_SPLASH = """\
<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Source Worker</title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1E1B4B;display:flex;align-items:center;justify-content:center;height:100vh;
font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#F8FAFC;overflow:hidden}
.wrap{text-align:center}
.logo{font-size:64px;color:#3B82F6;text-shadow:0 0 22px rgba(59,130,246,.6);margin-bottom:18px;animation:pulse 2s ease-in-out infinite}
h1{font-size:22px;font-weight:700;color:#F8FAFC;margin-bottom:8px}h1 span{color:#3B82F6}
p{font-size:13px;color:#64748B;margin-bottom:30px}
.bar{width:210px;height:3px;background:#252150;border-radius:3px;margin:0 auto;overflow:hidden;position:relative}
.bar::after{content:'';position:absolute;left:-40%;top:0;width:40%;height:100%;
background:linear-gradient(90deg,transparent,#3B82F6,#06B6D4,transparent);animation:slide 1.2s ease-in-out infinite}
@keyframes slide{0%{left:-40%}100%{left:100%}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
</style></head><body><div class="wrap"><div class="logo">⬡</div>
<h1>Source<span>Worker</span></h1><p>Starting your digital worker…</p><div class="bar"></div></div></body></html>
"""


def main():
    if getattr(sys, "frozen", False):
        os.environ.setdefault("SOURCE_WORKER_STATIC", str(Path(sys._MEIPASS) / "static"))

    # Setup logfile
    data_dir = Path(os.getenv("SOURCE_WORKER_DATA") or (Path(os.getenv("LOCALAPPDATA") or Path.home()) / "SourceWorker"))
    data_dir.mkdir(parents=True, exist_ok=True)
    logfile = data_dir / "source-worker.log"

    def log(msg):
        try:
            with logfile.open("a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        except Exception:
            pass

    # Redirect stdout/stderr if no console
    if sys.stdout is None or sys.stderr is None:
        _log = open(logfile, "a", buffering=1, encoding="utf-8")
        sys.stdout = sys.stdout or _log
        sys.stderr = sys.stderr or _log

    log("launcher start")

    port = int(os.getenv("SOURCE_WORKER_PORT", "8785"))
    url = f"http://127.0.0.1:{port}"

    try:
        if os.getenv("SOURCE_WORKER_HEADLESS") == "1":
            raise RuntimeError("Headless mode requested via SOURCE_WORKER_HEADLESS")

        import webview

        window = webview.create_window(
            "Source Worker", html=_SPLASH,
            width=1320, height=880, min_size=(980, 640),
            text_select=True
        )

        def _on_gui_ready():
            def _boot():
                try:
                    log("boot thread start")
                    import httpx
                    import uvicorn
                    log("importing server")
                    from server import app
                    log("server imported")

                    config = uvicorn.Config(
                        app,
                        host="127.0.0.1",
                        port=port,
                        log_level="warning",
                        log_config={
                            "version": 1,
                            "disable_existing_loggers": False,
                            "formatters": {
                                "default": {"format": "%(levelname)s: %(message)s"}
                            },
                            "handlers": {
                                "default": {
                                    "class": "logging.StreamHandler",
                                    "formatter": "default"
                                }
                            },
                            "loggers": {
                                "uvicorn": {
                                    "handlers": ["default"],
                                    "level": "WARNING"
                                }
                            }
                        }
                    )
                    server = uvicorn.Server(config)
                    log("starting uvicorn")
                    threading.Thread(target=server.run, daemon=True).start()

                    log("waiting for health endpoint")
                    for _ in range(300):
                        try:
                            if httpx.get(url + "/api/ping", timeout=1.0).status_code == 200:
                                break
                        except Exception:
                            time.sleep(0.05)

                    log(f"Source Worker ready — {url}")
                    window.load_url(url)
                except Exception as e:
                    import traceback
                    log(f"BOOT EXCEPTION: {e}")
                    log(traceback.format_exc())

            threading.Thread(target=_boot, daemon=True).start()

        webview.start(func=_on_gui_ready, gui="edgechromium")

    except Exception as e:
        log(f"Native window unavailable ({e}); falling back to default browser")
        import httpx
        import uvicorn
        from server import app

        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        server = uvicorn.Server(config)
        threading.Thread(target=server.run, daemon=True).start()

        for _ in range(300):
            try:
                if httpx.get(url + "/api/ping", timeout=1.0).status_code == 200:
                    break
            except Exception:
                time.sleep(0.05)

        if os.getenv("SOURCE_WORKER_HEADLESS") != "1":
            import webbrowser
            webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass

    os._exit(0)


if __name__ == "__main__":
    main()
