"""Audio decoding (PyAV) and the mono reference mix of the clean tracks (step 2)."""
from __future__ import annotations

import hashlib
from pathlib import Path

import av
import numpy as np
from scipy.signal import resample_poly

from .probe import MediaInfo, ToolError

DIARIZE_RATE = 16000


def _pick(a: np.ndarray, channel: int | None) -> np.ndarray:
    """(channels, n) -> mono: one channel (1-based) or all of them summed."""
    if channel and 1 <= channel <= a.shape[0]:
        return a[channel - 1]
    return a.sum(axis=0)


def decode_mono(info: MediaInfo, rate: int, channel: int | None = None) -> np.ndarray:
    """First audio stream to mono float32 at `rate` Hz: all channels summed, or
    only `channel` (1-based; e.g. the mix channel of a multitrack recorder)."""
    chunks = []
    try:
        with av.open(str(info.path)) as c:
            stream = c.streams.audio[0]
            resampler = av.AudioResampler(format="fltp", rate=rate)
            for frame in c.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(_pick(out.to_ndarray(), channel))
            for out in resampler.resample(None):
                chunks.append(_pick(out.to_ndarray(), channel))
    except (av.error.FFmpegError, IndexError) as e:
        raise ToolError(f"could not decode audio of {info.path}: {e}") from e
    if not chunks:
        return np.zeros(0, np.float32)
    return np.concatenate(chunks).astype(np.float32)


def decode_windows(info: MediaInfo, rate: int, starts: list[float], length: float,
                   channel: int | None = None) -> list[np.ndarray]:
    """Mono float32 windows of `length` s at `rate` Hz, starting at the given
    audio times, read by SEEKING — only those parts of the file are read.

    Camera files (MXF especially) interleave audio with video, so pulling the
    whole audio track means reading the whole file; a few seconds every couple
    of minutes is enough to sync and is ~15x less to read from a network drive.
    Every audio stream is read and mixed: camera MXF files carry 4-8 separate
    mono tracks and the mic is not always on the first one.
    Times are measured from the first audio stream's start, like decode_mono()."""
    out: list[np.ndarray] = []
    try:
        with av.open(str(info.path)) as c:
            streams = list(c.streams.audio)
            st0 = streams[0]
            s0 = float(st0.start_time * st0.time_base) if st0.start_time is not None else 0.0
            for start in starts:
                c.seek(max(0, int((s0 + max(0.0, start - 1.0)) / st0.time_base)), stream=st0, backward=True)
                state = {s.index: {"conv": av.AudioResampler(format="fltp"), "buf": [], "t0": None, "have": 0,
                                   "sr": s.codec_context.sample_rate or info.sample_rate, "done": False}
                         for s in streams}
                for pkt in c.demux(*streams):
                    w = state[pkt.stream.index]
                    if w["done"]:
                        continue
                    tb = pkt.stream.time_base
                    for frame in pkt.decode():
                        if frame.pts is None:
                            continue
                        for f in w["conv"].resample(frame):
                            if w["t0"] is None:
                                w["t0"] = float(frame.pts * tb) - s0
                            a = _pick(f.to_ndarray(), channel)
                            w["buf"].append(a)
                            w["have"] += len(a)
                    if w["t0"] is not None and int(w["t0"] * w["sr"]) + w["have"] >= int((start + length) * w["sr"]):
                        w["done"] = True
                    if all(v["done"] for v in state.values()):
                        break
                mix = None
                for w in state.values():
                    if w["t0"] is None or not w["buf"]:
                        continue
                    sr = w["sr"]
                    x = np.concatenate(w["buf"])
                    a = int(round((start - w["t0"]) * sr))
                    if a < 0:  # seek landed late (should not happen with backward seek)
                        x, a = np.concatenate([np.zeros(-a, x.dtype), x]), 0
                    x = x[a:a + int(round(length * sr))]
                    x = resample_poly(x, rate, sr).astype(np.float32) if sr != rate else x.astype(np.float32)
                    if mix is None:
                        mix = x
                    else:
                        n = max(len(mix), len(x))
                        mix = np.pad(mix, (0, n - len(mix))) + np.pad(x, (0, n - len(x)))
                out.append(mix if mix is not None else np.zeros(0, np.float32))
    except (av.error.FFmpegError, IndexError) as e:
        raise ToolError(f"could not read audio of {info.path}: {e}") from e
    return out


def loudest_stream(info: MediaInfo, n: int = 4, length: float = 2.0) -> int:
    """1-based number of the audio track with the most signal (camera files with
    several mono tracks: the one the mic was plugged into). 1 when unsure."""
    try:
        with av.open(str(info.path)) as c:
            streams = list(c.streams.audio)
            if len(streams) < 2:
                return 1
            dur = max(info.duration, length * 2)
            starts = np.linspace(length, max(length, dur - 2 * length), n)
            energy = np.zeros(len(streams))
            for k, st in enumerate(streams):
                tb = st.time_base
                for t in starts:
                    c.seek(int(t / tb) + int((st.start_time or 0)), stream=st, backward=True)
                    got = 0.0
                    for frame in c.decode(st):
                        a = frame.to_ndarray().astype(np.float64)
                        energy[k] += float(np.mean(a * a))
                        got += frame.samples / (frame.sample_rate or 48000)
                        if got >= length:
                            break
            return int(np.argmax(energy)) + 1
    except (av.error.FFmpegError, IndexError, ValueError):
        return 1


def fingerprint(paths: list[Path], extra: str = "") -> str:
    h = hashlib.sha1(extra.encode())
    for p in paths:
        st = Path(p).stat()
        h.update(f"{Path(p).resolve()}|{st.st_size}|{int(st.st_mtime)}".encode())
    return h.hexdigest()[:16]


class Reference:
    """The clean tracks mixed to mono. `x8k` for sync, `wav16k` for diarization."""

    def __init__(self, x: np.ndarray, rate: int, wav16k: Path, fp: str):
        self.x = x
        self.rate = rate
        self.wav16k = wav16k
        self.fp = fp

    @property
    def duration(self) -> float:
        return len(self.x) / self.rate
