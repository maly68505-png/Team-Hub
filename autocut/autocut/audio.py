"""ffmpeg audio decoding and the mono reference mix of the clean tracks (step 2)."""
from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

from .log import log
from .probe import MediaInfo, ToolError

DIARIZE_RATE = 16000


def _pan_mono(channels: int) -> str:
    return "pan=mono|c0=" + "+".join(f"c{i}" for i in range(max(1, channels)))


def decode_mono(info: MediaInfo, rate: int) -> np.ndarray:
    """First audio stream, all channels summed to mono, float32 at `rate` Hz."""
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-i", str(info.path), "-map", "0:a:0", "-vn",
           "-af", _pan_mono(info.audio_channels), "-ar", str(rate), "-f", "f32le", "-"]
    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        raise ToolError(f"ffmpeg could not decode audio of {info.path}: "
                        f"{res.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(res.stdout, dtype=np.float32).copy()


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
    fp = fingerprint([a.path for a in audio], f"ref-v1-{rate}")
    meta_p = workdir / "reference.json"
    wav16 = workdir / "reference_16k.wav"
    npy = workdir / f"reference_{rate}.npy"
    if meta_p.exists() and wav16.exists() and npy.exists():
        meta = json.loads(meta_p.read_text())
        if meta.get("fp") == fp:
            log.info("Reference mix: cached (%s)", wav16.name)
            return Reference(np.load(npy, mmap_mode="r"), rate, wav16, fp)

    log.info("Mixing %d clean track(s) to one mono reference ...", len(audio))
    tmp = workdir / "reference_16k_f32.wav"
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y"]
    for a in audio:
        cmd += ["-i", str(a.path)]
    chains = [f"[{i}:a:0]{_pan_mono(a.audio_channels)},aresample={DIARIZE_RATE}[a{i}]"
              for i, a in enumerate(audio)]
    if len(audio) == 1:
        graph = chains[0].replace("[a0]", "[out]")
    else:
        graph = ";".join(chains) + ";" + "".join(f"[a{i}]" for i in range(len(audio))) + \
            f"amix=inputs={len(audio)}:duration=longest:normalize=0[out]"
    cmd += ["-filter_complex", graph, "-map", "[out]", "-ac", "1", "-ar", str(DIARIZE_RATE),
            "-c:a", "pcm_f32le", str(tmp)]
    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        raise ToolError("ffmpeg failed to mix the clean audio: "
                        + res.stderr.decode(errors="replace").strip())
    sr, x = wavfile.read(tmp)
    x = np.asarray(x, dtype=np.float32)
    tmp.unlink()
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
