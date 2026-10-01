"""Shared sync pieces: result type, correlation helpers, the sync report.

The matching itself lives in takes.py: camera audio is read in short windows
by seeking (never whole files), and every window is located in the clean
audio — one recording or several takes — by normalized cross-correlation
(1 kHz across everything, then 8 kHz around the hit). A least-squares solve
then places takes and clips on one timeline, with clock drift per clip.
Low-confidence clips are never placed silently.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

from .log import log
from .scan import Project
from .timecode import fmt_seconds

_CHUNK = 1 << 20


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


def report_sync(project: Project, results: dict[str, SyncResult], ref_dur: float) -> None:
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
