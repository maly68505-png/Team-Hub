"""Synthetic 'speech' and a synthetic multicam project for tests."""
from __future__ import annotations

import subprocess
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, sosfilt

SR = 48000

# (start, end, speaker) — ground truth for the fixture, in reference seconds.
SCRIPT = [
    (2.0, 14.0, "A"),
    (14.3, 14.8, "B"),      # backchannel (< 0.7 s) -> ignored
    (15.0, 31.0, "A"),
    (31.5, 50.0, "B"),
    (45.0, 49.0, "A"),      # 4 s overlap with B -> long camera
    (50.5, 51.8, "C"),      # 1.3 s shot -> shorter than min_shot, absorbed
    (52.0, 70.0, "C"),
    (69.8, 70.1, "A"),      # 0.3 s: short segment
    (73.0, 95.0, "A"),
    (94.8, 95.2, "B"),      # 0.4 s overlap -> not long
    (95.2, 120.0, "B"),
    (122.0, 150.0, "C"),
    (152.0, 175.0, "A"),
]
F0 = {"A": 115.0, "B": 210.0, "C": 160.0}


def speech(duration: float, turns, sr: int = SR, seed: int = 1) -> dict[str, np.ndarray]:
    """One signal per speaker: voiced harmonics with jittery pitch + noisy consonants,
    syllable-modulated, present only inside that speaker's turns."""
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    t = np.arange(n) / sr
    out = {}
    for spk, f0 in F0.items():
        gate = np.zeros(n, np.float32)
        for s, e, who in turns:
            if who == spk:
                gate[int(s * sr):int(e * sr)] = 1.0
        # slow random pitch contour
        knots = rng.normal(0, 0.08, int(duration * 4) + 2)
        contour = np.interp(t, np.linspace(0, duration, len(knots)), knots)
        phase = 2 * np.pi * np.cumsum(f0 * (1 + contour)) / sr
        voiced = sum(np.sin(k * phase) / k for k in range(1, 12))
        syl_knots = rng.uniform(0, 1, int(duration * 5) + 2) ** 2
        syl = np.interp(t, np.linspace(0, duration, len(syl_knots)), syl_knots)
        sos = butter(2, [1500, 6000], btype="band", fs=sr, output="sos")
        noise = sosfilt(sos, rng.normal(0, 1, n)) * (rng.uniform(0, 1, n // 2400 + 1).repeat(2400)[:n] > 0.7)
        sig = (0.25 * voiced * syl + 0.3 * noise) * gate
        out[spk] = sig.astype(np.float32)
    return out


def timewarp(x: np.ndarray, offset: float, drift: float, length_s: float, sr: int = SR) -> np.ndarray:
    """Camera audio: camera time v hears reference time v*(1+drift)+offset."""
    v = np.arange(int(length_s * sr)) / sr
    src = (v * (1 + drift) + offset) * sr
    return np.interp(src, np.arange(len(x)), x, left=0.0, right=0.0).astype(np.float32)


def scratch(x: np.ndarray, seed: int, sr: int = SR, noise: float = 0.02) -> np.ndarray:
    """Make it sound like a camera mic: echo, low-pass, room noise."""
    rng = np.random.default_rng(seed)
    d = int(0.023 * sr)
    y = x.copy()
    y[d:] += 0.5 * x[:-d]
    sos = butter(2, 5000, fs=sr, output="sos")
    y = sosfilt(sos, y) + rng.normal(0, noise, len(y))
    return (0.5 * y / (np.max(np.abs(y)) + 1e-9)).astype(np.float32)


def write_wav(path: Path, x: np.ndarray, sr: int = SR) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(path, sr, (np.clip(x, -1, 1) * 32767).astype(np.int16))


def write_video(path: Path, audio: np.ndarray | None, fps: int = 25, tc: str | None = None,
                seconds: float | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    dur = seconds if seconds is not None else len(audio) / SR
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi",
           "-i", f"testsrc2=size=160x90:rate={fps}:duration={dur:.3f}"]
    if audio is not None:
        wav = path.with_suffix(".tmp.wav")
        write_wav(wav, audio)
        cmd += ["-i", str(wav)]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]
    if audio is not None:
        cmd += ["-c:a", "aac", "-b:a", "96k", "-shortest"]
    if tc:
        cmd += ["-timecode", tc]
    cmd.append(str(path))
    subprocess.run(cmd, check=True)
    if audio is not None:
        wav.unlink()


# name -> list of clips (clip_file, ref offset, drift, length, timecode)
CAMERAS = {
    "CAM_WIDE": [("W0001.MP4", -5.0, 250e-6, 190.0, "10:00:00:00")],
    "CAM_A": [("C0001.MP4", 3.0, 0.0, 77.0, "10:00:08:00"),
              ("C0002.MP4", 85.0, 0.0, 92.0, "10:01:30:00")],
    "CAM_B": [("B_001.MP4", 10.3, 0.0, 168.0, None)],
    "CAM_C": [("CLIP1.MP4", 1.52, 0.0, 176.0, None)],
}
REF_SECONDS = 180.0


def make_project(root: Path, extra_noise_camera: bool = False) -> Path:
    """A 4-camera project with 2 mixed clean tracks and a ground-truth RTTM."""
    root = Path(root)
    spk = speech(REF_SECONDS, SCRIPT)
    track1 = spk["A"] + 0.3 * spk["B"] + 0.2 * spk["C"]
    track2 = spk["B"] + spk["C"] + 0.3 * spk["A"]
    write_wav(root / "audio" / "TR1.WAV", track1 * 0.8)
    write_wav(root / "audio" / "TR2.WAV", track2 * 0.8)
    room = spk["A"] + spk["B"] + spk["C"]
    for i, (cam, clips) in enumerate(CAMERAS.items()):
        for j, (name, off, drift, length, tc) in enumerate(clips):
            a = scratch(timewarp(room, off, drift, length), seed=10 * i + j)
            write_video(root / cam / name, a, tc=tc)
    if extra_noise_camera:
        rng = np.random.default_rng(99)
        write_video(root / "CAM_X" / "NOISE.MP4", (0.1 * rng.normal(0, 1, int(30 * SR))).astype(np.float32))
    with open(root / "truth.rttm", "w") as fh:
        for s, e, who in SCRIPT:
            fh.write(f"SPEAKER ref 1 {s:.3f} {e - s:.3f} <NA> <NA> SPEAKER_{who} <NA> <NA>\n")
    (root / "config.yaml").write_text(
        "fps: 25\n"
        "long_camera: CAM_WIDE\n"
        "speakers:\n"
        "sync:\n"
        "  long_clip_minutes: 2\n"
        "  probe_seconds: 30\n"
        "diarization:\n"
        "  min_speaker_seconds: 5\n")
    return root
