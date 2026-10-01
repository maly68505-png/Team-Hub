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
    assert any("video files" in line for line in j["lines"])


def test_unknown_job_rejected(srv):
    base, _ = srv
    assert call(base, "/api/run", {"kind": "rm -rf"})[0] == 400


def test_token_is_stable_across_restarts(tmp_path, monkeypatch):
    monkeypatch.setenv("AUTOCUT_HOME", str(tmp_path / "h"))
    a = server._token()
    assert a == server._token() and len(a) >= 24
    assert oct((tmp_path / "h" / "token").stat().st_mode)[-3:] == "600"


def test_absolute_audio_folder_saved_relative(srv, project):
    base, _ = srv
    audio = project.parent / "2_AUDIO"
    audio.mkdir()
    code, st = call(base, "/api/project?path=" + str(project))
    cfg = st["config"]
    cfg["audio_folder"] = str(audio)
    assert call(base, "/api/config", {"path": str(project), "config": cfg})[0] == 200
    assert load(project / "config.yaml")["audio_folder"] == "../2_AUDIO"


def test_stale_long_camera_is_replaced_and_flagged(srv, project):
    """A config saved by an older version named a folder that is not a camera."""
    base, _ = srv
    (project / "config.yaml").write_text("long_camera: 3_Proxy\n")
    code, st = call(base, "/api/project?path=" + str(project))
    assert st["long_camera_reset"] == "3_Proxy"
    assert st["config"]["long_camera"] in st["cameras"]


def test_reset_settings_deletes_config_only(srv, project):
    base, _ = srv
    (project / "config.yaml").write_text("long_camera: CAM_A\n")
    (project / "_autocut").mkdir()
    (project / "_autocut" / "sync.json").write_text("{}")
    assert call(base, "/api/config/reset", {"path": str(project)})[0] == 200
    assert not (project / "config.yaml").exists()
    assert (project / "_autocut" / "sync.json").exists()  # analysis kept


SEQ_XML = """<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4"><sequence id="s1"><name>Ep 3 synced</name><duration>250</duration>
<rate><timebase>25</timebase><ntsc>FALSE</ntsc></rate><media><video>
<track><clipitem id="c1"><name>A</name><start>0</start><end>250</end><in>0</in><out>250</out>
 <file id="f1"><name>A001.MXF</name><pathurl>file://localhost/x/CAM%201/A001.MXF</pathurl>
 <media><video/><audio/></media></file></clipitem></track>
<track><clipitem id="c2"><name>B</name><start>50</start><end>200</end><in>0</in><out>150</out>
 <file id="f2"><name>B001.MXF</name><pathurl>file://localhost/x/CAM%202/B001.MXF</pathurl>
 <media><video/><audio/></media></file></clipitem></track>
</video><audio><track><clipitem id="c3"><name>T1</name><start>0</start><end>250</end><in>0</in><out>250</out>
 <file id="f3"><name>T1.WAV</name><pathurl>file://localhost/x/audio/T1.WAV</pathurl><media><audio/></media></file>
</clipitem></track></audio></media></sequence></xmeml>
"""


def test_synced_xml_as_project(srv, tmp_path):
    base, _ = srv
    x = tmp_path / "Ep3.xml"
    x.write_text(SEQ_XML)
    code, st = call(base, "/api/project?path=" + urllib.request.quote(str(x)))
    assert code == 200 and st["mode"] == "xml"
    assert st["cameras"] == ["CAM 1", "CAM 2"]
    assert st["config"]["long_camera"] == "CAM 1" and st["long_camera_guessed"]
    assert st["xml"]["audio"] == ["T1.WAV"] and st["xml"]["audio_clean"]
    assert st["xml_missing"]                       # the media is not on this machine
    cfg = st["config"]
    cfg["speakers"] = {"SPEAKER_00": ["CAM 1", "CAM 2"]}
    assert call(base, "/api/config", {"path": str(x), "config": cfg})[0] == 200
    f = tmp_path / "_autocut" / "xml-Ep3" / "config.yaml"
    assert load(f)["speakers"]["SPEAKER_00"] == ["CAM 1", "CAM 2"]
    assert not (tmp_path / "config.yaml").exists()
    code, st = call(base, "/api/project?path=" + urllib.request.quote(str(x)))
    assert st["has_config"] and not st.get("long_camera_guessed")
    assert call(base, "/api/config/reset", {"path": str(x)})[0] == 200
    assert not f.exists()
