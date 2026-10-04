"""Who is talking, from the recorder's mic channels (diarization.method: mics).

A multitrack recorder puts each person's lav on its own channel (often with a
mix on channel 1). Whoever is talking is loud on their own mic; the others hear
them only as bleed, well below. Per 20 ms, a mic is TALKING when

  - it is well above its own background (its noise floor), and
  - it is within `mic_margin_db` of the loudest mic — levels measured relative
    to each mic's own speech level, so a quiet voice on a low-gain mic still counts.

Two people talking at once are both loud on their own mics -> an overlap, as
with the AI diarization. Labels are "MIC 2", "MIC 3", ... (the channel number),
mapped to cameras in the app like any speaker.

No model, no GPU: a 2-hour recording takes about a minute (decode only).
"""
from __future__ import annotations

from pathlib import Path

import av
import numpy as np
from scipy.signal import butter, sosfilt

from .audio import fingerprint
from .cutlogic import _runs
from .diarize import Segment
from .log import log
from .probe import MediaInfo, ToolError

HOP = 0.02          # level frame (s)
SMOOTH = 5          # frames of power averaging (100 ms)
FLOOR_DB = 12.0     # talking: at least this far above the mic's own background
MIN_ON = 0.25       # shorter bursts are dropped (s)
BRIDGE = 0.35       # shorter pauses inside a turn are bridged (s)


def channel_levels(info: MediaInfo, workdir: Path, errors: list | None = None) -> np.ndarray:
    """(channels, frames) level in dB per HOP, high-passed at 120 Hz (no rumble).
    Cached per file in <workdir>/mics/. A decoding error part way keeps what was
    read (and is appended to `errors` when given); an error at the start raises."""
    cache = workdir / "mics" / f"{fingerprint([info.path], f'levels-{HOP}')}.npy"
    if cache.exists():
        return np.load(cache)
    out: list[np.ndarray] = []
    partial = False
    try:
        with av.open(str(info.path)) as c:
            st = c.streams.audio[0]
            sr = st.codec_context.sample_rate or info.sample_rate or 48000
            step = int(round(HOP * sr))
            sos = butter(2, 120, btype="highpass", fs=sr, output="sos")
            zi = None
            conv = av.AudioResampler(format="fltp")
            carry = None
            for frame in c.decode(st):
                for f in conv.resample(frame):
                    a = f.to_ndarray().astype(np.float64)
                    if zi is None:
                        zi = np.zeros((a.shape[0], sos.shape[0], 2))
                    y = np.empty_like(a)
                    for ch in range(a.shape[0]):
                        y[ch], zi[ch] = sosfilt(sos, a[ch], zi=zi[ch])
                    carry = y if carry is None else np.concatenate([carry, y], axis=1)
                    k = carry.shape[1] // step
                    if k:
                        blk = carry[:, :k * step]
                        out.append((blk.reshape(blk.shape[0], k, step) ** 2).mean(axis=2))
                        carry = carry[:, k * step:]
    except (av.error.FFmpegError, IndexError) as e:
        if not out:
            raise ToolError(f"could not read the channels of {info.path}: {e}") from e
        partial = True
        read = sum(x.shape[1] for x in out) * HOP
        log.warning("%s: decoding stopped at %.0fs: %s", info.path.name, read, e)
        if errors is not None:
            errors.append(f"decoding stopped at {read:.0f}s: {e}")
    if not out:
        return np.zeros((max(1, info.audio_channels), 0), np.float32)
    p = np.concatenate(out, axis=1)
    kern = np.ones(SMOOTH) / SMOOTH
    p = np.stack([np.convolve(row, kern, mode="same") for row in p])
    lv = (10 * np.log10(p + 1e-12)).astype(np.float32)
    if not partial:  # never cache a partial read
        cache.parent.mkdir(parents=True, exist_ok=True)
        np.save(cache, lv)
    return lv


def mic_label(channel: int, file_no: int, n_files: int, n_channels: int) -> str:
    if n_channels > 1:
        return f"MIC {channel}" if n_files == 1 else f"MIC {file_no}.{channel}"
    return f"MIC {file_no}"


def mic_channels(info: MediaInfo, dcfg: dict, mix_channel: int | None) -> list[int]:
    """Channels of a file that are personal mics (1-based)."""
    n = max(1, info.audio_channels)
    if dcfg.get("mic_channels"):
        return [c for c in dcfg["mic_channels"] if 1 <= c <= n]
    return [c for c in range(1, n + 1) if not (n > 1 and c == mix_channel)]


class Timeline:
    """Mic levels placed on the reference timeline."""

    def __init__(self, duration: float):
        self.n = int(np.ceil(duration / HOP))
        self.levels: dict[str, np.ndarray] = {}

    def place(self, label: str, lv: np.ndarray, at: float, src: float = 0.0, length: float | None = None):
        row = self.levels.setdefault(label, np.full(self.n, -120.0, np.float32))
        a, s = int(round(at / HOP)), int(round(src / HOP))
        m = len(lv) - s if length is None else int(round(length / HOP))
        m = min(m, len(lv) - s, self.n - a)
        if m <= 0:
            return
        if a < 0:
            s, m, a = s - a, m + a, 0
        if m > 0:
            row[a:a + m] = lv[s:s + m]


def segments(levels: dict[str, np.ndarray], margin_db: float = 10.0) -> list[Segment]:
    """Talking turns per mic (see the module doc)."""
    labels, rows, refs = [], [], []
    for label, row in sorted(levels.items()):
        valid = row[row > -100]
        if len(valid) < 50:
            continue
        floor = float(np.percentile(valid, 10))
        speech = float(np.percentile(valid, 99))
        if speech < -60 or speech - floor < FLOOR_DB:
            log.info("  %s: no speech on this channel (skipped)", label)
            continue
        labels.append(label)
        rows.append(np.where(row > floor + FLOOR_DB, row - speech, -np.inf))
        refs.append((floor, speech))
    if not labels:
        return []
    rel = np.stack(rows)                      # level relative to each mic's own speech level
    loudest = rel.max(axis=0)
    talking = np.isfinite(rel) & (rel >= loudest - float(margin_db))
    out: list[Segment] = []
    bridge, min_on = int(BRIDGE / HOP), int(MIN_ON / HOP)
    for i, label in enumerate(labels):
        m = talking[i].copy()
        for a, b in _runs(m):                 # bridge short pauses inside a turn
            if not m[a] and a > 0 and b < len(m) and b - a <= bridge:
                m[a:b] = True
        for a, b in _runs(m):
            if m[a] and b - a >= min_on:
                out.append(Segment(a * HOP, b * HOP, label))
        log.info("  %-10s floor %5.1f dB, speech %5.1f dB, talking %s", label, refs[i][0], refs[i][1],
                 f"{sum(s.duration for s in out if s.speaker == label):.0f}s")
    out.sort(key=lambda s: (s.start, s.end))
    return out


def from_takes(takes, duration: float, dcfg: dict, mix_channel: int | None, workdir: Path) -> list[Segment]:
    """Folder mode: every take's mic channels at the take's position."""
    tl = Timeline(duration)
    for t in takes:
        for j, f in enumerate(t.files, 1):
            chans = mic_channels(f, dcfg, mix_channel)
            if not chans:
                continue
            log.info("Mic levels: %s (channels %s)", f.path.name, ", ".join(map(str, chans)))
            lv = channel_levels(f, workdir)
            for ch in chans:
                if ch <= lv.shape[0]:
                    tl.place(mic_label(ch, j, len(t.files), f.audio_channels), lv[ch - 1], t.position)
    return _finish(tl, dcfg)


def _finish(tl: Timeline, dcfg: dict) -> list[Segment]:
    if not tl.levels:
        from .diarize import DiarizationError
        raise DiarizationError("no mic channels to detect speakers from — the clean audio has a "
                               "single channel; use the AI speaker detection instead")
    segs = segments(tl.levels, float(dcfg.get("mic_margin_db") or 10))
    log.info("Speakers from %d mic(s): %d talking turns", len(tl.levels), len(segs))
    return segs
