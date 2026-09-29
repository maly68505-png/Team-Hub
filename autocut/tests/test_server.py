import json
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

from autocut import server
from autocut.config import load


@pytest.fixture
def srv(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOCUT_HOME", str(tmp_path / "home"))
    state = server.State("tok123", app_mode=False)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(state))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}", state
    httpd.shutdown()


def call(base, path, body=None, token="tok123"):
    req = urllib.request.Request(base + path, method="POST" if body is not None else "GET",
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"X-Autocut-Token": token} if token else {})
    try:
        with urllib.request.urlopen(req) as r:
            ctype = r.headers.get("Content-Type", "")
            data = r.read()
            return r.status, json.loads(data) if "json" in ctype else data
    except urllib.error.HTTPError as e:
        return e.code, e.read()


@pytest.fixture
def project(tmp_path):
    p = tmp_path / "Shoot"
    for d in ("audio", "CAM_WIDE", "CAM_A"):
        (p / d).mkdir(parents=True)
    return p


def test_token_required(srv):
    base, _ = srv
    assert call(base, "/api/ping", token=None)[0] == 401
    assert call(base, "/api/ping", token="wrong")[0] == 401
    code, data = call(base, "/api/ping")
    assert code == 200 and "models" in data


def test_static_ui_served_without_token_and_no_traversal(srv):
    base, _ = srv
    code, body = call(base, "/", token=None)
    assert code == 200 and b"Autocut" in body
    assert call(base, "/app.js", token=None)[0] == 200
    assert call(base, "/../server.py", token=None)[0] == 404
    assert call(base, "/%2e%2e/server.py", token=None)[0] == 404


def test_project_state_guesses_wide_camera_and_writes_config(srv, project):
    base, _ = srv
    code, st = call(base, "/api/project?path=" + str(project))
    assert code == 200 and st["exists"] and not st["has_config"]
    assert st["config"]["long_camera"] == "CAM_WIDE"
    assert "scan_error" in st  # no media yet — reported, not a crash
    cfg = st["config"]
    cfg["speakers"] = {"SPEAKER_00": "CAM_A"}
    cfg["cut"]["min_shot"] = 3.0
    assert call(base, "/api/config", {"path": str(project), "config": cfg})[0] == 200
    saved = load(project / "config.yaml")
    assert saved["speakers"] == {"SPEAKER_00": "CAM_A"} and saved["cut"]["min_shot"] == 3.0


def test_sample_endpoint_cannot_escape(srv, project):
    base, _ = srv
    s = project / "_autocut" / "speaker_samples"
    s.mkdir(parents=True)
    (s / "SPEAKER_00_1.wav").write_bytes(b"RIFF....")
    (project / "secret.wav").write_bytes(b"secret")
    ok = call(base, f"/api/sample?path={project}&file=SPEAKER_00_1.wav")
    assert ok[0] == 200 and ok[1] == b"RIFF...."
    assert call(base, f"/api/sample?path={project}&file=../../secret.wav")[0] == 404


def test_job_runs_engine_and_streams_log(srv, project):
    base, _ = srv
    (project / "config.yaml").write_text("long_camera: CAM_WIDE\n")
    assert call(base, "/api/run", {"kind": "scan", "path": str(project)})[0] == 200
    for _ in range(100):
        code, j = call(base, "/api/job?since=0")
        if not j["running"]:
            break
        time.sleep(0.1)
    assert j["exit_code"] == 1  # no video in the camera folders
    assert any("no video files" in line for line in j["lines"])


def test_unknown_job_rejected(srv):
    base, _ = srv
    assert call(base, "/api/run", {"kind": "rm -rf"})[0] == 400
