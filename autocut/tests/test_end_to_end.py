"""Full pipeline on a synthetic 4-camera project (needs ffmpeg).

The strongest check: for every clip in the XML, decode the camera audio at the
XML's in-point and cross-correlate it with the clean audio at that timeline
position — the residual lag must be under half a frame.
"""
import csv
import shutil
import subprocess
import xml.etree.ElementTree as ET
from urllib.parse import unquote

import numpy as np
import pytest
from scipy.io import wavfile
from scipy.signal import fftconvolve

from autocut.pipeline import EXIT_LOW_SYNC, EXIT_NEED_MAPPING, EXIT_OK, run

import synth

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
FPS = 25


@pytest.fixture(scope="module")
def project(tmp_path_factory):
    root = synth.make_project(tmp_path_factory.mktemp("proj"))
    return root


def mapped(root):
    cfg = (root / "config.yaml").read_text()
    if "SPEAKER_A" not in cfg:
        cfg = cfg.replace("speakers:\n", "speakers:\n  SPEAKER_A: CAM_A\n  SPEAKER_B: CAM_B\n"
                                        "  SPEAKER_C: CAM_C\n")
        (root / "config.yaml").write_text(cfg)


_DECODED = {}


def decode(path, start_s, dur_s, sr=8000):
    """Independent decoder (ffmpeg CLI). Whole file, no seeking: how a seek
    lands on AAC differs between ffmpeg builds, whole-file decoding does not."""
    if path not in _DECODED:
        out = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", str(sr),
                              "-f", "f32le", "-"], capture_output=True, check=True).stdout
        _DECODED[path] = np.frombuffer(out, np.float32)
    a = int(max(0.0, start_s) * sr)
    return _DECODED[path][a:a + int(dur_s * sr)]


def lag_ms(a, b, sr=8000, max_lag=0.2):
    """Lag of b relative to a in ms (positive: b is late)."""
    corr = fftconvolve(b, a[::-1], mode="full")
    mid = len(a) - 1
    m = int(max_lag * sr)
    win = corr[mid - m:mid + m + 1]
    return (int(np.argmax(win)) - m) / sr * 1000


def xml_tracks(path):
    root = ET.parse(path).getroot()
    seq = root.find("sequence")
    vt = seq.findall("media/video/track")
    at = seq.findall("media/audio/track")
    return seq, vt, at


def test_first_run_stops_for_mapping(project):
    code = run(project, rttm=project / "truth.rttm")
    assert code == EXIT_NEED_MAPPING
    assert (project / "_autocut" / "speakers.json").exists()
    assert len(list((project / "_autocut" / "speaker_samples").glob("*.wav"))) == 9


def test_full_run_xml_and_csv(project):
    mapped(project)
    assert run(project, rttm=project / "truth.rttm") == EXIT_OK
    out = project / "_autocut" / "output"
    seq, vt, at = xml_tracks(out / "roughcut.xml")
    assert seq.find("rate/timebase").text == "25"
    assert len(vt) == 1 + 4                   # V1 + one per camera
    assert len(at) == 2                       # two mono clean tracks
    n = int(seq.find("duration").text)
    assert n == 180 * FPS

    v1 = vt[0].findall("clipitem")
    starts = [int(c.find("start").text) for c in v1]
    ends = [int(c.find("end").text) for c in v1]
    assert starts[0] == 0 and ends[-1] == n
    assert all(e == s for e, s in zip(ends, starts[1:])), "V1 must have no holes"
    for c in v1:
        assert c.find("enabled").text == "TRUE"
        assert int(c.find("out").text) - int(c.find("in").text) == int(c.find("end").text) - int(c.find("start").text)
        assert int(c.find("in").text) >= 0
    for tr in vt[1:]:
        assert tr.find("enabled").text == "FALSE" and tr.find("locked").text == "TRUE"
        assert all(c.find("enabled").text == "FALSE" for c in tr.findall("clipitem"))

    with open(out / "cuts.csv", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    assert list(rows[0])[:4] == ["timecode", "camera", "speaker", "reason"]
    reasons = {r["reason"] for r in rows}
    assert "overlap" in reasons and "speaker" in reasons
    # the 4 s overlap at 45-49 s goes to the wide camera
    assert any(r["camera"] == "CAM_WIDE" and r["reason"] == "overlap" and r["timecode"] == "00:00:45:00"
               for r in rows)
    assert all(float(r["duration_s"]) >= 2.0 for r in rows)


def _file_paths(root_el):
    paths = {}
    for f in root_el.iter("file"):
        if f.find("pathurl") is not None:
            paths[f.get("id")] = unquote(f.find("pathurl").text.replace("file://localhost", ""))
    return paths


def test_every_placed_clip_is_in_sync(project):
    mapped(project)
    xml = project / "_autocut" / "output" / "roughcut.xml"
    if not xml.exists():
        assert run(project, rttm=project / "truth.rttm") == EXIT_OK
    root = ET.parse(xml).getroot()
    paths = _file_paths(root)
    sr, ref = wavfile.read(project / "_autocut" / "reference_16k.wav")
    from scipy.signal import resample_poly
    ref = resample_poly(ref.astype(np.float32) / 32768, 1, 2)
    truth = {name: (off, drift) for clips in synth.CAMERAS.values() for name, off, drift, _, _ in clips}
    checked = 0
    for track in root.find("sequence/media/video").findall("track"):
        for c in track.findall("clipitem"):
            start, end = int(c.find("start").text), int(c.find("end").text)
            src_in = int(c.find("in").text)
            path = paths[c.find("file").get("id")]
            # probe the end of the clipitem: that is where drift would show
            for at in (start, max(start, end - 3 * FPS)):
                t_ref = at / FPS
                cam = decode(path, (src_in + at - start) / FPS, 2.0)
                a = ref[int(t_ref * 8000):int((t_ref + 2.0) * 8000)]
                if len(cam) < 8000 or len(a) < 8000 or np.std(a) < 1e-3:
                    continue
                m = min(len(a), len(cam))
                lag = lag_ms(a[:m], cam[:m])
                # what frame snapping must leave: the camera shows source time s at
                # reference time t; the ground truth says s really belongs at ref_true(s)
                off, drift = truth[path.rsplit("/", 1)[1]]
                s = (src_in + at - start) / FPS
                expected = -((s * (1 + drift) + off) - t_ref) * 1000
                # half a frame from snapping, plus 1/4 frame between drift re-slips, plus 3 ms
                budget = 1000 / FPS * (0.75 if drift else 0.5) + 3
                assert abs(expected) <= budget, f"{path} @{at}: not frame-accurate ({expected:.1f} ms)"
                assert abs(lag - expected) < 3, f"{path} @{at}: {lag:.1f} ms, expected {expected:.1f} ms"
                checked += 1
    assert checked > 20


def test_test_segment(project):
    mapped(project)
    assert run(project, rttm=project / "truth.rttm", start="0:40", duration="60") == EXIT_OK
    xml = project / "_autocut" / "output" / "roughcut_000040_60s.xml"
    seq, vt, at = xml_tracks(xml)
    assert int(seq.find("duration").text) == 60 * FPS
    assert seq.find("timecode/string").text == "00:00:40:00"
    audio_in = int(at[0].find("clipitem/in").text)
    assert audio_in == 40 * FPS


def test_low_confidence_stops_and_is_excluded(project, tmp_path):
    root = tmp_path / "p"
    shutil.copytree(project, root, ignore=shutil.ignore_patterns("_autocut"))
    rng = np.random.default_rng(99)
    synth.write_video(root / "CAM_X" / "NOISE.MP4", (0.1 * rng.normal(0, 1, 30 * synth.SR)).astype(np.float32))
    mapped(root)
    assert run(root, rttm=root / "truth.rttm") == EXIT_LOW_SYNC
    assert run(root, rttm=root / "truth.rttm", allow_low_confidence=True) == EXIT_OK
    seq, vt, _ = xml_tracks(root / "_autocut" / "output" / "roughcut.xml")
    v1_names = [c.find("name").text for c in vt[0].findall("clipitem")]
    assert not any("CAM_X" in n for n in v1_names)
    all_names = [c.find("name").text for tr in vt[1:] for c in tr.findall("clipitem")]
    assert any(n.startswith("LOW-SYNC CAM_X") for n in all_names)

    # a manual override makes it a normal clip again
    cfg = (root / "config.yaml").read_text().replace(
        "sync:\n", "sync:\n  overrides:\n    CAM_X/NOISE.MP4: 20.0\n")
    (root / "config.yaml").write_text(cfg)
    assert run(root, rttm=root / "truth.rttm") == EXIT_OK


def test_layered_timeline(project, tmp_path):
    """output.layered: one track per camera, cut in place; at every frame the
    enabled clip is the camera cuts.csv chose, and camera audio stays in sync."""
    root = tmp_path / "p"
    shutil.copytree(project, root, ignore=shutil.ignore_patterns("_autocut"))
    mapped(root)
    cfg = (root / "config.yaml").read_text()
    (root / "config.yaml").write_text(cfg.replace("layered: false", "layered: true"))
    assert run(root, rttm=root / "truth.rttm") == EXIT_OK
    out = root / "_autocut" / "output"
    seq, vt, _ = xml_tracks(out / "roughcut_layers.xml")
    assert "layers" in seq.find("name").text
    assert len(vt) == 4                              # the cameras, no separate V1
    n = int(seq.find("duration").text)
    shown = np.full(n, "", dtype=object)
    for tr in vt:
        assert tr.find("enabled").text == "TRUE" and tr.find("locked").text == "FALSE"
        items = tr.findall("clipitem")
        for a, b in zip(items, items[1:]):
            assert int(a.find("end").text) <= int(b.find("start").text)
        for c in items:
            s, e = int(c.find("start").text), int(c.find("end").text)
            assert int(c.find("out").text) - int(c.find("in").text) == e - s
            if c.find("enabled").text == "TRUE":
                assert not any(shown[s:e]), "two cameras enabled at once"
                shown[s:e] = c.find("name").text.split(" |")[0]
    with open(out / "cuts_layers.csv", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    for r in rows:
        s, e = int(r["start_frame"]), int(r["end_frame"])
        want = "" if r["camera"] == "(gap)" else r["camera"]
        assert set(shown[s:e]) == {want}, r
    # every camera frame shows the same source frame as in the normal layout
    (root / "config.yaml").write_text(cfg)
    assert run(root, rttm=root / "truth.rttm") == EXIT_OK
    _, vt_normal, _ = xml_tracks(out / "roughcut.xml")

    def src_at(tracks):
        m = {}
        for tr in tracks:
            for c in tr.findall("clipitem"):
                s, e, src = int(c.find("start").text), int(c.find("end").text), int(c.find("in").text)
                name = c.find("name").text.replace("LOW-SYNC ", "")
                for f in range(s, e):
                    m[(name, f)] = src + f - s
        return m
    a, b = src_at(vt), src_at(vt_normal[1:])
    assert a == b
