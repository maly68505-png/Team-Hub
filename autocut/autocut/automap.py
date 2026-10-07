"""Suggest each speaker's camera from the pictures (a guess the editor reviews).

A close-up camera moves more while its person talks: lips, head, hands. For
moments where ONE speaker talks alone, a few seconds of each camera are decoded
at a tiny size (read by seeking — a few % of the files) and the frame-to-frame
change is measured. Per camera the change is normalised (median / spread over
all moments), then averaged per speaker; the best one-to-one pairing of
speakers and cameras wins (Hungarian). The wide camera is left out: it shows
everyone. Weak pairings are not suggested.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import av
import numpy as np
from scipy.optimize import linear_sum_assignment

from .diarize import Segment
from .log import log

WIN = 3.0             # seconds of video per moment
PER_SPEAKER = 10      # moments per speaker
MIN_SOLO = 3.5        # a moment needs this much solo speech
MIN_SCORE = 0.35      # weaker pairings are not suggested
SIZE = (96, 54)


def solo_moments(segs: list[Segment], per_speaker: int = PER_SPEAKER) -> list[tuple[float, str]]:
    """(start time, speaker) of moments where one speaker talks alone, spread over the recording."""
    from .diarize import _solo_segments
    out = []
    for spk in sorted({s.speaker for s in segs}):
        # every WIN-second slice of solo speech (a little inside each turn), then spread
        starts = [t for s in _solo_segments(segs, spk) if s.duration >= MIN_SOLO
                  for t in np.arange(s.start + 0.25, s.end - WIN - 0.25 + 1e-6, WIN + 0.5)]
        if not starts:
            continue
        idx = np.unique(np.linspace(0, len(starts) - 1, min(per_speaker, len(starts))).round().astype(int))
        out += [(float(starts[i]), spk) for i in idx]
    return sorted(out)


def motion(path: Path, start: float, length: float = WIN) -> float | None:
    """Mean frame-to-frame change of a tiny grey picture over [start, start+length) (video time)."""
    try:
        with av.open(str(path)) as c:
            st = c.streams.video[0]
            st.thread_type = "AUTO"
            tb = st.time_base
            t0 = float(st.start_time * tb) if st.start_time is not None else 0.0
            c.seek(int((t0 + max(0.0, start)) / tb), stream=st, backward=True)
            prev, diffs = None, []
            for fr in c.decode(st):
                if fr.pts is None:
                    continue
                t = float(fr.pts * tb) - t0
                if t < start:
                    continue
                if t >= start + length:
                    break
                g = fr.reformat(width=SIZE[0], height=SIZE[1], format="gray").to_ndarray().astype(np.float32)
                if prev is not None:
                    diffs.append(float(np.mean(np.abs(g - prev))))
                prev = g
            return float(np.mean(diffs)) if len(diffs) >= 5 else None
    except (av.error.FFmpegError, IndexError):
        return None


def suggest(project, syncs: dict, segs: list[Segment], workdir: Path) -> dict[str, str]:
    """{speaker: camera} suggestions (cached in <work>/automap.json)."""
    cams = [c for c in project.cameras if c != project.long_camera]
    moments = solo_moments(segs)
    if not cams or not moments:
        return {}
    key = hashlib.sha1(json.dumps([moments, cams, sorted(
        (k, round(r.offset, 3), r.low) for k, r in syncs.items())]).encode()).hexdigest()[:16]
    cache = workdir / "automap.json"
    try:
        data = json.loads(cache.read_text())
        if data.get("key") == key:
            return data["suggested"]
    except (OSError, ValueError, KeyError):
        pass
    log.info("Suggesting cameras: %d solo moments x %d camera(s) ...", len(moments), len(cams))
    speakers = sorted({s for _, s in moments})
    m = np.full((len(cams), len(moments)), np.nan)
    for ci, cam in enumerate(cams):
        for k, (t, _) in enumerate(moments):
            for clip in project.cameras[cam].clips:
                r = syncs.get(clip.rel)
                if r is None or r.low or r.method in ("failed", "parked"):
                    continue
                if r.ref_start <= t and t + WIN <= r.ref_end:
                    m[ci, k] = motion(clip.path, r.video_time(t)) or np.nan
                    break
        log.info("  [%d/%d] %s: %d moment(s) read", ci + 1, len(cams), cam, int(np.isfinite(m[ci]).sum()))
    score = np.full((len(speakers), len(cams)), -np.inf)
    for ci in range(len(cams)):
        row = m[ci]
        ok = np.isfinite(row)
        if ok.sum() < 6:
            continue
        med = float(np.median(row[ok]))
        spread = float(np.median(np.abs(row[ok] - med))) * 1.4826 or 1e-6
        z = (row - med) / spread
        for si, spk in enumerate(speakers):
            sel = [k for k, (_, s) in enumerate(moments) if s == spk and np.isfinite(z[k])]
            if len(sel) >= 3:
                score[si, ci] = float(np.mean(z[sel]))
    out: dict[str, str] = {}
    cost = np.where(np.isfinite(score), -score, 1e6)
    for si, ci in zip(*linear_sum_assignment(cost)):
        if np.isfinite(score[si, ci]) and score[si, ci] >= MIN_SCORE:
            out[speakers[si]] = cams[ci]
    for si, spk in enumerate(speakers):
        row = ", ".join(f"{cams[ci]} {score[si, ci]:+.2f}" for ci in range(len(cams)) if np.isfinite(score[si, ci]))
        log.info("  %-12s -> %-10s (%s)", spk, out.get(spk, "no suggestion"), row)
    cache.write_text(json.dumps({"key": key, "suggested": out,
                                 "scores": {spk: {cams[ci]: (None if not np.isfinite(score[si, ci]) else round(float(score[si, ci]), 3))
                                                  for ci in range(len(cams))} for si, spk in enumerate(speakers)}}))
    return out
