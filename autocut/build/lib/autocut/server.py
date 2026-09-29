"""Local server behind the Autocut app and the Premiere panel.

Listens on 127.0.0.1 only. Every /api call needs the random token written to
<home>/server.json at start-up (the app opens the page with it; the Premiere
panel reads the file), so other web pages in the browser cannot drive it.
Jobs run as `python -m autocut ...` subprocesses: cancellable, and the memory
of a 2-hour analysis is returned when it ends.
"""
from __future__ import annotations

import json
import mimetypes
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yaml

from . import __version__, models
from .config import DEFAULTS, ConfigError, load
from .scan import WORK_DIR, ScanError, scan

UI_DIR = Path(__file__).parent / "ui"
DEFAULT_PORT = 47821
IDLE_EXIT_S = 30 * 60


class Job:
    def __init__(self, kind: str, cmd: list[str], project: str | None, extra_env: dict | None = None):
        self.kind = kind
        self.project = project
        self.cmd = cmd
        self.lines: list[str] = []
        self.exit_code: int | None = None
        self.started = time.time()
        env = dict(os.environ, PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8", **(extra_env or {}))
        self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     env=env, start_new_session=True)
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for raw in self.proc.stdout:
            self.lines.append(raw.decode("utf-8", errors="replace").rstrip("\n"))
        self.exit_code = self.proc.wait()

    @property
    def running(self) -> bool:
        return self.exit_code is None

    def cancel(self):
        if self.running:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                self.proc.terminate()

    def to_dict(self, since: int = 0) -> dict:
        return {"kind": self.kind, "project": self.project, "running": self.running,
                "exit_code": self.exit_code, "lines": self.lines[since:], "total": len(self.lines),
                "elapsed": round(time.time() - self.started)}


class State:
    def __init__(self, token: str, app_mode: bool):
        self.token = token
        self.app_mode = app_mode
        self.job: Job | None = None
        self.last_seen = time.time()
        self.lock = threading.Lock()


# --- helpers used by the API -----------------------------------------------

def engine_cmd(*args: str) -> list[str]:
    return [sys.executable, "-m", "autocut", *args]


def config_text(cfg: dict) -> str:
    """config.yaml with a short Arabic/English header; values from `cfg`."""
    head = ("# autocut project config — written by the Autocut app.\n"
            "# ملف إعدادات المشروع — يمكن تعديله من التطبيق أو يدوياً.\n")
    return head + yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False, default_flow_style=False)


def project_state(path: Path) -> dict:
    path = Path(path).expanduser().resolve()
    out: dict = {"path": str(path), "exists": path.is_dir()}
    if not path.is_dir():
        return out
    cfg_p = path / "config.yaml"
    out["has_config"] = cfg_p.exists()
    subdirs = sorted(p.name for p in path.iterdir()
                     if p.is_dir() and not p.name.startswith(".") and p.name != WORK_DIR)
    out["folders"] = subdirs
    cfg = None
    if cfg_p.exists():
        try:
            cfg = load(cfg_p)
        except ConfigError as e:
            out["config_error"] = str(e)
    if cfg is None:
        cfg = json.loads(json.dumps(DEFAULTS))
        cands = [d for d in subdirs if d != "audio"]
        wide = [d for d in cands if any(k in d.lower() for k in ("wide", "long", "master", "واسع"))]
        cfg["long_camera"] = (wide or cands or [None])[0]
        cfg["fps"] = 25
    out["config"] = cfg
    if cfg.get("long_camera"):
        try:
            p = scan(path, cfg)
            out["scan"] = {
                "fps": str(p.rate),
                "cameras": [{"name": c.name, "clips": [
                    {"name": k.path.name, "duration": round(k.info.duration, 2),
                     "fps": float(k.info.fps) if k.info.fps else None, "tc": k.info.start_tc,
                     "audio": k.info.has_audio, "width": k.info.width, "height": k.info.height}
                    for k in c.clips]} for c in p.cameras.values()],
                "audio": [{"name": a.path.name, "duration": round(a.duration, 2),
                           "channels": a.audio_channels} for a in p.audio],
            }
        except (ScanError, Exception) as e:  # noqa: BLE001 — report any scan problem to the UI
            out["scan_error"] = str(e)
    work = path / WORK_DIR
    sp = work / "speakers.json"
    if sp.exists():
        out["speakers"] = json.loads(sp.read_text(encoding="utf-8"))
    rep = work / "output" / "sync_report.csv"
    if rep.exists():
        import csv
        with open(rep, encoding="utf-8") as fh:
            out["sync"] = list(csv.DictReader(fh))
    outdir = work / "output"
    if outdir.exists():
        out["outputs"] = [{"name": f.name, "path": str(f), "mtime": f.stat().st_mtime}
                          for f in sorted(outdir.iterdir(), key=lambda f: -f.stat().st_mtime)
                          if f.suffix in (".xml", ".csv")]
    return out


def choose(kind: str, prompt: str) -> str | None:
    if sys.platform != "darwin":
        raise RuntimeError("native dialogs are macOS only — type the path instead")
    what = "choose folder" if kind == "folder" else "choose file"
    prompt = prompt.replace("\\", "").replace('"', "")
    r = subprocess.run(["osascript", "-e", "activate",
                        "-e", f'POSIX path of ({what} with prompt "{prompt}")'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return None  # user cancelled
    return r.stdout.strip().rstrip("/") or None


def reveal(path: str, open_it: bool = False) -> None:
    if sys.platform == "darwin":
        subprocess.run(["open", path] if open_it else ["open", "-R", path], check=False)
    elif shutil.which("xdg-open"):
        subprocess.run(["xdg-open", path if open_it else str(Path(path).parent)], check=False)


# --- HTTP ------------------------------------------------------------------

def make_handler(state: State):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"autocut/{__version__}"

        def log_message(self, fmt, *args):  # quiet
            pass

        def _send(self, code: int, body: bytes, ctype: str):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, obj, code: int = 200):
            self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                       "application/json; charset=utf-8")

        def _authorized(self, qs) -> bool:
            tok = self.headers.get("X-Autocut-Token") or (qs.get("t") or [None])[0]
            return bool(tok) and secrets.compare_digest(tok, state.token)

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            if n > 1_000_000:
                raise ValueError("request too large")
            return json.loads(self.rfile.read(n) or b"{}")

        def do_GET(self):
            u = urlparse(self.path)
            qs = parse_qs(u.query)
            if not u.path.startswith("/api/"):
                return self._static(u.path)
            if not self._authorized(qs):
                return self._json({"error": "unauthorized"}, 401)
            state.last_seen = time.time()
            try:
                self._get_api(u.path, qs)
            except Exception as e:  # noqa: BLE001
                self._json({"error": str(e)}, 500)

        def do_POST(self):
            u = urlparse(self.path)
            if not self._authorized(parse_qs(u.query)):
                return self._json({"error": "unauthorized"}, 401)
            state.last_seen = time.time()
            try:
                self._post_api(u.path, self._body())
            except Exception as e:  # noqa: BLE001
                self._json({"error": str(e)}, 500)

        def _static(self, path: str):
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            f = (UI_DIR / rel).resolve()
            if UI_DIR.resolve() not in f.parents or not f.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype.endswith("javascript"):
                ctype += "; charset=utf-8"
            self._send(200, f.read_bytes(), ctype)

        # GET /api/...
        def _get_api(self, path: str, qs: dict):
            q = {k: v[0] for k, v in qs.items()}
            if path == "/api/ping":
                return self._json({"version": __version__, "models": models.status(),
                                   "platform": sys.platform})
            if path == "/api/project":
                return self._json(project_state(Path(q["path"])))
            if path == "/api/job":
                job = state.job
                return self._json(job.to_dict(int(q.get("since", 0))) if job else {"running": False})
            if path == "/api/sample":
                proj = Path(q["path"]).expanduser().resolve()
                name = Path(q["file"]).name  # no directories
                f = proj / WORK_DIR / "speaker_samples" / name
                if not name.endswith(".wav") or not f.is_file():
                    return self._send(404, b"not found", "text/plain")
                return self._send(200, f.read_bytes(), "audio/wav")
            return self._json({"error": "unknown endpoint"}, 404)

        # POST /api/...
        def _post_api(self, path: str, b: dict):
            if path == "/api/heartbeat":
                return self._json({"ok": True})
            if path == "/api/choose":
                return self._json({"path": choose(b.get("kind", "folder"), b.get("prompt", "Autocut"))})
            if path == "/api/config":
                proj = Path(b["path"]).expanduser().resolve()
                cfg = b["config"]
                (proj / "config.yaml").write_text(config_text(cfg), encoding="utf-8")
                load(proj / "config.yaml")  # validate what we wrote
                return self._json({"ok": True})
            if path == "/api/reveal":
                reveal(b["path"], bool(b.get("open")))
                return self._json({"ok": True})
            if path == "/api/job/cancel":
                if state.job:
                    state.job.cancel()
                return self._json({"ok": True})
            if path == "/api/run":
                return self._start(b)
            if path == "/api/shutdown":
                self._json({"ok": True})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
                return None
            return self._json({"error": "unknown endpoint"}, 404)

        def _start(self, b: dict):
            with state.lock:
                if state.job and state.job.running:
                    return self._json({"error": "a job is already running"}, 409)
                kind = b["kind"]
                proj = b.get("path")
                env = None
                if kind in ("scan", "sync", "diarize", "run"):
                    args = [kind, str(Path(proj).expanduser().resolve())]
                    if kind != "scan":
                        if b.get("start"):
                            args += ["--start", str(b["start"])]
                        if b.get("duration"):
                            args += ["--duration", str(b["duration"])]
                    if kind in ("diarize", "run") and b.get("diarize_full"):
                        args.append("--diarize-full")
                    if kind == "run" and b.get("allow_low"):
                        args.append("--allow-low-confidence")
                elif kind == "models-download":
                    args = ["models", "download"]
                    env = {"HF_TOKEN": str(b.get("token") or "")}  # not on the command line
                elif kind == "models-import":
                    args = ["models", "import", str(b["zip"])]
                elif kind == "models-export":
                    args = ["models", "export", str(b["dest"])]
                else:
                    return self._json({"error": f"unknown job {kind}"}, 400)
                state.job = Job(kind, engine_cmd(*args), proj, env)
                return self._json({"ok": True})

    return Handler


def _free_port(preferred: int) -> int:
    for port in (preferred, 0):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("no free port")


def running_server() -> dict | None:
    """server.json of a live server, if one is running."""
    f = models.home() / "server.json"
    if not f.exists():
        return None
    try:
        info = json.loads(f.read_text())
        with socket.create_connection(("127.0.0.1", int(info["port"])), timeout=0.5):
            return info
    except (OSError, ValueError, KeyError):
        return None


def serve(port: int = DEFAULT_PORT, open_browser: bool = False, app_mode: bool = False) -> int:
    existing = running_server()
    if existing:
        url = f"http://127.0.0.1:{existing['port']}/?t={existing['token']}"
        print(f"Autocut already running: {url}", flush=True)
        if open_browser:
            webbrowser.open(url)
        return 0
    token = secrets.token_urlsafe(24)
    state = State(token, app_mode)
    port = _free_port(port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    info_f = models.home() / "server.json"
    info_f.write_text(json.dumps({"port": port, "token": token, "pid": os.getpid()}))
    os.chmod(info_f, 0o600)
    url = f"http://127.0.0.1:{port}/?t={token}"
    print(f"Autocut {__version__} on {url}", flush=True)

    if app_mode:
        def idle_watch():
            while True:
                time.sleep(30)
                busy = state.job is not None and state.job.running
                if not busy and time.time() - state.last_seen > IDLE_EXIT_S:
                    httpd.shutdown()
                    return
        threading.Thread(target=idle_watch, daemon=True).start()
    if open_browser:
        threading.Timer(0.3, webbrowser.open, args=(url,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if state.job and state.job.running:
            state.job.cancel()
        try:
            if json.loads(info_f.read_text()).get("pid") == os.getpid():
                info_f.unlink()
        except (OSError, ValueError):
            pass
    return 0
