"""Step 3 — sync every camera clip to the clean-audio reference.

Each clip's scratch audio is matched against the clean mix by normalized FFT
cross-correlation:

  coarse  a probe window (default 60 s) of scratch audio at 1 kHz is searched
          across the WHOLE reference, so any offset is found;
  fine    the same window at 8 kHz is re-matched within +-0.25 s of the coarse
          hit, with parabolic interpolation for sub-sample precision.

Clips are synced one by one rather than as one concatenated file: when a
camera stops and restarts there is a gap between clips, and per-clip sync
places each one correctly regardless.

Clips longer than `long_clip_minutes` are measured near the start, middle and
end. The start/end difference is the clock drift; the middle must sit on the
line between them or the clip is flagged (dropped frames, bad match).

Confidence = how much the best match stands out from the best match more than
1 s away (peak ratio), mapped to 0..1 by `good_peak_ratio`. Low-confidence
clips are never placed silently: the run stops unless the user overrides.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, resample_poly, sosfilt

from .audio import Reference, decode_mono, fingerprint
from .log import log
from .scan import Clip, Project
from .timecode import Rate, fmt_seconds

_CHUNK = 1 << 20
FINE_SUB_S = 5.0
SYNC_VERSION = 3  # bump when the algorithm changes: invalidates cached results


def bandpass(x: np.ndarray, rate: int, lo: float, hi: float) -> np.ndarray:
    hi = min(hi, 0.45 * rate)
    sos = butter(4, [lo, hi], btype="band", fs=rate, output="sos")
    out = np.empty(len(x), np.float32)
    zi = np.zeros((sos.shape[0], 2))
    for i in range(0, len(x), _CHUNK):
        y, zi = sosfilt(sos, np.asarray(x[i:i + _CHUNK], dtype=np.float64), zi=zi)
        out[i:i + _CHUNK] = y
    return out


def ncc(ref: np.ndarray, probe: np.ndarray) -> np.ndarray:
    """Normalized cross-correlation; out[k] compares probe with ref[k:k+len(probe)]."""
    w = len(probe)
    p = probe.astype(np.float64) - float(np.mean(probe))
    pn = float(np.linalg.norm(p))
    corr = fftconvolve(ref.astype(np.float32), p[::-1].astype(np.float32), mode="valid")
    e = np.concatenate([[0.0], np.cumsum(ref.astype(np.float64) ** 2)])
    energy = e[w:] - e[:-w]
    eps = 1e-3 * float(np.mean(energy)) + 1e-12
    return corr / (pn * np.sqrt(np.maximum(energy, 0) + eps) + 1e-12)


def _parabolic(y: np.ndarray, i: int) -> float:
    if 0 < i < len(y) - 1:
        a, b, c = y[i - 1], y[i], y[i + 1]
        den = a - 2 * b + c
        if den != 0:
            return float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))
    return 0.0


@dataclass
class Measurement:
    at: float          # video time of the probe centre (s)
    offset: float      # reference time - video time (s)
    ncc: float
    peak_ratio: float
    confidence: float
    good: bool


@dataclass
class SyncResult:
    rel: str
    duration: float
    offset: float = 0.0            # reference time where the clip's first frame lands
    drift: float = 0.0             # reference = video * (1 + drift) + offset
    drift_measured: float | None = None
    confidence: float = 0.0
    low: bool = True
    method: str = "audio"          # audio | override | failed
    notes: list[str] = field(default_factory=list)
    measurements: list[Measurement] = field(default_factory=list)

    def ref_time(self, video_t: float) -> float:
        return video_t * (1 + self.drift) + self.offset

    def video_time(self, ref_t: float) -> float:
        return (ref_t - self.offset) / (1 + self.drift)

    @property
    def ref_start(self) -> float:
        return self.offset

    @property
    def ref_end(self) -> float:
        return self.ref_time(self.duration)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "SyncResult":
        d = dict(d)
        d["measurements"] = [Measurement(**m) for m in d.get("measurements", [])]
        return cls(**d)


class Syncer:
    def __init__(self, ref: Reference, scfg: dict, rate: Rate):
        self.cfg = scfg
        self.rate = int(scfg["analysis_rate"])
        self.crate = int(scfg["coarse_rate"])
        if ref.rate != self.rate:
            raise ValueError("reference rate mismatch")
        self.frame_s = 1.0 / rate.float
        x = np.asarray(ref.x, dtype=np.float32)
        self.ref_f = bandpass(x, self.rate, 100, 3000)
        self.ref_c = bandpass(resample_poly(x, self.crate, self.rate).astype(np.float32),
                              self.crate, 80, 450)
        self.ref_duration = len(x) / self.rate

    # --- one probe -------------------------------------------------------
    def _measure(self, clip_f, clip_c, start_s: float, win_s: float, av_offset: float) -> Measurement:
        cw = int(win_s * self.crate)
        c0 = int(start_s * self.crate)
        probe_c = clip_c[c0:c0 + cw]
        padded = np.concatenate([np.zeros(cw, np.float32), self.ref_c, np.zeros(cw, np.float32)])
        n = ncc(padded, probe_c)
        k = int(np.argmax(n))
        peak = float(n[k])
        excl = int(1.0 * self.crate)
        rest = np.concatenate([n[:max(0, k - excl)], n[k + excl + 1:]])
        second = float(np.max(rest)) if len(rest) else 0.0
        ratio = peak / max(second, 1e-6) if peak > 0 else 0.0
        coarse_r = (k - cw) / self.crate

        # Fine: short sub-windows, so clock drift inside the probe (e.g. 50 ppm x 60 s
        # = 3 ms) does not smear the 8 kHz correlation. Median of the sub-window lags.
        coarse_off = coarse_r - start_s
        sub = min(FINE_SUB_S, win_s)
        n_sub = max(1, int(win_s // sub))
        margin = int(0.25 * self.rate)
        offs, nccs = [], []
        for i in range(n_sub):
            t0 = start_s + i * sub
            f0 = int(t0 * self.rate)
            probe_f = clip_f[f0:f0 + int(sub * self.rate)]
            if len(probe_f) < self.rate or float(np.std(probe_f)) < 1e-6:
                continue
            s0 = int(round((t0 + coarse_off) * self.rate)) - margin
            seg_len = len(probe_f) + 2 * margin
            seg = np.zeros(seg_len, np.float32)
            a, b = max(0, s0), min(len(self.ref_f), s0 + seg_len)
            if b <= a:
                continue
            seg[a - s0:b - s0] = self.ref_f[a:b]
            nf = ncc(seg, probe_f)
            j = int(np.argmax(nf))
            offs.append((s0 + j + _parabolic(nf, j)) / self.rate - t0)
            nccs.append(float(nf[j]))
        if not offs:
            offs, nccs = [coarse_off], [0.0]
        # keep the largest group of sub-windows that agree (silent/noisy ones wander off)
        votes = [sum(abs(o - p) < 0.004 for p in offs) + nccs[k] for k, o in enumerate(offs)]
        centre = offs[int(np.argmax(votes))]
        keep = [k for k, o in enumerate(offs) if abs(o - centre) < 0.004]
        fine_off = float(np.median([offs[k] for k in keep]))
        fine_ncc = float(np.median([nccs[k] for k in keep]))

        good_ratio = float(self.cfg["good_peak_ratio"])
        conf = float(np.clip((ratio - 1.0) / max(good_ratio - 1.0, 1e-6), 0.0, 1.0))
        good = conf >= float(self.cfg["min_confidence"]) and fine_ncc >= float(self.cfg["min_ncc"])
        offset = fine_off - av_offset
        return Measurement(at=start_s + av_offset + win_s / 2, offset=offset, ncc=round(fine_ncc, 4),
                           peak_ratio=round(ratio, 3), confidence=round(conf, 3), good=good)

    def _pick_probe(self, clip_c: np.ndarray, region: tuple[float, float], win_s: float) -> float:
        blk = max(1, int(0.5 * self.crate))
        nb = len(clip_c) // blk
        if nb == 0:
            return 0.0
        rms = np.sqrt(np.mean(clip_c[:nb * blk].astype(np.float64).reshape(nb, blk) ** 2, axis=1))
        med = float(np.median(rms)) + 1e-9
        score = np.minimum(rms / med, 3.0)
        wb = max(1, int(round(win_s / 0.5)))
        cs = np.concatenate([[0.0], np.cumsum(score)])
        lo = max(0, int(region[0] / 0.5))
        hi = min(nb - wb, int(region[1] / 0.5) - wb)
        if hi < lo:
            return max(0.0, min(region[0], len(clip_c) / self.crate - win_s))
        starts = np.arange(lo, hi + 1, 10) if hi - lo > 10 else np.arange(lo, hi + 1)
        best = starts[int(np.argmax(cs[starts + wb] - cs[starts]))]
        return best * 0.5

    # --- one clip ----------------------------------------------------------
    def sync_clip(self, clip: Clip) -> SyncResult:
        info = clip.info
        res = SyncResult(clip.rel, info.duration)
        if not info.has_audio:
            res.method = "failed"
            res.notes.append("no audio stream — add a sync override in config.yaml")
            return res
        x = decode_mono(info, self.rate)
        audio_dur = len(x) / self.rate
        if audio_dur < 5.0:
            res.method = "failed"
            res.notes.append(f"only {audio_dur:.1f}s of audio — too short to sync")
            return res
        clip_f = bandpass(x, self.rate, 100, 3000)
        clip_c = bandpass(resample_poly(x, self.crate, self.rate).astype(np.float32), self.crate, 80, 450)
        win = min(float(self.cfg["probe_seconds"]), audio_dur)

        long_clip = audio_dur > float(self.cfg["long_clip_minutes"]) * 60 and audio_dur >= 3 * win
        if long_clip:
            edge = max(win * 1.5, 0.2 * audio_dur)
            regions = {"start": (0.0, edge),
                       "middle": (0.4 * audio_dur, 0.6 * audio_dur + win),
                       "end": (audio_dur - edge, audio_dur)}
        else:
            regions = {"whole": (0.0, audio_dur)}
        meas: dict[str, Measurement] = {}
        for name, region in regions.items():
            start = self._pick_probe(clip_c, region, win)
            m = self._measure(clip_f, clip_c, start, win, info.av_offset)
            meas[name] = m
            log.debug("  %s [%s @%.0fs] offset %+.4f ncc %.3f ratio %.2f conf %.2f",
                      clip.rel, name, start, m.offset, m.ncc, m.peak_ratio, m.confidence)
        res.measurements = list(meas.values())
        self._combine(res, meas, long_clip)
        if not (np.isfinite(res.offset) and np.isfinite(res.drift)):
            res.offset, res.drift, res.low, res.method = 0.0, 0.0, True, "failed"
            res.notes.append("correlation produced no usable result")
        return res

    def _combine(self, res: SyncResult, meas: dict[str, Measurement], long_clip: bool) -> None:
        good = {k: m for k, m in meas.items() if m.good}
        if not good:
            best = max(meas.values(), key=lambda m: m.confidence)
            res.offset, res.confidence, res.low = best.offset, best.confidence, True
            res.notes.append("no confident match (peak ratio %.2f, ncc %.2f)"
                             % (best.peak_ratio, best.ncc))
            return
        res.confidence = min(m.confidence for m in good.values())
        res.low = False
        if not long_clip:
            m = good["whole"]
            res.offset = m.offset
            return
        if len(good) == 1:
            (name, m), = good.items()
            res.offset = m.offset
            res.notes.append(f"drift NOT checked: only the {name} of the clip matched")
            return
        pts = sorted(good.values(), key=lambda m: m.at)
        d, o0 = np.polyfit([m.at for m in pts], [m.offset for m in pts], 1)
        d, o0 = float(d), float(o0)
        res.drift_measured = d
        for m in pts:
            predicted = o0 + d * m.at
            if abs(m.offset - predicted) > 2 * self.frame_s:
                res.low = True
                res.notes.append("measurements disagree by %.0f ms (dropped frames or a bad match?)"
                                 % (1000 * abs(m.offset - predicted)))
        if abs(d) * 1e6 > float(self.cfg["max_drift_ppm"]):
            res.low = True
            res.notes.append(f"implausible drift {d * 1e6:.0f} ppm — start/end matches disagree")
        total = abs(d) * res.duration
        if total > float(self.cfg["drift_correct_frames"]) * self.frame_s:
            res.drift = d
            res.offset = o0
            res.notes.append(f"drift {d * 1e6:+.1f} ppm = {total * 1000:.0f} ms over the clip — CORRECTED")
        else:
            res.drift = 0.0
            res.offset = float(np.mean([m.offset for m in pts]))
            res.notes.append(f"drift {d * 1e6:+.1f} ppm = {total * 1000:.1f} ms — below threshold, ignored")


def _cfg_hash(scfg: dict) -> str:
    keys = {k: v for k, v in scfg.items() if k != "overrides"}
    keys["_version"] = SYNC_VERSION
    return hashlib.sha1(json.dumps(keys, sort_keys=True).encode()).hexdigest()[:12]


def sync_all(project: Project, ref: Reference, cfg: dict) -> dict[str, SyncResult]:
    scfg = cfg["sync"]
    cache_p = project.workdir / "sync.json"
    cache = {}
    if cache_p.exists():
        data = json.loads(cache_p.read_text())
        if data.get("ref_fp") == ref.fp and data.get("cfg") == _cfg_hash(scfg):
            cache = data.get("clips", {})
    overrides = scfg["overrides"]
    unknown = set(overrides) - {c.rel for c in project.all_clips()}
    for u in sorted(unknown):
        log.warning("sync override for unknown clip '%s' (use CAMERA/FILENAME)", u)

    syncer = None
    results: dict[str, SyncResult] = {}
    new_cache = {}
    for clip in project.all_clips():
        fp = fingerprint([clip.path])
        if clip.rel in overrides:
            r = SyncResult(clip.rel, clip.info.duration, offset=overrides[clip.rel],
                           confidence=1.0, low=False, method="override",
                           notes=["manual offset from config.yaml"])
        elif clip.rel in cache and cache[clip.rel]["fp"] == fp:
            r = SyncResult.from_dict(cache[clip.rel]["result"])
            log.debug("  %s: cached", clip.rel)
        else:
            if syncer is None:
                log.info("Preparing reference for correlation ...")
                syncer = Syncer(ref, scfg, project.rate)
            log.info("  syncing %s ...", clip.rel)
            r = syncer.sync_clip(clip)
        results[clip.rel] = r
        if r.method != "override":
            new_cache[clip.rel] = {"fp": fp, "result": r.to_dict()}
    cache_p.parent.mkdir(parents=True, exist_ok=True)
    cache_p.write_text(json.dumps({"ref_fp": ref.fp, "cfg": _cfg_hash(scfg), "clips": new_cache},
                                  indent=1))
    _report(project, results, ref.duration)
    return results


def _report(project: Project, results: dict[str, SyncResult], ref_dur: float) -> None:
    fps = project.rate.float
    log.info("")
    log.info("%-30s %14s %16s %6s %6s %6s  %s", "clip", "starts at ref", "drift", "conf",
             "ncc", "ratio", "status")
    for cam in project.cameras.values():
        prev = None
        for clip in cam.clips:
            r = results[clip.rel]
            ms = r.measurements
            ncc_s = f"{min(m.ncc for m in ms):.2f}" if ms else "-"
            ratio_s = f"{min(m.peak_ratio for m in ms):.1f}" if ms else "-"
            if r.drift_measured is not None:
                drift_s = f"{r.drift_measured * 1e6:+.0f}ppm" + ("*" if r.drift else "")
            else:
                drift_s = "-"
            status = "LOW CONFIDENCE" if r.low else ("override" if r.method == "override" else "ok")
            log.info("%-30s %14s %16s %6.2f %6s %6s  %s", clip.rel, fmt_seconds(r.offset), drift_s,
                     r.confidence, ncc_s, ratio_s, status)
            for n in r.notes:
                (log.warning if r.low else log.info)("%32s%s", "- ", n)
            if not r.low and (r.ref_end < 0 or r.ref_start > ref_dur):
                log.warning("%s lies entirely outside the clean audio", clip.rel)
            if prev is not None and not prev.low and not r.low:
                gap = r.ref_start - prev.ref_end
                if gap < -1.0 / fps:
                    log.warning("%s overlaps the previous clip of %s by %.2fs — check sync",
                                clip.rel, cam.name, -gap)
                else:
                    log.info("%32sgap after previous clip: %.2fs", "- ", gap)
            prev = r
    lows = [r for r in results.values() if r.low]
    if lows:
        log.warning("%d clip(s) with LOW sync confidence: %s", len(lows),
                    ", ".join(r.rel for r in lows))
    else:
        log.info("All %d clips synced with good confidence.", len(results))


def write_sync_csv(path: Path, results: dict[str, SyncResult]) -> None:
    import csv
    with open(path, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["clip", "offset_s", "drift_ppm_measured", "drift_ppm_applied", "confidence",
                    "min_ncc", "min_peak_ratio", "status", "method", "notes"])
        for r in results.values():
            ms = r.measurements
            w.writerow([r.rel, f"{r.offset:.4f}",
                        "" if r.drift_measured is None else f"{r.drift_measured * 1e6:.1f}",
                        f"{r.drift * 1e6:.1f}", f"{r.confidence:.3f}",
                        f"{min(m.ncc for m in ms):.3f}" if ms else "",
                        f"{min(m.peak_ratio for m in ms):.2f}" if ms else "",
                        "LOW" if r.low else "ok", r.method, " | ".join(r.notes)])
