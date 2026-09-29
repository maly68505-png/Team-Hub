"""Audio decoding (PyAV) and the mono reference mix of the clean tracks (step 2)."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import av
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

from .log import log
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


def build_reference(audio: list[MediaInfo], workdir: Path, rate: int) -> Reference:
    workdir.mkdir(parents=True, exist_ok=True)
    fp = fingerprint([a.path for a in audio], f"ref-v2-{rate}")
    meta_p = workdir / "reference.json"
    wav16 = workdir / "reference_16k.wav"
    npy = workdir / f"reference_{rate}.npy"
    if meta_p.exists() and wav16.exists() and npy.exists():
        meta = json.loads(meta_p.read_text())
        if meta.get("fp") == fp:
            log.info("Reference mix: cached (%s)", wav16.name)
            return Reference(np.load(npy, mmap_mode="r"), rate, wav16, fp)

    log.info("Mixing %d clean track(s) to one mono reference ...", len(audio))
    x = np.zeros(0, np.float32)
    for a in audio:
        log.info("  decoding %s ...", a.path.name)
        y = decode_mono(a, DIARIZE_RATE)
        if len(y) > len(x):
            x = np.concatenate([x, np.zeros(len(y) - len(x), np.float32)])
        x[:len(y)] += y
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if peak <= 1e-6:
        raise ToolError("the clean audio mix is silent")
    x *= 0.9 / peak
    wavfile.write(wav16, DIARIZE_RATE, (x * 32767).astype(np.int16))
    x_low = resample_poly(x, rate, DIARIZE_RATE).astype(np.float32) if rate != DIARIZE_RATE else x
    np.save(npy, x_low)
    meta_p.write_text(json.dumps({"fp": fp, "duration": len(x) / DIARIZE_RATE}))
    log.info("Reference mix: %.1f s, written %s", len(x) / DIARIZE_RATE, wav16.name)
    return Reference(np.load(npy, mmap_mode="r"), rate, wav16, fp)
