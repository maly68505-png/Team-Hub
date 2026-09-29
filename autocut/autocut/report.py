"""cuts.csv"""
from __future__ import annotations

import csv
from pathlib import Path

from .cutlogic import Shot
from .timecode import Rate, frames_to_tc
from .timeline import Timeline


def write_cuts_csv(path: Path, shots: list[Shot], tl: Timeline, rate: Rate) -> None:
    base = rate.frames(tl.t0)
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:  # BOM: opens cleanly in Excel
        w = csv.writer(fh)
        w.writerow(["timecode", "camera", "speaker", "reason", "timecode_out", "duration_s",
                    "start_frame", "end_frame", "clip", "source_in"])
        for s in shots:
            pieces = tl.pieces(s.camera, s.start, s.end) if s.camera else []
            w.writerow([frames_to_tc(base + s.start, rate), s.camera or "(gap)", s.speaker, s.reason,
                        frames_to_tc(base + s.end, rate), f"{s.length / rate.float:.2f}",
                        s.start, s.end,
                        pieces[0].clip.rel if pieces else "",
                        frames_to_tc(pieces[0].src_in, rate) if pieces else ""])
