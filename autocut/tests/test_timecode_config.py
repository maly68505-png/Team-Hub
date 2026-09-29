from fractions import Fraction

import pytest

from autocut.config import ConfigError, load
from autocut.timecode import Rate, frames_to_tc, parse_rate, parse_time, tc_to_frames

R25 = Rate(parse_rate("25/1"))


def test_rates():
    assert parse_rate("30000/1001") == Fraction(30000, 1001)
    assert parse_rate(29.97) == Fraction(30000, 1001)
    assert parse_rate("0/0") is None
    r = Rate(parse_rate(29.97))
    assert r.timebase == 30 and r.ntsc
    assert not R25.ntsc


def test_timecode_roundtrip():
    assert frames_to_tc(90000, R25) == "01:00:00:00"
    assert tc_to_frames("10:00:08:12", R25) == (36008 * 25) + 12
    assert frames_to_tc(tc_to_frames("00:59:59:24", R25), R25) == "00:59:59:24"


def test_parse_time():
    assert parse_time("5:00") == 300
    assert parse_time("01:02:03") == 3723
    assert parse_time("90.5") == 90.5
    assert parse_time("00:00:10:12", R25) == pytest.approx(10.48)


def test_config_defaults_and_errors(tmp_path):
    p = tmp_path / "config.yaml"
    p.write_text("long_camera: W\nspeakers:\n  SPEAKER_00: A\ncut:\n  min_shot: 3\n")
    cfg = load(p)
    assert cfg["cut"]["min_shot"] == 3 and cfg["cut"]["overlap_min"] == 0.5
    assert cfg["speakers"] == {"SPEAKER_00": "A"}
    p.write_text("long_camera: W\ncut:\n  min_shoot: 3\n")
    with pytest.raises(ConfigError, match="min_shoot"):
        load(p)
    p.write_text("fps: 25\n")
    with pytest.raises(ConfigError, match="long_camera"):
        load(p)


def test_example_config_loads():
    from pathlib import Path
    cfg = load(Path(__file__).parent.parent / "config.example.yaml")
    assert cfg["long_camera"] == "CAM_WIDE"
