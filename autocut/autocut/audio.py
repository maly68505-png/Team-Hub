"""Audio decoding (PyAV) and the mono reference mix of the clean tracks (step 2)."""
from __future__ import annotations

import hashlib
from pathlib import Path

import av
import numpy as np
from scipy.signal import resample_poly

from .probe import MediaInfo, ToolError

DIARIZE_RATE = 16000


def decode_mono(info: MediaInfo, rate: int) -> np.ndarray:
    """First audio stream, all channels summed to mono, float32 at `rate` Hz."""
    chunks = []
    try:
        with av.open(str(info.path)) as c:
            stream = c.streams.audio[0]
            resampler = av.AudioResampler(format="fltp", rate=rate)
            for frame in c.decode(stream):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().sum(axis=0))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().sum(axis=0))
    except (av.error.FFmpegError, IndexError) as e:
        raise ToolError(f"could not decode audio of {info.path}: {e}") from e
    if not chunks:
        return np.zeros(0, np.float32)
    return np.concatenate(chunks).astype(np.float32)


def decode_windows(info: MediaInfo, rate: int, starts: list[float], length: float) -> list[np.ndarray]:
    """Mono float32 windows of `length` s at `rate` Hz, starting at the given
    audio times, read by SEEKING — only those parts of the file are read.

    Camera files (MXF especially) interleave audio with video, so pulling the
    whole audio track means reading the whole file; a few seconds every couple
    of minutes is enough to sync and is ~15x less to read from a network drive.
    Times are measured from the audio stream start, like decode_mono()."""
    out: list[np.ndarray] = []
    try:
        with av.open(str(info.path)) as c:
            st = c.streams.audio[0]
            tb = st.time_base
            s0 = float(st.start_time * tb) if st.start_time is not None else 0.0
            sr = st.codec_context.sample_rate or info.sample_rate
            for start in starts:
                c.seek(max(0, int((s0 + max(0.0, start - 1.0)) / tb)), stream=st, backward=True)
                conv = av.AudioResampler(format="fltp")  # format only: no resampling, no delay
                buf, t_first, have = [], None, 0
                need = int((start + length) * sr)
                for frame in c.decode(st):
                    if frame.pts is None:
                        continue
                    for f in conv.resample(frame):
                        if t_first is None:
                            t_first = float(frame.pts * tb) - s0
                        a = f.to_ndarray().sum(axis=0)
                        buf.append(a)
                        have += len(a)
                    if t_first is not None and int(t_first * sr) + have >= need:
                        break
                if t_first is None or not buf:
                    out.append(np.zeros(0, np.float32))
                    continue
                x = np.concatenate(buf)
                a = int(round((start - t_first) * sr))
                if a < 0:  # seek landed late (should not happen with backward seek)
                    x, a = np.concatenate([np.zeros(-a, x.dtype), x]), 0
                x = x[a:a + int(round(length * sr))]
                out.append(resample_poly(x, rate, sr).astype(np.float32) if sr != rate else x.astype(np.float32))
    except (av.error.FFmpegError, IndexError) as e:
        raise ToolError(f"could not read audio of {info.path}: {e}") from e
    return out


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
