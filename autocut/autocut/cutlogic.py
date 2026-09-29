"""Step 5 — turn diarization into a list of shots on V1.

Everything happens on the sequence frame grid, so every cut is frame-snapped.

  1. drop speech turns shorter than `min_segment` (backchannels)
  2. per frame: one speaker -> that speaker's camera
                2+ speakers for longer than `overlap_min` -> long camera
                silence, or a shorter overlap -> hold the previous camera
  3. camera has no footage at that moment -> long camera -> any camera -> gap
  4. shots shorter than `min_shot` are absorbed by a neighbour (the previous
     shot is preferred: the cut is delayed rather than advanced)
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Callable

import numpy as np

from .diarize import Segment
from .log import log
from .timecode import Rate


@dataclass
class Shot:
    start: int          # sequence frame, inclusive
    end: int            # sequence frame, exclusive
    camera: str | None  # None = no camera has footage here (gap)
    speaker: str
    reason: str

    @property
    def length(self) -> int:
        return self.end - self.start


def _runs(values: np.ndarray):
    """(start, end) of runs of equal values."""
    if len(values) == 0:
        return []
    change = np.flatnonzero(values[1:] != values[:-1]) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [len(values)]])
    return list(zip(starts.tolist(), ends.tolist()))


def plan_cuts(segs: list[Segment], window: tuple[float, float], rate: Rate,
              speaker_cam: dict[str, str], cameras: list[str], long_cam: str,
              coverage: dict[str, np.ndarray], ccfg: dict) -> list[Shot]:
    t0, t1 = window
    n = rate.frames(t1 - t0)
    fps = rate.float
    min_seg = float(ccfg["min_segment"])
    lead = float(ccfg["cut_lead"])
    opening = long_cam if ccfg["opening_camera"] in (None, "long") else ccfg["opening_camera"]

    kept = [s for s in segs if s.duration >= min_seg and s.end > t0 and s.start < t1]
    dropped = sum(1 for s in segs if s.duration < min_seg and s.end > t0 and s.start < t1)
    log.info("Speech turns in window: %d kept, %d shorter than %.2fs ignored (backchannels)",
             len(kept), dropped, min_seg)
    speakers = sorted({s.speaker for s in kept})
    if len(speakers) > 62:
        raise ValueError("too many speaker labels")
    mask = np.zeros(n, np.int64)
    for s in kept:
        a = max(0, rate.frames(s.start - t0))
        b = min(n, rate.frames(s.end - t0))
        if b > a:
            mask[a:b] |= 1 << speakers.index(s.speaker)

    def names(m: int) -> list[str]:
        return [spk for i, spk in enumerate(speakers) if m >> i & 1]

    # --- desired camera per run -----------------------------------------
    pieces: list[Shot] = []
    prev_cam = None
    prev_spk = ""
    n_overlaps = 0
    for a, b in _runs(mask):
        m = int(mask[a])
        who = names(m)
        if len(who) == 1:
            spk = who[0]
            if spk in speaker_cam:
                cam, reason = speaker_cam[spk], "speaker"
            else:
                cam, reason = long_cam, "unmapped speaker -> long"
        elif len(who) >= 2 and (b - a) / fps > float(ccfg["overlap_min"]):
            cam, reason, spk = long_cam, "overlap", "+".join(who)
            n_overlaps += 1
        else:
            spk = "+".join(who) if who else prev_spk
            if prev_cam is None:
                cam, reason = opening, "opening"
            else:
                cam = prev_cam
                reason = "hold (short overlap)" if who else "hold (silence)"
        pieces.append(Shot(a, b, cam, spk, reason))
        prev_cam, prev_spk = cam, spk if reason in ("speaker", "overlap") else prev_spk
    log.info("Overlaps longer than %.2fs (-> long camera): %d", float(ccfg["overlap_min"]), n_overlaps)

    # --- footage availability ----------------------------------------------
    fallback_order = [long_cam] + [c for c in cameras if c != long_cam]
    avail: list[Shot] = []
    for p in pieces:
        cov = coverage.get(p.camera)
        if cov is not None and cov[p.start:p.end].all():
            avail.append(p)
            continue
        chosen = np.full(p.length, -1, np.int64)
        for ci, cam in reversed(list(enumerate([p.camera] + fallback_order))):
            c = coverage.get(cam)
            if c is not None:
                chosen[c[p.start:p.end]] = ci
        options = [p.camera] + fallback_order
        for a, b in _runs(chosen):
            ci = int(chosen[a])
            if ci == 0:
                avail.append(Shot(p.start + a, p.start + b, p.camera, p.speaker, p.reason))
            elif ci < 0:
                avail.append(Shot(p.start + a, p.start + b, None, p.speaker, "NO FOOTAGE (gap)"))
            else:
                avail.append(Shot(p.start + a, p.start + b, options[ci], p.speaker,
                                  f"no footage on {p.camera} -> {options[ci]}"))

    shots = _coalesce(avail)

    # --- cut lead: move each cut onto a new speaker slightly earlier ---------
    lead_frames = rate.frames(lead)
    if lead_frames > 0:
        for prev, cur in zip(shots, shots[1:]):
            if cur.reason not in ("speaker", "overlap") or cur.camera is None:
                continue
            shift = min(lead_frames, prev.length - 1)
            cov = coverage.get(cur.camera)
            if shift > 0 and cov is not None and cov[cur.start - shift:cur.start].all():
                prev.end -= shift
                cur.start -= shift

    # --- minimum shot length ------------------------------------------------
    min_frames = rate.frames(float(ccfg["min_shot"]))

    def covered(cam, a, b):
        c = coverage.get(cam)
        return c is not None and bool(c[a:b].all())

    shots = enforce_min_shot(shots, min_frames, covered)
    return shots


def _coalesce(shots: list[Shot]) -> list[Shot]:
    out: list[Shot] = []
    for s in shots:
        if out and out[-1].camera == s.camera and out[-1].end == s.start:
            out[-1].end = s.end
        else:
            out.append(Shot(s.start, s.end, s.camera, s.speaker, s.reason))
    return out


def enforce_min_shot(shots: list[Shot], min_frames: int,
                     covered: Callable[[str, int, int], bool]) -> list[Shot]:
    shots = _coalesce(shots)
    stuck: set[int] = set()
    while True:
        cands = [(s.length, i) for i, s in enumerate(shots)
                 if s.length < min_frames and s.camera is not None and id(s) not in stuck]
        if not cands:
            break
        _, i = min(cands)
        s = shots[i]
        prev = shots[i - 1] if i > 0 else None
        nxt = shots[i + 1] if i + 1 < len(shots) else None

        def ok(o):
            return o is not None and o.camera is not None and covered(o.camera, s.start, s.end)

        if ok(prev) and nxt is not None and prev.camera == nxt.camera:
            prev.end = nxt.end
            del shots[i:i + 2]
        elif ok(prev):
            prev.end = s.end
            del shots[i]
        elif ok(nxt):
            nxt.start = s.start
            del shots[i]
        else:
            stuck.add(id(s))
            log.warning("shot at frame %d (%s, %d frames) is shorter than the minimum but no "
                        "neighbouring camera has footage there — kept", s.start, s.camera, s.length)
    return _coalesce(shots)


def summarize(shots: list[Shot], rate: Rate) -> None:
    if not shots:
        log.warning("no shots")
        return
    lens = [s.length / rate.float for s in shots]
    log.info("Rough cut: %d shots, average %.1fs, shortest %.1fs, longest %.1fs",
             len(shots), float(np.mean(lens)), min(lens), max(lens))
    screen = Counter()
    for s in shots:
        screen[s.camera or "(gap)"] += s.length
    total = sum(screen.values())
    for cam, fr in screen.most_common():
        log.info("  %-14s %5.1f%%  %s", cam, 100 * fr / total, _mmss(fr / rate.float))
    gaps = [s for s in shots if s.camera is None]
    if gaps:
        log.warning("%d gap(s) where no camera has footage", len(gaps))


def _mmss(sec: float) -> str:
    return f"{int(sec // 60)}:{int(sec % 60):02d}"
