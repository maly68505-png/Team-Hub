"""Window matching (camera samples against the clean audio) on synthetic signals."""
import numpy as np
import pytest
from scipy.signal import resample_poly

from autocut.config import DEFAULTS
from autocut.takes import Take, _Bank, _Prepared, _solve, edges_from_points, window_points, window_starts

from synth import SCRIPT, SR, scratch, speech, timewarp

RATE, CRATE = 8000, 1000
SCFG = dict(DEFAULTS["sync"])


@pytest.fixture(scope="module")
def room():
    spk = speech(180.0, SCRIPT)
    return spk["A"] + spk["B"] + spk["C"]


@pytest.fixture(scope="module")
def bank(room):
    prep = [_Prepared(resample_poly(room, RATE, SR).astype(np.float32), RATE, CRATE)]
    return _Bank(prep, CRATE), prep


def place(bank, cam_audio, every=120.0):
    """Sample the camera like place_takes does, then solve. -> (offset, drift, edges)"""
    b, prep = bank
    x = resample_poly(cam_audio, RATE, SR).astype(np.float32)
    dur = len(x) / RATE
    starts = window_starts(dur, 8.0, every)
    wins = [(s, x[int(s * RATE):int((s + 8.0) * RATE)]) for s in starts]
    edges = edges_from_points(window_points(b, prep, wins, RATE, CRATE, SCFG), SCFG)
    if not edges:
        return None, None, edges
    T, C, kept, _ = _solve([Take("ref", [], 180.0)], [object()], {(ti, 0): e for ti, e in edges.items()},
                           1 / 25)
    return C[0][0], C[0][1], edges


def test_window_starts_spread_over_the_clip():
    s = window_starts(3600.0, 8.0, 90.0)
    assert len(s) == 40 and s[0] >= 1.0 and s[-1] <= 3600 - 9.0
    assert window_starts(5.0, 8.0, 90.0) == [0.0]
    assert len(window_starts(60.0, 8.0, 90.0)) == 6     # short clips still get 6 samples


def test_offset_subframe(bank, room):
    off, drift, _ = place(bank, scratch(timewarp(room, 10.3137, 0.0, 60), seed=3))
    assert abs(off - 10.3137) < 0.001 and drift == 0.0


def test_negative_offset_camera_started_first(bank, room):
    off, _, _ = place(bank, scratch(timewarp(room, -4.2, 0.0, 60), seed=4))
    assert abs(off + 4.2) < 0.001


def test_drift_measured(bank, room):
    off, drift, _ = place(bank, scratch(timewarp(room, 2.0, 300e-6, 170), seed=5), every=40.0)
    assert drift == pytest.approx(300e-6, abs=30e-6)
    assert abs(off - 2.0) < 0.005


def test_unrelated_audio_matches_nothing(bank):
    rng = np.random.default_rng(7)
    other = speech(60.0, [(0, 60, "A")], seed=42)["A"] + 0.05 * rng.normal(0, 1, 60 * SR).astype(np.float32)
    off, _, edges = place(bank, other)
    assert off is None and not edges


def test_pure_noise_matches_nothing(bank):
    rng = np.random.default_rng(9)
    off, _, edges = place(bank, (0.1 * rng.normal(0, 1, 30 * SR)).astype(np.float32))
    assert off is None and not edges
