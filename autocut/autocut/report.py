"""cuts.csv"""
from __future__ import annotations

import csv
from pathlib import Path

from .cutlogic import Shot
from .timecode import Rate, frames_to_tc
from .timeline import TimeMap, Timeline


def write_cuts_csv(path: Path, shots: list[Shot], tl: Timeline, rate: Rate,
                   tm: TimeMap | None = None) -> None:
    """One row per shot as it lands in the sequence. With silence removal the
    timecodes are those of the tightened sequence; `recording_timecode` is where
    the shot is in the recording."""
    tm = tm or TimeMap(tl.n)
    base = rate.frames(tl.t0)
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:  # BOM: opens cleanly in Excel
        w = csv.writer(fh)
        w.writerow(["timecode", "camera", "speaker", "reason", "timecode_out", "duration_s",
                    "start_frame", "end_frame", "clip", "source_in", "recording_timecode"])
        for s in shots:
            parts = tm.split(s.start, s.end)
            if not parts:
                continue  # entirely inside a removed silence
            a, b = parts[0][0], parts[-1][1]
            pieces = tl.pieces(s.camera, s.start, s.end) if s.camera else []
            w.writerow([frames_to_tc(base + a, rate), s.camera or "(gap)", s.speaker, s.reason,
                        frames_to_tc(base + b, rate), f"{sum(e - x for x, e, _ in parts) / rate.float:.2f}",
                        a, b,
                        pieces[0].clip.rel if pieces else "",
                        frames_to_tc(pieces[0].src_in, rate) if pieces else "",
                        frames_to_tc(base + s.start, rate)])
