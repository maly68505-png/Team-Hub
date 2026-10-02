"""Frame rates, seconds <-> frames, SMPTE timecode strings (non drop-frame)."""
from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction


@dataclass(frozen=True)
class Rate:
    fps: Fraction

    @property
    def timebase(self) -> int:
        return int(round(float(self.fps)))

    @property
    def ntsc(self) -> bool:
        return abs(float(self.fps) - self.timebase) > 1e-3

    @property
    def float(self) -> float:
        return float(self.fps)

    def frames(self, seconds: float) -> int:
        """Nearest frame boundary — every cut goes through here."""
        return int(round(seconds * float(self.fps)))

    def seconds(self, frames: int) -> float:
        return frames / float(self.fps)

    def __str__(self) -> str:
        f = float(self.fps)
        return f"{f:g}" if not self.ntsc else f"{f:.3f}"


def parse_rate(value) -> Fraction | None:
    """'25/1', '30000/1001', '25', 25 -> Fraction. None/'0/0' -> None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        if abs(f - 29.97) < 0.01:
            return Fraction(30000, 1001)
        if abs(f - 23.976) < 0.01:
            return Fraction(24000, 1001)
        if abs(f - 59.94) < 0.01:
            return Fraction(60000, 1001)
        return Fraction(f).limit_denominator(1001)
    s = str(value).strip()
    if "/" in s:
        num, den = s.split("/", 1)
        if float(den) == 0:
            return None
        fr = Fraction(int(num), int(den))
        return fr if fr > 0 else None
    return parse_rate(float(s))


def frames_to_tc(frames: int, rate: Rate) -> str:
    tb = rate.timebase
    sign = "-" if frames < 0 else ""
    frames = abs(int(frames))
    ff = frames % tb
    total_s = frames // tb
    return f"{sign}{total_s // 3600:02d}:{total_s // 60 % 60:02d}:{total_s % 60:02d}:{ff:02d}"


def tc_to_frames(tc: str, rate: Rate) -> int:
    parts = tc.replace(";", ":").replace(".", ":").split(":")
    if len(parts) != 4:
        raise ValueError(f"bad timecode '{tc}'")
    hh, mm, ss, ff = (int(p) for p in parts)
    return ((hh * 60 + mm) * 60 + ss) * rate.timebase + ff


def tc_seconds(tc: str, fps) -> float | None:
    """Timecode label -> seconds since midnight (None if unreadable).
    Drop-frame (';' at 29.97/59.94) counts real time; non-drop counts labels."""
    try:
        drop = ";" in tc
        parts = [int(p) for p in tc.replace(";", ":").replace(".", ":").split(":")]
        if len(parts) != 4:
            return None
        hh, mm, ss, ff = parts
        nominal = int(round(float(fps)))
        if nominal <= 0:
            return None
        if drop and nominal in (30, 60):
            d = 2 * nominal // 30
            total_min = hh * 60 + mm
            frames = ((hh * 3600 + mm * 60 + ss) * nominal + ff) - d * (total_min - total_min // 10)
            return frames / float(fps)
        return (hh * 3600 + mm * 60 + ss) + ff / nominal
    except (ValueError, TypeError, ZeroDivisionError):
        return None


def parse_time(value, rate: Rate | None = None) -> float:
    """'01:02:03', '02:03', '123.5', 'HH:MM:SS:FF' (needs rate) -> seconds."""
    if value is None:
        raise ValueError("no time given")
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    parts = s.split(":")
    if len(parts) == 4:
        if rate is None:
            raise ValueError("HH:MM:SS:FF needs a frame rate")
        return tc_to_frames(s, rate) / rate.timebase
    secs = 0.0
    for p in parts:
        secs = secs * 60 + float(p)
    if math.isnan(secs) or secs < 0:
        raise ValueError(f"bad time '{value}'")
    return secs


def fmt_seconds(seconds: float) -> str:
    sign = "-" if seconds < 0 else ""
    s = abs(seconds)
    return f"{sign}{int(s // 3600):02d}:{int(s // 60 % 60):02d}:{s % 60:06.3f}"
