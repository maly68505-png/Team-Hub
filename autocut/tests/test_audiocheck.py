"""Audio check: a dead mic, and a WAV bigger than its header (the >4 GB case)."""
import shutil
import struct

import numpy as np
import pytest

from autocut.audiocheck import check_file
from autocut.probe import probe

import synth

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
SR = synth.SR


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    d = tmp_path_factory.mktemp("ac")
    turns = [(t, t + 40, "ABC"[int(t // 60) % 3]) for t in range(0, 880, 60)]
    sp = synth.speech(900.0, turns)
    rng = np.random.default_rng(1)
    ch = [0.3 * (sp["A"] + sp["B"] + sp["C"]), sp["A"], sp["B"], sp["C"].copy(), 0.5 * (sp["A"] + sp["C"])]
    ch[3][int(400 * SR):] = 0                      # mic 4 dies at 6:40
    ch = [c + rng.normal(0, 0.002, len(c)).astype(np.float32) for c in ch]
    good = d / "REC.wav"
    synth.write_multichannel_wav(good, ch)
    b = bytearray(good.read_bytes())               # header that covers only 10 of 15 minutes
    i = b.find(b"data")
    n = 600 * SR * 5 * 2
    struct.pack_into("<I", b, i + 4, n)
    struct.pack_into("<I", b, 4, i + n)
    bad = d / "REC_FIXED.wav"
    bad.write_bytes(bytes(b))
    return d, good, bad


def test_dead_channel_found(files):
    d, good, _ = files
    r = check_file(probe(good), d / "w")
    assert [len(c["blocks"]) for c in r["channels"]] == [3] * 5
    assert r["channels"][3]["blocks"][2]["s"] == "silent"
    assert all(b["s"] == "talk" for c in r["channels"][:3] for b in c["blocks"])
    assert [n for n in r["notes"] if "channel 4" in n["en"]]
    assert not [n for n in r["notes"] if n["level"] == "error"]


def test_file_bigger_than_its_header(files):
    d, _, bad = files
    r = check_file(probe(bad), d / "w")
    assert r["duration"] == pytest.approx(600, abs=1)
    assert r["on_disk"] == pytest.approx(900, abs=2)
    assert any(n["level"] == "error" and "header covers only" in n["en"] for n in r["notes"])
    assert all(c["blocks"][2]["s"] == "missing" for c in r["channels"])
