"""Placing camera clips (and clean-audio takes) on one timeline.

The clean audio may be one recording (tracks that started together) or
separate TAKES recorded one after another, with cameras rolling across them.

  1. each camera file is sampled: `window_seconds` of audio every
     `sample_every` seconds, read by seeking (MXF interleaves audio with
     video, so this reads a few % of the file instead of all of it);
  2. every window is searched across all takes at once (1 kHz normalized
     cross-correlation), then refined at 8 kHz -> points
         take t at take-time tau  ==  clip c at video-time v
  3. one least-squares solve places everything:
         T_t + tau = C_c + v * (1 + d_c)
     (T take start, C clip start, d clip drift — only when a clip's points
     span >= 2 min); inconsistent matches are dropped and it re-solves;
  4. take groups no camera links are laid out in name order, with a warning.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.fft import next_fast_len
from scipy.signal import fftconvolve, resample_poly

from .audio import DIARIZE_RATE, Reference, decode_mono, decode_windows, fingerprint
from .log import log
from .probe import MediaInfo
from .scan import Project, ScanError
from .sync import SyncResult, Measurement, _parabolic, bandpass, ncc
from .timecode import fmt_seconds

TAKES_VERSION = 5
GROUP_GAP_S = 5.0     # silence between take groups no camera connects
MIN_WINDOWS = 6       # even a short clip is sampled at least this many times
DRIFT_SPAN_S = 120.0  # measurements must span this much of a clip to estimate its drift


@dataclass
class Take:
    name: str
    files: list[MediaInfo]
    duration: float
    position: float = 0.0            # start on the reference timeline (s)
    linked: bool = True              # placed by camera matches (False: laid out in order)
    notes: list[str] = field(default_factory=list)


TAKE_NO = re.compile(r"(?:take|tk|t)[\s._-]*0*(\d+)", re.IGNORECASE)


def _take_no(name: str) -> str | None:
    m = TAKE_NO.search(name)
    return m.group(1) if m else None


def same_recording(a: MediaInfo, b: MediaInfo, seconds: float = 30.0) -> bool:
    """Two files are tracks of ONE take if they hear the same room at the same
    moment: normalized correlation near lag 0 over the first seconds."""
    rate = 2000
    xa, xb = decode_mono(a, rate)[: int(seconds * rate)], decode_mono(b, rate)[: int(seconds * rate)]
    n = min(len(xa), len(xb))
    if n < rate * 2:
        return True
    xa, xb = xa[:n] - xa[:n].mean(), xb[:n] - xb[:n].mean()
    lag = int(0.05 * rate)
    c = fftconvolve(np.concatenate([np.zeros(lag), xb, np.zeros(lag)]), xa[::-1], mode="valid")
    den = float(np.linalg.norm(xa) * np.linalg.norm(xb)) or 1.0
    return float(np.max(np.abs(c))) / den > 0.2


def group_takes(audio: list[MediaInfo], mode: str = "auto", similar=None) -> list[Take]:
    """Simultaneous tracks form one take; separate recordings are separate takes,
    in filename order. `similar(a, b)` confirms that two same-length files are
    tracks of one take (default: same_recording)."""
    if not audio:
        return []
    similar = similar or same_recording
    durs = [a.duration for a in audio]
    if mode == "tracks" or len(audio) == 1:
        return [Take("clean audio", list(audio), max(durs))]
    takes: list[Take] = []
    for a in audio:
        last = takes[-1] if takes else None
        first = last.files[0] if last else None
        same = (last is not None and abs(first.duration - a.duration) <= 1.0
                and first.path.parent == a.path.parent)
        if same:
            na, nb = _take_no(first.path.stem), _take_no(a.path.stem)
            if na and nb and na != nb:
                same = False           # TAKE1 / TAKE2: different takes whatever their length
            elif mode == "auto" or mode == "takes":
                same = similar(first, a)
        if same:
            last.files.append(a)       # another track of the same take
            last.duration = max(last.duration, a.duration)
        else:
            takes.append(Take(a.path.stem, [a], a.duration))
    if mode == "auto" and len(takes) == 1:
        takes[0].name = "clean audio"
    return takes


def _mix(take: Take, rate: int, channel: int | None = None) -> np.ndarray:
    x = np.zeros(0, np.float32)
    for f in take.files:
        y = decode_mono(f, rate, channel)
        if len(y) > len(x):
            x = np.concatenate([x, np.zeros(len(y) - len(x), np.float32)])
        x[:len(y)] += y
    return x


class _Prepared:
    def __init__(self, x8: np.ndarray, rate: int, crate: int):
        self.f = bandpass(x8, rate, 100, 3000)
        self.c = bandpass(resample_poly(x8, crate, rate).astype(np.float32), crate, 80, 450)
        self.dur = len(x8) / rate


class _Bank:
    """All takes end to end (1 s of silence between) at 1 kHz: one coarse search
    finds both WHICH take a camera window belongs to and WHERE in it."""

    def __init__(self, prep: list[_Prepared], crate: int):
        gap = np.zeros(crate, np.float32)
        parts, self.offsets, self.lens = [gap], [], []
        pos = crate
        for p in prep:
            self.offsets.append(pos)
            self.lens.append(len(p.c))
            parts += [p.c, gap]
            pos += len(p.c) + crate
        self.c = np.concatenate(parts).astype(np.float64)
        e = np.concatenate([[0.0], np.cumsum(self.c ** 2)])
        self._e = e
        self._cache: dict[int, tuple] = {}

    def search(self, probe: np.ndarray) -> np.ndarray:
        """Normalized cross-correlation; out[k] compares probe with c[k:k+m]."""
        m = len(probe)
        if m not in self._cache:
            nfft = next_fast_len(len(self.c) + m)
            energy = self._e[m:] - self._e[:-m]
            den = np.sqrt(np.maximum(energy, 0) + 1e-3 * float(np.mean(energy)) + 1e-12)
            self._cache[m] = (nfft, np.fft.rfft(self.c, nfft), den)
        nfft, fr, den = self._cache[m]
        p = probe.astype(np.float64) - float(np.mean(probe))
        pn = float(np.linalg.norm(p)) + 1e-12
        corr = np.fft.irfft(fr * np.conj(np.fft.rfft(p, nfft)), nfft)[:len(self.c) - m + 1]
        return corr / (pn * den)

    def locate(self, k: int, m: int):
        for ti, (off, n) in enumerate(zip(self.offsets, self.lens)):
            if off <= k and k + m <= off + n:
                return ti, (k - off)
        return None


def _line(taus, offs, tol: float, rounds: int = 3):
    """Robust straight-line fit offs ~ a + b*tau; returns (a, b, kept mask)."""
    taus, offs = np.asarray(taus, float), np.asarray(offs, float)
    keep = np.ones(len(taus), bool)
    a, b = float(np.median(offs)), 0.0
    for _ in range(rounds):
        if keep.sum() >= 2 and np.ptp(taus[keep]) > 1.0:
            b, a = np.polyfit(taus[keep], offs[keep], 1)
        else:
            a, b = float(np.median(offs[keep])), 0.0
        keep = np.abs(offs - (a + b * taus)) < tol
        if not keep.any():
            break
    return float(a), float(b), keep


def window_starts(dur: float, win: float, every: float, shift: float = 0.0) -> list[float]:
    """Where to read sample windows in a clip of `dur` seconds (audio time)."""
    if dur <= win + 2.0:
        return [0.0]
    n = max(MIN_WINDOWS, int(np.ceil(dur / every)))
    lo, hi = 1.0, dur - win - 1.0
    starts = np.linspace(lo, hi, n)
    if shift:
        step = (hi - lo) / max(1, n - 1)
        starts = np.clip(starts + shift * step, lo, hi)
    return [float(x) for x in starts]


def window_points(bank: _Bank, prep_t: list[_Prepared], windows, rate: int, crate: int, scfg: dict):
    """Camera sample windows [(audio_start, x8k)] -> match points
    [(take, tau_centre, v_centre, ncc, ratio)] — tau in the take, v in the clip's audio."""
    pts = []
    margin = int(0.25 * rate)
    for v0, x in windows:
        if len(x) < 2 * rate or float(np.std(x)) < 1e-5:
            continue
        f = bandpass(x, rate, 100, 3000)
        c = bandpass(resample_poly(x, crate, rate).astype(np.float32), crate, 80, 450)
        n = bank.search(c)
        k = int(np.argmax(n))
        peak = float(n[k])
        rest = np.concatenate([n[:max(0, k - crate)], n[k + crate + 1:]])
        second = float(np.max(rest)) if len(rest) else 0.0
        ratio = peak / max(second, 1e-6) if peak > 0 else 0.0
        if ratio < 1.4:
            continue
        loc = bank.locate(k, len(c))
        if loc is None:
            continue
        ti, kk = loc
        tk = prep_t[ti].f
        s0 = int(round(kk / crate * rate)) - margin
        seg = np.zeros(len(f) + 2 * margin, np.float32)
        a, b = max(0, s0), min(len(tk), s0 + len(seg))
        if b <= a:
            continue
        seg[a - s0:b - s0] = tk[a:b]
        nf = ncc(seg, f)
        j = int(np.argmax(nf))
        if float(nf[j]) < float(scfg["min_ncc"]):
            continue
        tau = (s0 + j + _parabolic(nf, j)) / rate
        w = len(x) / rate
        pts.append((ti, tau + w / 2, v0 + w / 2, float(nf[j]), ratio))
    return pts


def edges_from_points(pts, scfg: dict) -> dict:
    """Group a clip's points by take; keep the consistent ones."""
    by: dict[int, list] = {}
    for ti, tau, v, w, ratio in pts:
        by.setdefault(ti, []).append((tau, v, w, ratio))
    good_ratio = float(scfg["good_peak_ratio"])
    edges = {}
    for ti, ps in by.items():
        _, _, keep = _line([p[0] for p in ps], [p[1] - p[0] for p in ps], tol=0.010)
        ps = [p for p, k in zip(ps, keep) if k]
        if not ps:
            continue
        ratio = float(np.median([p[3] for p in ps]))
        if len(ps) < 2 and ratio < 2.5:   # one lone window must stand out clearly
            continue
        conf = float(np.clip((ratio - 1.0) / max(good_ratio - 1.0, 1e-6), 0, 1))
        edges[ti] = {"points": [(tau, v, w) for tau, v, w, _ in ps], "ratio": ratio, "confidence": conf}
    return edges


def _solve(takes: list[Take], clips: list, edges: dict, frame_s: float):
    """Least squares on edges {(ti, ci): {"points": [(tau, v_video, ncc)] ...}}.
    Returns (T per take or None, (C, d) per clip or None, edges kept)."""
    edges = dict(edges)
    for _ in range(20):
        # connected components over takes+clips
        adj: dict = {}
        for (ti, ci) in edges:
            adj.setdefault(("t", ti), set()).add(("c", ci))
            adj.setdefault(("c", ci), set()).add(("t", ti))
        comps, seen = [], set()
        for ti in range(len(takes)):
            node = ("t", ti)
            if node in seen:
                continue
            stack, comp = [node], []
            while stack:
                x = stack.pop()
                if x in seen:
                    continue
                seen.add(x)
                comp.append(x)
                stack += list(adj.get(x, ()))
            comps.append(comp)
        T = [None] * len(takes)
        C = [None] * len(clips)
        worst, worst_res = None, 0.0
        for comp in comps:
            ts = sorted(i for k, i in comp if k == "t")
            cs = sorted(i for k, i in comp if k == "c")
            root = ts[0]
            tvar = {ti: j for j, ti in enumerate(t for t in ts if t != root)}
            nt = len(tvar)
            # drift only where a clip's measurements span >= DRIFT_SPAN_S of its time:
            # a slope from a short span is noise, and hurts over an hour-long clip
            spread = {ci: [] for ci in cs}
            for (ti, ci), e in edges.items():
                if ci in spread:
                    spread[ci] += [v for _, v, _ in e["points"]]
            drifty = {ci for ci, vs in spread.items() if vs and max(vs) - min(vs) >= DRIFT_SPAN_S}
            cvar, dvar, nvar = {}, {}, nt
            for ci in cs:
                cvar[ci] = nvar
                nvar += 1
                if ci in drifty:
                    dvar[ci] = nvar
                    nvar += 1
            if not cs:
                T[root] = 0.0
                continue
            rows, rhs = [], []
            for (ti, ci), e in edges.items():
                if ci not in cvar:
                    continue
                for tau, v, w in e["points"]:
                    r = np.zeros(nvar)
                    if ti != root:
                        r[tvar[ti]] = 1.0
                    r[cvar[ci]] = -1.0
                    if ci in dvar:
                        r[dvar[ci]] = -v / 1000.0     # drift, in ms per s
                    rows.append(r * w)
                    rhs.append((v - tau) * w)
            for ci in dvar:  # tiny regularisation only
                r = np.zeros(nvar)
                r[dvar[ci]] = 1e-3
                rows.append(r)
                rhs.append(0.0)
            sol, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
            T[root] = 0.0
            for ti, j in tvar.items():
                T[ti] = float(sol[j])
            for ci, j in cvar.items():
                C[ci] = (float(sol[j]), float(sol[dvar[ci]]) / 1000.0 if ci in dvar else 0.0)
            for (ti, ci), e in edges.items():
                if ci not in cvar:
                    continue
                c0, d = C[ci]
                res = float(np.median([abs(T[ti] + tau - (c0 + v * (1 + d))) for tau, v, _ in e["points"]]))
                if res > worst_res:
                    worst, worst_res = (ti, ci), res
        if worst is None or worst_res <= 2 * frame_s:
            return T, C, edges, comps
        log.info("  dropping inconsistent match %s <-> clip #%d (%.0f ms off)",
                 takes[worst[0]].name, worst[1], worst_res * 1000)
        del edges[worst]
    return T, C, edges, comps


def place_takes(project: Project, takes: list[Take], cfg: dict) -> dict[str, SyncResult]:
    """Match, solve, and write positions into `takes`; SyncResult per clip."""
    scfg = cfg["sync"]
    rate, crate = int(scfg["analysis_rate"]), int(scfg["coarse_rate"])
    clips = [c for c in project.all_clips()]
    key = hashlib.sha1(json.dumps({
        "v": TAKES_VERSION, "audio": fingerprint([f.path for t in takes for f in t.files]),
        "clips": fingerprint([c.path for c in clips]), "groups": [[f.path.name for f in t.files] for t in takes],
        "cfg": {k: v for k, v in scfg.items() if k not in ("overrides", "method")},
        "channel": cfg.get("audio_channel")}, sort_keys=True).encode()).hexdigest()[:16]
    cache_p = project.workdir / "takes.json"
    frame_s = 1.0 / project.rate.float
    if cache_p.exists():
        data = json.loads(cache_p.read_text())
        if data.get("key") == key:
            log.info("Take placement: cached")
            for t, d in zip(takes, data["takes"]):
                t.position, t.linked, t.notes = d["position"], d["linked"], d["notes"]
            return _apply_overrides({r["rel"]: SyncResult.from_dict(r) for r in data["clips"]}, clips, scfg)

    if len(takes) > 1:
        log.info("Clean audio is %d separate takes — placing them on one timeline from the cameras", len(takes))
    prep_t = []
    for t in takes:
        log.info("  take %-28s %s", t.name, fmt_seconds(t.duration))
        prep_t.append(_Prepared(_mix(t, rate, cfg.get("audio_channel")), rate, crate))
    bank = _Bank(prep_t, crate)
    win = float(scfg["window_seconds"])
    every = float(scfg["sample_every"])
    todo = [(ci, c) for ci, c in enumerate(clips) if c.info.has_audio]
    total_s = sum(c.info.duration for _, c in todo)
    log.info("Reading %.0fs of audio every %.0fs from %d camera files (%s of footage) ...",
             win, every, len(todo), fmt_seconds(total_s))

    def read(clip, shift=0.0):
        starts = window_starts(clip.info.duration, win, every, shift)
        length = min(win, clip.info.duration)
        return starts, decode_windows(clip.info, rate, starts, length)

    edges: dict = {}
    started = time.time()
    with ThreadPoolExecutor(max_workers=3) as pool:   # network drives: keep a few reads in flight
        futures = {ci: pool.submit(read, c) for ci, c in todo}
        for n, (ci, clip) in enumerate(todo, 1):
            starts, xs = futures[ci].result()
            pts = window_points(bank, prep_t, list(zip(starts, xs)), rate, crate, scfg)
            if not pts:  # nothing heard in those spots: try the spots in between
                starts2, xs2 = read(clip, 0.5)
                pts = window_points(bank, prep_t, list(zip(starts2, xs2)), rate, crate, scfg)
            found = []
            for ti, e in edges_from_points(pts, scfg).items():
                e["points"] = [(tau, v + clip.info.av_offset, w) for tau, v, w in e["points"]]
                edges[(ti, ci)] = e
                found.append(takes[ti].name)
            log.info("  [%d/%d] %-34s %2d samples -> %s", n, len(todo), clip.rel, len(starts),
                     ", ".join(found) or "NO match")
    log.info("Camera audio read in %.0fs", time.time() - started)

    T, C, edges, comps = _solve(takes, clips, edges, frame_s)

    # lay the connected groups out in take order
    order = sorted(comps, key=lambda comp: min(i for k, i in comp if k == "t"))
    cursor = 0.0
    shift_t: dict[int, float] = {}
    for gi, comp in enumerate(order):
        ts = [i for k, i in comp if k == "t"]
        cs = [i for k, i in comp if k == "c"]
        start = min(T[i] for i in ts)
        shift = cursor - start
        for i in ts:
            shift_t[i] = shift
            takes[i].position = T[i] + shift
            takes[i].linked = bool(cs)
        for i in cs:
            c0, d = C[i]
            C[i] = (c0 + shift, d)
        end = max(T[i] + shift + takes[i].duration for i in ts)
        if len(order) > 1:
            names = ", ".join(takes[i].name for i in sorted(ts))
            msg = (f"takes {names}: no camera links them to the other takes — placed in "
                   f"filename order, the gap to the previous take is a guess")
            if gi > 0:
                log.warning(msg)
                for i in ts:
                    takes[i].notes.append(msg)
        cursor = end + GROUP_GAP_S

    results: dict[str, SyncResult] = {}
    for ci, clip in enumerate(clips):
        r = SyncResult(clip.rel, clip.info.duration)
        if C[ci] is None:
            r.method = "failed" if not clip.info.has_audio else "audio"
            r.notes.append("no audio stream" if not clip.info.has_audio else
                           "matches no take of the clean audio")
        else:
            c0, d = C[ci]
            mine = {k: e for k, e in edges.items() if k[1] == ci}
            vs = [v for e in mine.values() for _, v, _ in e["points"]]
            spread = (max(vs) - min(vs)) if vs else 0.0
            r.offset = c0
            r.confidence = max(e["confidence"] for e in mine.values())
            r.low = r.confidence < float(scfg["min_confidence"])
            if spread >= DRIFT_SPAN_S:
                r.drift_measured = d
                total = abs(d) * clip.info.duration
                if abs(d) * 1e6 > float(scfg["max_drift_ppm"]):
                    r.low = True
                    r.notes.append(f"implausible drift {d * 1e6:.0f} ppm")
                elif total > float(scfg["drift_correct_frames"]) * frame_s:
                    r.drift = d
                    r.notes.append(f"drift {d * 1e6:+.1f} ppm = {total * 1000:.0f} ms over the clip — CORRECTED")
            if not r.drift:
                # re-fit the offset without drift
                r.offset = float(np.median([takes[ti].position + tau - v for (ti, _), e in mine.items()
                                            for tau, v, _ in e["points"]]))
            r.notes.append("matched " + ", ".join(takes[ti].name for ti, _ in sorted(mine)))
            r.measurements = [Measurement(at=v, offset=takes[ti].position + tau - v, ncc=round(w, 4),
                                          peak_ratio=round(e["ratio"], 3), confidence=round(e["confidence"], 3),
                                          good=True)
                              for (ti, _), e in sorted(mine.items()) for tau, v, w in e["points"][:3]]
        results[clip.rel] = r

    for t in takes:
        log.info("  take %-28s at %s%s", t.name, fmt_seconds(t.position), "" if t.linked else "  (not linked)")
    cache_p.parent.mkdir(parents=True, exist_ok=True)
    cache_p.write_text(json.dumps({
        "key": key,
        "takes": [{"name": t.name, "position": t.position, "linked": t.linked, "notes": t.notes} for t in takes],
        "clips": [r.to_dict() for r in results.values()]}, indent=1))
    return _apply_overrides(results, clips, scfg)


def place(project: Project, takes: list[Take], cfg: dict) -> dict[str, SyncResult]:
    """sync.method: audio (camera samples against the clean audio), timecode
    (embedded timecode only: nothing is read), or timecode+audio (audio
    placement, checked against timecode; timecode fills in where audio is weak)."""
    method = cfg["sync"]["method"]
    if method == "timecode":
        return place_by_timecode(project, takes, cfg)
    results = place_takes(project, takes, cfg)
    if method == "timecode+audio":
        check_timecode(project, takes, results, cfg)
    return results


def _tc_values(project: Project, takes: list[Take]):
    """Timecodes in seconds; a shoot over midnight is unwrapped."""
    tt = [t.files[0].tc_seconds for t in takes]
    ct = {c.rel: c.info.tc_seconds for c in project.all_clips()}
    vals = [v for v in tt + list(ct.values()) if v is not None]
    if vals and max(vals) - min(vals) > 12 * 3600:
        def un(v):
            return None if v is None else (v + 86400 if v < 12 * 3600 else v)
        tt = [un(v) for v in tt]
        ct = {k: un(v) for k, v in ct.items()}
    return tt, ct


def _tc_take(takes: list[Take], tt: list, start: float, dur: float) -> int | None:
    """The take whose timecode range overlaps [start, start+dur) most."""
    best, k = 0.0, None
    for i, (t, t0) in enumerate(zip(takes, tt)):
        if t0 is None:
            continue
        ov = min(start + dur, t0 + t.duration) - max(start, t0)
        if ov > best:
            best, k = ov, i
    return k


def place_by_timecode(project: Project, takes: list[Take], cfg: dict) -> dict[str, SyncResult]:
    tt, ct = _tc_values(project, takes)
    missing = [t.name for t, v in zip(takes, tt) if v is None]
    if missing:
        raise ScanError(f"the clean audio has no timecode ({', '.join(missing)}) — "
                        f"sync by audio instead (sync.method: audio)",
                        "الصوت النظيف لا يحتوي على تايم كود (" + "، ".join(missing)
                        + ") — اختر المزامنة «بالصوت» في الإعدادات")
    t0 = min(tt)
    for t, v in zip(takes, tt):
        t.position, t.linked = v - t0, True
    results: dict[str, SyncResult] = {}
    outside = 0
    for clip in project.all_clips():
        r = SyncResult(clip.rel, clip.info.duration, method="timecode")
        v = ct[clip.rel]
        if v is None:
            r.method = "failed"
            r.notes.append("no timecode in this file")
        else:
            r.offset = v - t0
            k = _tc_take(takes, tt, v, clip.info.duration)
            if k is None:
                outside += 1
                r.notes.append("its timecode is outside every take of the clean audio — "
                               "cameras and recorder not on the same timecode?")
            else:
                r.confidence, r.low = 1.0, False
                r.notes.append(f"placed by timecode ({clip.info.start_tc}) in {takes[k].name}")
        results[clip.rel] = r
    log.info("Sync by timecode: %d clip(s), clean audio %s", len(results),
             ", ".join(f"{t.name} @ {fmt_seconds(v)}" for t, v in zip(takes, tt)))
    if outside:
        log.warning("%d clip(s) have timecode outside the clean audio — if the cameras and the "
                    "recorder were not jammed, sync by audio instead", outside)
    return _apply_overrides(results, project.all_clips(), cfg["sync"])


def check_timecode(project: Project, takes: list[Take], results: dict[str, SyncResult], cfg: dict) -> None:
    """Audio placement checked against timecode: agreeing clips are noted, weak
    or unmatched ones are placed by timecode relative to a take audio placed."""
    tt, ct = _tc_values(project, takes)
    if all(v is None for v in tt):
        log.warning("timecode check: the clean audio has no timecode — audio sync only")
        return
    agree = differ = filled = 0
    for clip in project.all_clips():
        r, v = results[clip.rel], ct[clip.rel]
        if v is None or r.method == "override":
            continue
        k = _tc_take(takes, tt, v, clip.info.duration)
        if k is None:
            continue
        predicted = takes[k].position + (v - tt[k])
        if r.method == "audio" and not r.low:
            d = r.offset - predicted
            if abs(d) <= 1.0:
                agree += 1
                r.notes.append(f"timecode agrees ({d * 1000:+.0f} ms)")
            else:
                differ += 1
                r.notes.append(f"timecode differs by {d:+.2f}s — audio placement kept")
        elif takes[k].linked:
            r.offset, r.drift, r.method = predicted, 0.0, "timecode"
            r.confidence, r.low = 0.9, False
            r.notes.append(f"weak audio match — placed by timecode ({clip.info.start_tc})")
            filled += 1
    log.info("Timecode check: %d agree, %d differ (audio kept), %d placed by timecode", agree, differ, filled)


def _apply_overrides(results: dict[str, SyncResult], clips: list, scfg: dict) -> dict[str, SyncResult]:
    """Manual offsets from config.yaml win over the analysis (cached or not)."""
    for clip in clips:
        if clip.rel in scfg["overrides"]:
            results[clip.rel] = SyncResult(clip.rel, clip.info.duration, offset=scfg["overrides"][clip.rel],
                                           confidence=1.0, low=False, method="override",
                                           notes=["manual offset from config.yaml"])
    return results


def build_reference_takes(takes: list[Take], workdir: Path, rate: int,
                          channel: int | None = None) -> Reference:
    """The takes placed at their positions (silence between) as one reference."""
    workdir.mkdir(parents=True, exist_ok=True)
    fp = hashlib.sha1((fingerprint([f.path for t in takes for f in t.files],
                                   f"takes-v{TAKES_VERSION}-{rate}-ch{channel or 'all'}")
                       + json.dumps([round(t.position, 4) for t in takes])).encode()).hexdigest()[:16]
    meta_p, wav16, npy = workdir / "reference.json", workdir / "reference_16k.wav", workdir / f"reference_{rate}.npy"
    if meta_p.exists() and wav16.exists() and npy.exists() and json.loads(meta_p.read_text()).get("fp") == fp:
        log.info("Reference (takes on one timeline): cached")
        return Reference(np.load(npy, mmap_mode="r"), rate, wav16, fp)
    # place_takes lays the first take group out at 0, so positions are >= 0
    total = max(t.position + t.duration for t in takes)
    x = np.zeros(int(np.ceil(total * DIARIZE_RATE)), np.float32)
    for t in takes:
        y = _mix(t, DIARIZE_RATE, channel)
        a = int(round(t.position * DIARIZE_RATE))
        x[a:a + len(y)] += y[:max(0, len(x) - a)]
    peak = float(np.max(np.abs(x))) or 1.0
    x *= 0.9 / peak
    wavfile.write(wav16, DIARIZE_RATE, (x * 32767).astype(np.int16))
    np.save(npy, resample_poly(x, rate, DIARIZE_RATE).astype(np.float32))
    meta_p.write_text(json.dumps({"fp": fp, "duration": len(x) / DIARIZE_RATE}))
    log.info("Reference: %d takes on one timeline, %s", len(takes), fmt_seconds(total))
    return Reference(np.load(npy, mmap_mode="r"), rate, wav16, fp)
