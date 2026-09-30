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


ROT = "@rotate:"  # camera placeholder for a speaker shown on several cameras


def silence_frames(x: np.ndarray, sr: int, window: tuple[float, float], rate: Rate) -> np.ndarray:
    """Per sequence frame: True where the clean audio is quiet (25 dB under speech)."""
    t0, t1 = window
    n = rate.frames(t1 - t0)
    seg = np.asarray(x[int(t0 * sr):int(t1 * sr)], dtype=np.float64)
    if len(seg) == 0:
        return np.zeros(n, bool)
    e = np.concatenate([[0.0], np.cumsum(seg ** 2)])
    edges = np.minimum((np.arange(n + 1) * sr / rate.float).astype(int), len(seg))
    width = np.maximum(np.diff(edges), 1)
    level = 10 * np.log10((e[edges[1:]] - e[edges[:-1]]) / width + 1e-12)
    loud = level[level > -100]
    if not len(loud):
        return np.ones(n, bool)
    return level < float(np.percentile(loud, 90)) - 25.0


def _rotate(pieces: list[Shot], speaker_cam: dict, pauses: list[tuple[int, int]],
            rate: Rate, ccfg: dict, coverage: dict | None = None) -> list[Shot]:
    """Replace ROT placeholders: switch between the speaker's cameras at pauses,
    a shot every rotate_min..rotate_max seconds, longest pause first."""
    fmin = rate.frames(float(ccfg["rotate_min_shot"]))
    fmax = max(fmin + 1, rate.frames(float(ccfg["rotate_max_shot"])))
    centres = [((a + b) // 2, b - a) for a, b in pauses]
    out: list[Shot] = []
    i = 0
    while i < len(pieces):
        p = pieces[i]
        if not (isinstance(p.camera, str) and p.camera.startswith(ROT)):
            out.append(p)
            i += 1
            continue
        j = i
        while j + 1 < len(pieces) and pieces[j + 1].camera == p.camera:
            j += 1
        a, b = p.start, pieces[j].end
        cams = speaker_cam[p.camera[len(ROT):]]
        cuts, t = [], a
        while b - t > fmax:
            window = [(ln, c) for c, ln in centres if t + fmin <= c <= t + fmax]
            if window:
                c = max(window)[1]                      # longest pause = end of a sentence
            else:
                later = [c for c, _ in centres if t + fmax < c <= t + 2 * fmax]
                c = later[0] if later else t + fmax     # no pause at all: cut anyway
            if b - c < fmin:
                break
            cuts.append(c)
            t = c
        prev = out[-1].camera if out else None
        k = next((n for n, cam in enumerate(cams) if cam != prev), 0)
        bounds = [a] + cuts + [b]
        def rolling(cam, s0, s1):
            c = (coverage or {}).get(cam)
            return c is None or bool(c[s0:s1].all())

        for n, (s0, s1) in enumerate(zip(bounds, bounds[1:])):
            last = out[-1].camera if out else None
            order = [cams[(k + i) % len(cams)] for i in range(len(cams))]
            # next camera in turn that is rolling for the whole shot and is not the last angle
            cam = next((c for c in order if c != last and rolling(c, s0, s1)), None)
            if cam is None:
                cam = next((c for c in order if rolling(c, s0, s1)), None) or order[0]
            k = cams.index(cam) + 1
            out.append(Shot(s0, s1, cam, p.speaker, p.reason if n == 0 else "angle change (pause)"))
        i = j + 1
    return out


def plan_cuts(segs: list[Segment], window: tuple[float, float], rate: Rate,
              speaker_cam: dict, cameras: list[str], long_cam: str,
              coverage: dict[str, np.ndarray], ccfg: dict,
              quiet: np.ndarray | None = None) -> list[Shot]:
    """speaker_cam values: one camera, or a list of cameras to switch between at
    pauses (a single presenter shot from several angles). `quiet`: per-frame
    silence of the clean audio, used to find those pauses."""
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
                target = speaker_cam[spk]
                if isinstance(target, (list, tuple)):
                    cam = f"{ROT}{spk}" if len(target) > 1 else target[0]
                else:
                    cam = target
                reason = "speaker"
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

    if any(isinstance(p.camera, str) and p.camera.startswith(ROT) for p in pieces):
        silent = mask == 0
        if quiet is not None and len(quiet) == n:
            silent = silent | quiet
        pmin = rate.frames(float(ccfg["pause_min"]))
        pauses = [(a, b) for a, b in _runs(silent) if silent[a] and b - a >= max(1, pmin)]
        pieces = _rotate(pieces, speaker_cam, pauses, rate, ccfg, coverage)
        log.info("Angle changes for presenters on several cameras: %d pauses found",
                 len(pauses))

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


def speech_mask(segs: list[Segment], window: tuple[float, float], rate: Rate) -> np.ndarray:
    """Per sequence frame: True where diarization heard anyone (short turns included)."""
    t0, t1 = window
    n = rate.frames(t1 - t0)
    m = np.zeros(n, bool)
    for s in segs:
        a, b = max(0, rate.frames(s.start - t0)), min(n, rate.frames(s.end - t0))
        if b > a:
            m[a:b] = True
    return m


def keep_ranges(sound: np.ndarray, rate: Rate, max_pause: float, pad: float) -> list[tuple[int, int]]:
    """Frames to keep when removing silences: every quiet stretch longer than
    `max_pause` is cut down to `pad` seconds on each side of it (leading and
    trailing silence to `pad`)."""
    n = len(sound)
    lim = max(1, rate.frames(max_pause))
    p = max(0, rate.frames(pad))
    cuts = []
    for a, b in _runs(sound):
        if sound[a] or b - a <= lim:
            continue
        lo = 0 if a == 0 else a + p
        hi = n if b == n else b - p
        if hi > lo:
            cuts.append((lo, hi))
    keep, pos = [], 0
    for lo, hi in cuts:
        if lo > pos:
            keep.append((pos, lo))
        pos = hi
    if pos < n:
        keep.append((pos, n))
    return keep


REASON_GROUPS = [("angle change", "angle"), ("no footage on", "fallback"), ("NO FOOTAGE", "gap"),
                 ("unmapped", "unmapped"), ("overlap", "overlap"), ("hold", "hold"),
                 ("opening", "opening"), ("speaker", "speaker")]


def breakdown(shots: list[Shot], rate: Rate) -> dict:
    """Screen time per camera and per reason — the why of a rough cut."""
    total = sum(s.length for s in shots) or 1
    cams, reasons = Counter(), Counter()
    for s in shots:
        cams[s.camera or "(gap)"] += s.length
        key = next((g for k, g in REASON_GROUPS if k in s.reason), "other")
        reasons[key] += s.length
    return {"shots": len(shots),
            "cameras": {k: round(100 * v / total, 1) for k, v in cams.most_common()},
            "reasons": {k: round(100 * v / total, 1) for k, v in reasons.most_common()},
            "seconds": round(total / rate.float, 1)}


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
    why = breakdown(shots, rate)["reasons"]
    log.info("Why: %s", ", ".join(f"{k} {v:.0f}%" for k, v in why.items()))


def _mmss(sec: float) -> str:
    return f"{int(sec // 60)}:{int(sec % 60):02d}"
