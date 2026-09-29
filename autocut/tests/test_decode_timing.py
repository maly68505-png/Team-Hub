"""The app's decoder (PyAV) must put audio at the right time, sample-exact.

A click at exactly 1.000 s is encoded by the ffmpeg command-line tool into the
containers cameras use; decode_mono() must find it at 1.000 s (AAC's 1024-sample
encoder priming must be trimmed, the audio/video start offset honoured).
"""
import shutil
import subprocess

import numpy as np
import pytest
from scipy.io import wavfile

from autocut.audio import decode_mono
from autocut.probe import probe

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
SR = 48000


@pytest.fixture(scope="module")
def click_wav(tmp_path_factory):
    x = np.zeros(3 * SR, np.float32)
    t = np.arange(-200, 201) / SR
    x[SR - 200:SR + 201] = np.sinc(t * 8000) * np.hanning(401) * 0.8
    p = tmp_path_factory.mktemp("click") / "click.wav"
    wavfile.write(p, SR, (x * 32767).astype(np.int16))
    return p


@pytest.mark.parametrize("ext,acodec", [("mp4", "aac"), ("mov", "aac"), ("mov", "pcm_s16le"), ("mp4", "pcm_s16le")])
def test_click_lands_at_one_second(click_wav, tmp_path, ext, acodec):
    out = tmp_path / f"cam.{ext}"
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=25:duration=3",
                        "-i", str(click_wav), "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                        "-c:a", acodec, "-shortest", str(out)], capture_output=True, text=True)
    if r.returncode != 0:
        pytest.skip(f"this ffmpeg cannot write {acodec} in {ext}: {r.stderr.strip()[:200]}")
    info = probe(out)
    y = decode_mono(info, 48000)
    placed_ms = (np.argmax(np.abs(y)) / 48000 + info.av_offset) * 1000
    ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.split("\n")[0]
    print(f"{ext}/{acodec}: click at {placed_ms:.3f} ms (av_offset {info.av_offset * 1000:+.3f} ms) [{ver}]")
    assert abs(placed_ms - 1000.0) < 0.25
