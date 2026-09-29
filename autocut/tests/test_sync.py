import numpy as np
import pytest
from scipy.signal import resample_poly

from autocut.audio import Reference
from autocut.config import DEFAULTS
from autocut.sync import Syncer
from autocut.timecode import Rate, parse_rate

from synth import SCRIPT, SR, scratch, speech, timewarp

RATE = 8000


@pytest.fixture(scope="module")
def room():
    spk = speech(180.0, SCRIPT)
    return spk["A"] + spk["B"] + spk["C"]


@pytest.fixture(scope="module")
def syncer(room):
    ref = resample_poly(room, RATE, SR).astype(np.float32)
    cfg = dict(DEFAULTS["sync"], long_clip_minutes=1.5, probe_seconds=30)
    return Syncer(Reference(ref, RATE, None, "x"), cfg, Rate(parse_rate(25)))


class FakeInfo:
    def __init__(self, dur):
        self.duration, self.has_audio, self.av_offset, self.audio_channels = dur, True, 0.0, 1


def run(syncer, monkeypatch, cam_audio):
    from autocut import sync as mod
    monkeypatch.setattr(mod, "decode_mono", lambda info, rate: resample_poly(cam_audio, rate, SR).astype(np.float32))

    class C:
        rel = "CAM/X.MP4"
        info = FakeInfo(len(cam_audio) / SR)
    return syncer.sync_clip(C())


def test_offset_subframe(syncer, room, monkeypatch):
    r = run(syncer, monkeypatch, scratch(timewarp(room, 10.3137, 0.0, 60), seed=3))
    assert not r.low
    assert abs(r.offset - 10.3137) < 0.001
    assert r.confidence > 0.9


def test_negative_offset_camera_started_first(syncer, room, monkeypatch):
    r = run(syncer, monkeypatch, scratch(timewarp(room, -4.2, 0.0, 60), seed=4))
    assert not r.low
    assert abs(r.offset + 4.2) < 0.001


def test_drift_measured_and_corrected(syncer, room, monkeypatch):
    r = run(syncer, monkeypatch, scratch(timewarp(room, 2.0, 300e-6, 170), seed=5))
    assert not r.low, r.notes
    assert r.drift_measured == pytest.approx(300e-6, abs=20e-6)
    assert r.drift != 0.0
    # 300 ppm is ~6x a real camera; 5 ms = 1/8 frame at 25 fps
    assert abs(r.ref_time(0) - 2.0) < 0.005
    assert abs(r.ref_time(170) - (170 * 1.0003 + 2.0)) < 0.005


def test_small_drift_ignored(syncer, room, monkeypatch):
    r = run(syncer, monkeypatch, scratch(timewarp(room, 2.0, 20e-6, 170), seed=6))
    assert not r.low
    assert r.drift == 0.0
    assert any("below threshold" in n for n in r.notes)


def test_unrelated_audio_is_low_confidence(syncer, monkeypatch):
    rng = np.random.default_rng(7)
    other = speech(60.0, [(0, 60, "A")], seed=42)["A"] + 0.05 * rng.normal(0, 1, 60 * SR).astype(np.float32)
    r = run(syncer, monkeypatch, other)
    assert r.low
    assert r.notes


def test_pure_noise_gives_finite_low_result(syncer, monkeypatch):
    rng = np.random.default_rng(9)
    r = run(syncer, monkeypatch, (0.1 * rng.normal(0, 1, 30 * SR)).astype(np.float32))
    assert r.low
    assert np.isfinite(r.offset)
