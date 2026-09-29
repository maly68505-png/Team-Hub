import numpy as np

from autocut.config import DEFAULTS
from autocut.cutlogic import plan_cuts
from autocut.diarize import Segment
from autocut.timecode import Rate, parse_rate

R = Rate(parse_rate(25))
CAMS = ["WIDE", "A", "B"]
MAP = {"S_A": "A", "S_B": "B"}


def cut(segs, dur=60.0, coverage=None, **over):
    n = R.frames(dur)
    cov = coverage or {c: np.ones(n, bool) for c in CAMS}
    ccfg = dict(DEFAULTS["cut"], **over)
    return plan_cuts([Segment(*s) for s in segs], (0.0, dur), R, MAP, CAMS, "WIDE", cov, ccfg)


def cams(shots):
    return [(s.camera, s.start, s.end) for s in shots]


def test_single_speakers_and_opening_wide():
    shots = cut([(2, 10, "S_A"), (10, 20, "S_B")], dur=20)
    assert cams(shots) == [("WIDE", 0, 50), ("A", 50, 250), ("B", 250, 500)]
    assert shots[0].reason == "opening"


def test_long_overlap_goes_to_wide_short_overlap_does_not():
    shots = cut([(0, 10, "S_A"), (8, 20, "S_B")], dur=20)       # 2 s overlap
    assert cams(shots) == [("A", 0, 200), ("WIDE", 200, 250), ("B", 250, 500)]
    assert shots[1].reason == "overlap" and shots[1].speaker == "S_A+S_B"
    shots = cut([(0, 10, "S_A"), (9.6, 20, "S_B")], dur=20)     # 0.4 s overlap
    assert cams(shots) == [("A", 0, 250), ("B", 250, 500)]


def test_backchannel_ignored():
    shots = cut([(0, 10, "S_A"), (5, 5.5, "S_B"), (10.2, 10.8, "S_B"), (11, 20, "S_A")], dur=20)
    assert [s.camera for s in shots] == ["A"]


def test_silence_holds_previous_camera():
    shots = cut([(0, 5, "S_A"), (5, 10, "S_B"), (15, 20, "S_A")], dur=20)
    assert cams(shots) == [("A", 0, 125), ("B", 125, 375), ("A", 375, 500)]


def test_min_shot_length_enforced():
    shots = cut([(0, 10, "S_A"), (10, 11.5, "S_B"), (11.5, 20, "S_A")], dur=20)
    assert [s.camera for s in shots] == ["A"]
    shots = cut([(0, 10, "S_A"), (10, 11.5, "S_B"), (11.5, 20, "S_A")], dur=20, min_shot=1.0)
    assert [s.camera for s in shots] == ["A", "B", "A"]
    shots = cut([(0, 5, "S_A"), (5, 6.2, "S_B"), (6.2, 20, "S_A"), (20, 21, "S_B"), (21, 40, "S_B")], dur=40)
    assert all(s.length >= 50 for s in shots)


def test_cuts_snap_to_frames():
    shots = cut([(0, 10.013, "S_A"), (10.013, 20, "S_B")], dur=20)
    assert shots[1].start == 250  # 10.013 s * 25 = 250.3 -> 250
    assert all(isinstance(s.start, int) for s in shots)


def test_missing_footage_falls_back_to_wide_then_gap():
    n = R.frames(20)
    cov = {c: np.ones(n, bool) for c in CAMS}
    cov["A"][:250] = False
    shots = cut([(0, 20, "S_A")], dur=20, coverage=cov)
    assert cams(shots) == [("WIDE", 0, 250), ("A", 250, 500)]
    assert "no footage on A" in shots[0].reason
    cov = {c: np.zeros(n, bool) for c in CAMS}
    shots = cut([(0, 20, "S_A")], dur=20, coverage=cov)
    assert [s.camera for s in shots] == [None]


def test_unmapped_speaker_goes_wide():
    shots = cut([(0, 10, "S_A"), (10, 20, "S_Z")], dur=20)
    assert [s.camera for s in shots] == ["A", "WIDE"]
    assert "unmapped" in shots[1].reason


def test_cut_lead():
    shots = cut([(0, 10, "S_A"), (10, 20, "S_B")], dur=20, cut_lead=0.2)
    assert shots[1].start == 245
