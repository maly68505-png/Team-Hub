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


def quiet_at(dur, pauses):
    q = np.zeros(R.frames(dur), bool)
    for a, b in pauses:
        q[R.frames(a):R.frames(b)] = True
    return q


def test_presenter_on_several_cameras_changes_angle_at_pauses():
    # one presenter talking for 60 s, sentence pauses every ~5 s
    pauses = [(t, t + 0.5) for t in np.arange(5.0, 60.0, 5.3)]
    segs = [(0, 60, "S_P")]
    n = R.frames(60)
    cov = {c: np.ones(n, bool) for c in CAMS}
    ccfg = dict(DEFAULTS["cut"])
    shots = plan_cuts([Segment(*s) for s in segs], (0.0, 60.0), R, {"S_P": ["A", "B", "WIDE"]}, CAMS,
                      "WIDE", cov, ccfg, quiet_at(60, pauses))
    assert len(shots) >= 6
    assert all(x.camera != y.camera for x, y in zip(shots, shots[1:]))          # never the same angle twice
    for s in shots[:-1]:
        assert ccfg["rotate_min_shot"] * 25 <= s.length <= ccfg["rotate_max_shot"] * 25 + 1
    centres = {R.frames(a + 0.25) for a, _ in pauses}
    assert all(any(abs(s.end - c) <= 1 for c in centres) for s in shots[:-1])   # cuts sit in the pauses
    assert {s.camera for s in shots} == {"A", "B", "WIDE"}


def test_presenter_without_pauses_still_changes_angle():
    shots = plan_cuts([Segment(0, 40, "S_P")], (0.0, 40.0), R, {"S_P": ["A", "B"]}, CAMS, "WIDE",
                      {c: np.ones(R.frames(40), bool) for c in CAMS}, dict(DEFAULTS["cut"]))
    assert len(shots) >= 3 and all(x.camera != y.camera for x, y in zip(shots, shots[1:]))


def test_single_camera_list_is_just_that_camera():
    shots = cut([(0, 20, "S_A")], dur=20)
    assert [s.camera for s in shots] == ["A"]
    shots = plan_cuts([Segment(0, 20, "S_A")], (0.0, 20.0), R, {"S_A": ["B"]}, CAMS, "WIDE",
                      {c: np.ones(R.frames(20), bool) for c in CAMS}, dict(DEFAULTS["cut"]))
    assert [s.camera for s in shots] == ["B"]


def test_keep_ranges_shortens_long_pauses_only():
    from autocut.cutlogic import keep_ranges
    sound = np.zeros(R.frames(20), bool)
    for a, b in [(1, 5), (5.3, 9), (11, 15), (18, 19)]:       # pauses: 0.3 s, 2 s, 3 s
        sound[R.frames(a):R.frames(b)] = True
    keep = keep_ranges(sound, R, max_pause=0.6, pad=0.15)
    # leading silence trimmed to the pad, the 0.3 s pause kept whole, 2 s and 3 s pauses cut to 2 x 0.15 s
    assert keep[0][0] == R.frames(1) - R.frames(0.15)
    kept = sum(b - a for a, b in keep)
    # speech 4+3.7+4+1, the 0.3 s pause, 2 x 0.15 for each long pause, 0.15 at each end
    assert abs(kept - R.frames(4 + 3.7 + 4 + 1 + 0.3 + 0.3 + 0.3 + 0.15 + 0.15)) <= 2
    for a, b in keep:
        assert sound[a:b].sum() > 0                               # no all-silent piece left


def test_rotation_picks_cameras_that_are_rolling():
    n = R.frames(60)
    cov = {c: np.ones(n, bool) for c in CAMS}
    cov["A"][:R.frames(30)] = False          # A only rolls in the second half
    pauses = [(t, t + 0.5) for t in np.arange(5.0, 60.0, 5.3)]
    shots = plan_cuts([Segment(0, 60, "S_P")], (0.0, 60.0), R, {"S_P": ["A", "B", "WIDE"]}, CAMS, "WIDE",
                      cov, dict(DEFAULTS["cut"]), quiet_at(60, pauses))
    assert not any("no footage" in s.reason for s in shots)
    assert all(s.camera != "A" for s in shots if s.end <= R.frames(30))
    assert any(s.camera == "A" for s in shots if s.start >= R.frames(30))
    assert all(x.camera != y.camera for x, y in zip(shots, shots[1:]))
