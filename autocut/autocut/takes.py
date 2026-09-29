"""Clean audio recorded as separate TAKES (TAKE1.wav, TAKE2.wav ...), not as
simultaneous tracks.

The recorder stopped between takes while cameras often kept rolling, so the
takes' real start times are unknown. They are recovered from the cameras:

  1. every take is matched against every camera clip (normalized FFT
     cross-correlation of the whole take at 1 kHz, then 10 s windows refined
     at 8 kHz where they overlap) -> measurement points
         take t at take-time tau  ==  clip c at video-time v
  2. one least-squares solve places everything on one timeline:
         T_t + tau = C_c + v * (1 + d_c)
     (T = take start, C = clip start, d = clip clock drift), edges whose
     residual is over 2 frames are dropped as false matches and it re-solves;
  3. groups that no camera connects are laid out one after another in take
     order, with a warning.

The reference is then the takes placed at T_t with silence between them, and
everything downstream (diarization, cut, XML) works as with one recording.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.fft import next_fast_len
from scipy.signal import fftconvolve, resample_poly

from .audio import DIARIZE_RATE, Reference, decode_mono, fingerprint
from .log import log
from .probe import MediaInfo
from .scan import Project
from .sync import SyncResult, Measurement, _parabolic, bandpass, ncc
from .timecode import fmt_seconds

TAKES_VERSION = 3
GROUP_GAP_S = 5.0     # silence between take groups no camera connects
WIN_S = 10.0          # refine window
STEP_S = 15.0
DRIFT_SPAN_S = 120.0  # measurements must span this much of a clip to estimate its drift
MIN_RATIO = 1.3       # coarse peak ratio to consider a take/clip pair at all


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


def _mix(take: Take, rate: int) -> np.ndarray:
    x = np.zeros(0, np.float32)
    for f in take.files:
        y = decode_mono(f, rate)
        if len(y) > len(x):
            x = np.concatenate([x, np.zeros(len(y) - len(x), np.float32)])
        x[:len(y)] += y
    return x


class _Prepared:
    def __init__(self, x8: np.ndarray, rate: int, crate: int):
        self.f = bandpass(x8, rate, 100, 3000)
        self.c = bandpass(resample_poly(x8, crate, rate).astype(np.float32), crate, 80, 450)
        self.dur = len(x8) / rate


CHUNK_S = 20.0        # coarse chunk of a take
CHUNK_STEP_S = 30.0


def _ncc_many(ref: np.ndarray, probes: list[np.ndarray], m: int) -> list[np.ndarray]:
    """Normalized cross-correlation of several equal-length probes against one
    reference, sharing the reference FFT. out[k] compares probe with ref[k:k+m]."""
    nfft = next_fast_len(len(ref) + m)
    fr = np.fft.rfft(ref.astype(np.float64), nfft)
    e = np.concatenate([[0.0], np.cumsum(ref.astype(np.float64) ** 2)])
    energy = e[m:] - e[:-m]
    eps = 1e-3 * float(np.mean(energy)) + 1e-12
    den = np.sqrt(np.maximum(energy, 0) + eps)
    out = []
    for p in probes:
        p = p.astype(np.float64) - float(np.mean(p))
        pn = float(np.linalg.norm(p)) + 1e-12
        corr = np.fft.irfft(fr * np.conj(np.fft.rfft(p, nfft)), nfft)[:len(ref) - m + 1]
        out.append(corr / (pn * den))
    return out


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


def _match(tk: _Prepared, cl: _Prepared, rate: int, crate: int, scfg: dict):
    """Measurement points (tau, v_audio, ncc) where take and clip overlap, or None.

    Coarse: 20 s chunks of the take searched across the whole clip at 1 kHz; the
    chunks that agree on a (slowly drifting) alignment vote for it. Fine: 10 s
    windows at 8 kHz around that alignment wherever take and clip overlap."""
    m = int(CHUNK_S * crate)
    if len(tk.c) < crate * 3 or len(cl.c) < crate * 3:
        return None
    m = min(m, len(tk.c))
    starts = np.arange(0, max(1, len(tk.c) - m + 1), int(CHUNK_STEP_S * crate))
    chunks, taus = [], []
    for a in starts:
        ch = tk.c[a:a + m]
        if float(np.std(ch)) > 1e-5:
            chunks.append(ch)
            taus.append(a / crate)
    if not chunks:
        return None
    padded = np.concatenate([np.zeros(m, np.float32), cl.c, np.zeros(m, np.float32)])
    votes = []  # (tau_chunk_start, lag, ratio)
    for tau, n in zip(taus, _ncc_many(padded, chunks, m)):
        k = int(np.argmax(n))
        peak = float(n[k])
        rest = np.concatenate([n[:max(0, k - crate)], n[k + crate + 1:]])
        second = float(np.max(rest)) if len(rest) else 0.0
        ratio = peak / max(second, 1e-6) if peak > 0 else 0.0
        if ratio >= 1.4:
            votes.append((tau, (k - m) / crate - tau, ratio))
    if not votes:
        return None
    best = max(votes, key=lambda v: v[2])
    agree = [v for v in votes if abs(v[1] - best[1]) < 0.05 + 300e-6 * abs(v[0] - best[0])]
    if len(agree) < 2 and best[2] < 2.5:
        return None
    a0, b0, _ = _line([v[0] for v in agree], [v[1] for v in agree], tol=0.05)
    ratio = float(np.median([v[2] for v in agree]))

    def lag_at(tau):
        return a0 + b0 * tau

    lo = max(0.0, -lag_at(0.0))
    hi = min(tk.dur, cl.dur - lag_at(tk.dur))
    if hi - lo < 5.0:
        return None
    win = min(WIN_S, hi - lo)
    margin = int(0.25 * rate)
    pts = []
    t = lo
    while t + win <= hi + 1e-6:
        a = int(t * rate)
        probe = tk.f[a:a + int(win * rate)]
        if len(probe) >= rate and float(np.std(probe)) > 1e-5:
            s0 = int(round((t + lag_at(t)) * rate)) - margin
            seg = np.zeros(len(probe) + 2 * margin, np.float32)
            b0_, b1_ = max(0, s0), min(len(cl.f), s0 + len(seg))
            if b1_ > b0_:
                seg[b0_ - s0:b1_ - s0] = cl.f[b0_:b1_]
                nf = ncc(seg, probe)
                j = int(np.argmax(nf))
                fine = (s0 + j + _parabolic(nf, j)) / rate - t
                if float(nf[j]) >= float(scfg["min_ncc"]):
                    pts.append((t + win / 2, t + win / 2 + fine, float(nf[j])))
        t += STEP_S
    if not pts:
        return None
    _, _, keep = _line([p[0] for p in pts], [p[1] - p[0] for p in pts], tol=0.010)
    pts = [p for p, k in zip(pts, keep) if k]
    if len(pts) < (1 if hi - lo < 25 else 2):
        return None
    conf = float(np.clip((ratio - 1.0) / max(float(scfg["good_peak_ratio"]) - 1.0, 1e-6), 0, 1))
    return {"points": pts, "ratio": ratio, "confidence": conf}


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
        "cfg": {k: v for k, v in scfg.items() if k != "overrides"}}, sort_keys=True).encode()).hexdigest()[:16]
    cache_p = project.workdir / "takes.json"
    frame_s = 1.0 / project.rate.float
    if cache_p.exists():
        data = json.loads(cache_p.read_text())
        if data.get("key") == key:
            log.info("Take placement: cached")
            for t, d in zip(takes, data["takes"]):
                t.position, t.linked, t.notes = d["position"], d["linked"], d["notes"]
            return {r["rel"]: SyncResult.from_dict(r) for r in data["clips"]}

    log.info("Clean audio is %d separate takes — placing them on one timeline from the cameras", len(takes))
    prep_t = []
    for t in takes:
        log.info("  take %-28s %s", t.name, fmt_seconds(t.duration))
        prep_t.append(_Prepared(_mix(t, rate), rate, crate))
    edges: dict = {}
    for ci, clip in enumerate(clips):
        if not clip.info.has_audio or clip.rel in scfg["overrides"]:
            continue
        pc = _Prepared(decode_mono(clip.info, rate), rate, crate)
        found = []
        for ti, pt in enumerate(prep_t):
            e = _match(pt, pc, rate, crate, scfg)
            if e:
                e["points"] = [(tau, v + clip.info.av_offset, w) for tau, v, w in e["points"]]
                edges[(ti, ci)] = e
                found.append(takes[ti].name)
        log.info("  %-34s matches %s", clip.rel, ", ".join(found) or "NO take")

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
        if clip.rel in scfg["overrides"]:
            r.offset, r.confidence, r.low, r.method = scfg["overrides"][clip.rel], 1.0, False, "override"
            r.notes.append("manual offset from config.yaml")
        elif C[ci] is None:
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
    return results


def build_reference_takes(takes: list[Take], workdir: Path, rate: int) -> Reference:
    """The takes placed at their positions (silence between) as one reference."""
    workdir.mkdir(parents=True, exist_ok=True)
    fp = hashlib.sha1((fingerprint([f.path for t in takes for f in t.files], f"takes-v{TAKES_VERSION}-{rate}")
                       + json.dumps([round(t.position, 4) for t in takes])).encode()).hexdigest()[:16]
    meta_p, wav16, npy = workdir / "reference.json", workdir / "reference_16k.wav", workdir / f"reference_{rate}.npy"
    if meta_p.exists() and wav16.exists() and npy.exists() and json.loads(meta_p.read_text()).get("fp") == fp:
        log.info("Reference (takes on one timeline): cached")
        return Reference(np.load(npy, mmap_mode="r"), rate, wav16, fp)
    # place_takes lays the first take group out at 0, so positions are >= 0
    total = max(t.position + t.duration for t in takes)
    x = np.zeros(int(total * DIARIZE_RATE) + DIARIZE_RATE, np.float32)
    for t in takes:
        y = _mix(t, DIARIZE_RATE)
        a = int(round(t.position * DIARIZE_RATE))
        x[a:a + len(y)] += y[:max(0, len(x) - a)]
    peak = float(np.max(np.abs(x))) or 1.0
    x *= 0.9 / peak
    wavfile.write(wav16, DIARIZE_RATE, (x * 32767).astype(np.int16))
    np.save(npy, resample_poly(x, rate, DIARIZE_RATE).astype(np.float32))
    meta_p.write_text(json.dumps({"fp": fp, "duration": len(x) / DIARIZE_RATE}))
    log.info("Reference: %d takes on one timeline, %s", len(takes), fmt_seconds(total))
    return Reference(np.load(npy, mmap_mode="r"), rate, wav16, fp)
