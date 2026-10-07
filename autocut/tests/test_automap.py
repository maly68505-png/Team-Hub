"""Speaker -> camera suggestions from picture motion."""
import json
import shutil

import pytest

from autocut.pipeline import EXIT_NEED_MAPPING, run

import synth

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


def test_each_speaker_gets_the_camera_that_moves_while_they_talk(tmp_path):
    root = tmp_path / "p"
    spk = synth.speech(synth.REF_SECONDS, synth.SCRIPT)
    synth.write_wav(root / "audio" / "TR1.WAV", (spk["A"] + spk["B"] + spk["C"]) * 0.6)
    room = spk["A"] + spk["B"] + spk["C"]
    who = {"CAM_X": "B", "CAM_Y": "C", "CAM_Z": "A"}     # names that give nothing away
    for i, (cam, s) in enumerate(who.items()):
        off = 2.0 + i
        turns = [(a - off, b - off) for a, b, w in synth.SCRIPT if w == s]
        a = synth.scratch(synth.timewarp(room, off, 0.0, 175.0), seed=i)
        synth.write_motion_video(root / cam / "C001.MP4", a,
                                 lambda t, turns=turns: any(x <= t < y for x, y in turns), seed=i)
    synth.write_video(root / "CAM_WIDE" / "W001.MP4", synth.scratch(synth.timewarp(room, -1.0, 0.0, 182.0), seed=9))
    with open(root / "truth.rttm", "w") as fh:
        for s, e, w in synth.SCRIPT:
            fh.write(f"SPEAKER ref 1 {s:.3f} {e - s:.3f} <NA> <NA> SPEAKER_{w} <NA> <NA>\n")
    (root / "config.yaml").write_text("fps: 25\nlong_camera: CAM_WIDE\nspeakers:\n"
                                      "diarization:\n  min_speaker_seconds: 5\n")
    assert run(root, until="diarize", rttm=root / "truth.rttm") == EXIT_NEED_MAPPING
    sp = json.loads((root / "_autocut" / "speakers.json").read_text())["speakers"]
    got = {k: v["suggested"] for k, v in sp.items()}
    assert got == {"SPEAKER_A": "CAM_Z", "SPEAKER_B": "CAM_X", "SPEAKER_C": "CAM_Y"}
