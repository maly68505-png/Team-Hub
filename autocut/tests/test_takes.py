"""Clean audio as separate takes (TAKE1..TAKE3.wav) with cameras rolling across
them — the layout of a real single-presenter shoot."""
import shutil
import xml.etree.ElementTree as ET

import numpy as np
import pytest

from autocut.config import DEFAULTS
from autocut.pipeline import EXIT_OK, run
from autocut.scan import scan
from autocut.takes import group_takes, place_takes

import synth

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")

DUR = 240.0
TAKES = [("Juzoor.TAKE1.260922", 5.0, 70.0), ("Juzoor.TAKE2.260922", 80.0, 150.0),
         ("Juzoor.TAKE3.260922", 160.0, 230.0)]
# camera -> [(file, room time at the clip's first frame, drift, length)]
CAMS = {
    "CAM 01": [("C0001.MP4", -3.0, 0.0, 240.0)],                      # wide, rolls through everything
    "CAM 02": [("C0001.MP4", 2.0, 0.0, 98.0), ("C0002.MP4", 105.0, 0.0, 125.0)],
    "CAM 03": [("C0001.MP4", 60.0, 150e-6, 160.0)],                   # drifting clock
    "CAM 04": [("C0001.MP4", 150.0, 0.0, 85.0)],
}


def presenter_turns(seed=3):
    rng = np.random.default_rng(seed)
    t, turns = 1.0, []
    while t < DUR - 2:
        d = rng.uniform(3.0, 9.0)
        turns.append((t, min(t + d, DUR - 1), "A"))
        t += d + rng.uniform(0.4, 1.2)   # sentence pauses
    return turns


@pytest.fixture(scope="module")
def shoot(tmp_path_factory):
    top = tmp_path_factory.mktemp("juzoor") / "0000"
    turns = presenter_turns()
    room = synth.speech(DUR, turns)["A"]
    rng = np.random.default_rng(5)
    for name, a, b in TAKES:
        take = room[int(a * synth.SR):int(b * synth.SR)] + rng.normal(0, 0.003, int((b - a) * synth.SR))
        synth.write_wav(top / "2_AUDIO" / "2_Fixed_Audio" / f"{name}.wav", take.astype(np.float32) * 0.8)
    for i, (cam, clips) in enumerate(CAMS.items()):
        for j, (f, off, drift, length) in enumerate(clips):
            a = synth.scratch(synth.timewarp(room, off, drift, length), seed=20 + 10 * i + j)
            synth.write_video(top / "3_Proxy" / cam / f, a)
    # ground-truth diarization in REFERENCE time (take 1 starts at 0 there)
    base = TAKES[0][1]
    with open(top / "truth.rttm", "w") as fh:
        for s, e, _ in turns:
            for _, a, b in TAKES:
                s2, e2 = max(s, a), min(e, b)
                if e2 - s2 > 0.2:
                    fh.write(f"SPEAKER ref 1 {s2 - base:.3f} {e2 - s2:.3f} <NA> <NA> SPEAKER_00 <NA> <NA>\n")
    (top / "config.yaml").write_text("fps: 25\nlong_camera: CAM 01\nspeakers:\n"
                                     "sync:\n  long_clip_minutes: 2\n  probe_seconds: 30\n")
    return top


def cfg():
    c = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULTS.items()}
    c["long_camera"] = "CAM 01"
    return c


def test_takes_are_detected():
    class F:
        def __init__(self, n, d, parent="x"):
            from pathlib import Path
            self.path, self.duration = Path(parent) / n, d
    yes, no = (lambda a, b: True), (lambda a, b: False)
    tracks = [F("TR1.wav", 600.0), F("TR2.wav", 600.2)]
    assert len(group_takes(tracks, similar=yes)) == 1          # same room, same moment
    assert len(group_takes(tracks, similar=no)) == 2           # same length, different recordings
    same_len = [F("Juzoor.TAKE2.wav", 70.0), F("Juzoor.TAKE3.wav", 70.0)]
    assert len(group_takes(same_len, similar=yes)) == 2        # take numbers decide
    assert len(group_takes([F("A.wav", 65.0), F("B.wav", 90.0)], similar=yes)) == 2
    assert len(group_takes(tracks, "tracks", similar=no)) == 1


def test_takes_placed_at_their_real_times(shoot):
    project = scan(shoot, cfg())
    takes = group_takes(project.audio)
    assert [t.name for t in takes] == [n for n, _, _ in TAKES]
    res = place_takes(project, takes, cfg())
    base = TAKES[0][1]
    for t, (_, a, _) in zip(takes, TAKES):
        assert t.position == pytest.approx(a - base, abs=0.003), t.name
        assert t.linked
    for cam, clips in CAMS.items():
        for f, off, drift, length in clips:
            r = res[f"{cam}/{f}"]
            assert not r.low, (cam, f, r.notes)
            assert r.ref_time(0) == pytest.approx(off - base, abs=0.005), (cam, f)
            assert r.ref_time(length - 5) == pytest.approx((length - 5) * (1 + drift) + off - base, abs=0.01)


def test_full_run_places_takes_and_audio(shoot):
    cfgtxt = (shoot / "config.yaml").read_text().replace(
        "speakers:\n", "speakers:\n  SPEAKER_00: [CAM 02, CAM 03, CAM 04]\n")
    (shoot / "config.yaml").write_text(cfgtxt)
    assert run(shoot, rttm=shoot / "truth.rttm") == EXIT_OK
    root = ET.parse(shoot / "_autocut" / "output" / "roughcut.xml").getroot()
    seq = root.find("sequence")
    atracks = seq.findall("media/audio/track")
    items = [c for tr in atracks for c in tr.findall("clipitem")]
    assert len(items) == 3                               # three takes, one mono track
    starts = sorted(int(c.find("start").text) for c in items)
    base = TAKES[0][1]
    assert starts == [round((a - base) * 25) for _, a, _ in TAKES]
    assert seq.find("media/audio/outputs/group/numchannels").text == "2"

    # presenter on three cameras: V1 changes angle, never the same twice in a row
    v1 = seq.findall("media/video/track")[0].findall("clipitem")
    cams = [c.find("name").text.split(" | ")[0] for c in v1]
    assert {"CAM 02", "CAM 03", "CAM 04"} <= set(cams)
    shots = [cams[0]] + [c for p, c in zip(cams, cams[1:]) if c != p]
    assert len(shots) >= 12

    # every V1 clip is in sync with the take at that point of the timeline
    from scipy.io import wavfile
    from scipy.signal import resample_poly
    from test_end_to_end import _file_paths, decode, lag_ms
    paths = _file_paths(root)
    sr, ref = wavfile.read(shoot / "_autocut" / "reference_16k.wav")
    ref = resample_poly(ref.astype(np.float32) / 32768, 1, 2)
    checked = 0
    for c in v1:
        start, src_in = int(c.find("start").text), int(c.find("in").text)
        cam = decode(paths[c.find("file").get("id")], src_in / 25, 2.0)
        a = ref[int(start / 25 * 8000):int((start / 25 + 2.0) * 8000)]
        if len(cam) < 8000 or len(a) < 8000 or np.std(a) < 1e-3:
            continue
        m = min(len(a), len(cam))
        assert abs(lag_ms(a[:m], cam[:m])) <= 1000 / 25 * 0.75 + 3, c.find("name").text
        checked += 1
    assert checked >= 10
