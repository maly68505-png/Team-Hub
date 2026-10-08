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


@pytest.mark.parametrize("ext,vcodec,acodec", [("mp4", "libx264", "aac"), ("mov", "libx264", "pcm_s16le"),
                                               ("mxf", "mpeg2video", "pcm_s16le")])
def test_windows_read_by_seeking_land_exactly(click_wav, tmp_path, ext, vcodec, acodec):
    """decode_windows must put the click where decode_mono does (1.000 s)."""
    from autocut.audio import decode_windows
    out = tmp_path / f"cam.{ext}"
    vopts = ["-pix_fmt", "yuv420p"] + (["-preset", "ultrafast"] if vcodec == "libx264" else ["-b:v", "2M"])
    r = subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25:duration=3",
                        "-i", str(click_wav), "-c:v", vcodec, *vopts, "-c:a", acodec, "-ar", "48000",
                        "-shortest", str(out)], capture_output=True, text=True)
    if r.returncode != 0:
        pytest.skip(f"this ffmpeg cannot write {ext}: {r.stderr.strip()[:200]}")
    info = probe(out)
    for start in (0.0, 0.5, 0.9):
        (w,) = decode_windows(info, 8000, [start], 1.0)
        assert len(w) == 8000
        click = np.argmax(np.abs(w)) / 8000 + start
        assert abs(click - 1.0) < 0.0005, (ext, start, click)
    full = decode_mono(info, 8000)
    assert abs(np.argmax(np.abs(full)) / 8000 - 1.0) < 0.0005


def test_mic_on_second_track_of_mxf_syncs(tmp_path):
    """Camera MXF with several mono audio tracks, the mic on track 2 and track 1
    silent (a common XDCAM setup): sync must hear it."""
    import synth
    from autocut.pipeline import EXIT_OK, run
    root = synth.make_project(tmp_path / "p")
    cam = root / "CAM_B" / "B_001.MP4"
    wav = tmp_path / "b.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(cam), "-vn", "-ac", "1", "-ar", "48000", str(wav)], check=True)
    mxf = root / "CAM_B" / "B_001.MXF"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(cam), "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono",
                    "-i", str(wav), "-map", "0:v", "-map", "1:a", "-map", "2:a", "-c:v", "mpeg2video", "-b:v", "2M",
                    "-c:a", "pcm_s16le", "-shortest", str(mxf)], check=True)
    cam.unlink()
    assert run(root, until="sync") == EXIT_OK
    import csv
    with open(root / "_autocut" / "output" / "sync_report.csv", encoding="utf-8") as fh:
        rows = {r["clip"]: r for r in csv.DictReader(fh)}
    r = rows["CAM_B/B_001.MXF"]
    assert r["status"] == "ok" and abs(float(r["offset_s"]) - 10.3) < 0.005
    import xml.etree.ElementTree as ET
    seq = ET.parse(root / "_autocut" / "output" / "synced.xml").getroot().find("sequence")
    idx = [c.findtext("sourcetrack/trackindex") for tr in seq.findall("media/audio/track")
           for c in tr.findall("clipitem") if c.findtext("name") == "B_001.MXF"]
    assert idx == ["2"]                       # the camera's own sound, from the track the mic is on
