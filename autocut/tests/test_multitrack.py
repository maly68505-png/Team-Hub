"""A multitrack recorder (mix on ch1 + one lav per person), timecode sync,
and speakers detected from the mic channels."""
import csv
import shutil
import xml.etree.ElementTree as ET
from fractions import Fraction

import numpy as np
import pytest

from autocut.pipeline import EXIT_LOW_SYNC, EXIT_NEED_MAPPING, EXIT_OK, run
from autocut.probe import probe
from autocut.timecode import tc_seconds
from autocut.xmlcut import workdir_for

import synth

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
MICS = "speakers:\n  MIC 2: CAM_A\n  MIC 3: CAM_B\n  MIC 4: CAM_C\n"


def test_tc_seconds():
    assert tc_seconds("10:00:05:00", 25) == 36005.0
    assert tc_seconds("00:00:01:12", 25) == 1.48
    assert tc_seconds("01:00:00;00", Fraction(30000, 1001)) == pytest.approx(3600, abs=0.01)  # drop frame = real time
    assert tc_seconds("bad", 25) is None


@pytest.fixture(scope="module")
def proj(tmp_path_factory):
    return synth.make_multitrack_project(tmp_path_factory.mktemp("multi"))


def cfg(root, **extra):
    """config.yaml with extra lines appended to sections."""
    text = ("fps: 25\nlong_camera: CAM_WIDE\naudio_channel: 1\n" + MICS
            + "diarization:\n  min_speaker_seconds: 5\n" + extra.get("diarization", "")
            + "sync:\n" + extra.get("sync", "  method: audio\n")
            + "output:\n  layered: false\n")
    (root / "config.yaml").write_text(text)


def sync_rows(root):
    with open(root / "_autocut" / "output" / "sync_report.csv", encoding="utf-8") as fh:
        return {r["clip"]: r for r in csv.DictReader(fh)}


def test_recorder_timecode_and_channels_probed(proj):
    info = probe(proj / "audio" / "REC_001.WAV")
    assert info.audio_channels == 4
    assert info.tc_seconds == synth.REC_TC


def test_sync_by_timecode_reads_no_camera_audio(proj):
    cfg(proj, sync="  method: timecode\n")
    # CAM_B / CAM_C have no timecode: reported, not guessed
    assert run(proj, until="sync") == EXIT_LOW_SYNC
    rows = sync_rows(proj)
    assert rows["CAM_A/C0001.MP4"]["method"] == "timecode"
    assert float(rows["CAM_A/C0001.MP4"]["offset_s"]) == pytest.approx(3.0, abs=1e-6)
    assert float(rows["CAM_A/C0002.MP4"]["offset_s"]) == pytest.approx(85.0, abs=1e-6)
    assert float(rows["CAM_WIDE/W0001.MP4"]["offset_s"]) == pytest.approx(-5.0, abs=1e-6)
    assert rows["CAM_B/B_001.MP4"]["status"] == "LOW" and "no timecode" in rows["CAM_B/B_001.MP4"]["notes"]
    log = (proj / "_autocut" / "autocut.log").read_text()
    assert "Reading" not in log.split("2-3. Sync")[-1].split("===")[0]   # no camera audio read


def test_timecode_plus_audio(proj):
    cfg(proj, sync="  method: timecode+audio\n")
    assert run(proj, until="sync") == EXIT_OK
    rows = sync_rows(proj)
    assert "timecode agrees" in rows["CAM_A/C0001.MP4"]["notes"]
    assert rows["CAM_B/B_001.MP4"]["method"] == "audio"      # no timecode: audio alone
    assert float(rows["CAM_B/B_001.MP4"]["offset_s"]) == pytest.approx(10.3, abs=0.002)


def test_mix_channel_only_in_premiere(proj):
    cfg(proj)
    assert run(proj, until="sync") == EXIT_OK
    seq = ET.parse(proj / "_autocut" / "output" / "synced.xml").getroot().find("sequence")
    at = seq.findall("media/audio/track")
    clean = [tr for tr in at if any("REC_001" in (c.findtext("name") or "") for c in tr.findall("clipitem"))]
    assert len(clean) == 1                                   # the mix, not 4 tracks
    assert clean[0].find("clipitem/sourcetrack/trackindex").text == "1"


def frame_agreement(segs_path, truth, n=int(synth.REF_SECONDS / 0.1)):
    """Share of 100 ms frames where the detected talkers equal the truth (A=MIC 2...)."""
    names = {"A": "MIC_2", "B": "MIC_3", "C": "MIC_4"}
    def grid(rows):
        g = [set() for _ in range(n)]
        for s, e, who in rows:
            for k in range(int(s / 0.1), min(n, int(e / 0.1))):
                g[k].add(who)
        return g
    got = []
    for line in open(segs_path):
        p = line.split()
        got.append((float(p[3]), float(p[3]) + float(p[4]), p[7]))
    want = grid([(s, e, names[w]) for s, e, w in truth if e - s >= 0.7])
    have = grid(got)
    return np.mean([a == b for a, b in zip(want, have)])


def test_speakers_from_mics(proj, tmp_path):
    root = tmp_path / "p"
    shutil.copytree(proj, root, ignore=shutil.ignore_patterns("_autocut"))
    (root / "config.yaml").write_text("fps: 25\nlong_camera: CAM_WIDE\naudio_channel: 1\nspeakers:\n"
                                      "diarization:\n  method: mics\n  min_speaker_seconds: 5\n"
                                      "output:\n  layered: false\n")
    assert run(root) == EXIT_NEED_MAPPING                   # first run: map the mics
    import json
    sp = json.loads((root / "_autocut" / "speakers.json").read_text())
    assert set(sp["speakers"]) == {"MIC 2", "MIC 3", "MIC 4"}   # ch1 is the mix: not a person
    cfg(root, diarization="  method: mics\n")
    assert run(root) == EXIT_OK
    with open(root / "_autocut" / "output" / "cuts.csv", encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    assert any(r["camera"] == "CAM_WIDE" and r["reason"] == "overlap" for r in rows)   # 45-49 s crosstalk
    talk = {r["camera"]: 0.0 for r in rows}
    for r in rows:
        talk[r["camera"]] += float(r["duration_s"])
    assert talk["CAM_A"] > 50 and talk["CAM_B"] > 30 and talk["CAM_C"] > 30
    # the turns themselves, written like an RTTM for the check
    from autocut import mics
    from autocut.scan import scan
    from autocut.takes import group_takes
    p = scan(root, {**__import__("autocut.config", fromlist=["load"]).load(root / "config.yaml")})
    takes = group_takes(p.audio)
    segs = mics.from_takes(takes, synth.REF_SECONDS, {"mic_channels": None, "mic_margin_db": 10}, 1,
                           root / "_autocut")
    rt = tmp_path / "mics.rttm"
    rt.write_text("".join(f"SPEAKER r 1 {s.start:.3f} {s.duration:.3f} <NA> <NA> {s.speaker.replace(' ', '_')} <NA> <NA>\n"
                          for s in segs))
    assert frame_agreement(rt, synth.SCRIPT) > 0.9


def test_xml_mode_with_mics(proj, tmp_path):
    cfg(proj)
    assert run(proj, until="sync") == EXIT_OK
    xml = tmp_path / "synced.xml"
    shutil.copy(proj / "_autocut" / "output" / "synced.xml", xml)
    w = workdir_for(xml)
    w.mkdir(parents=True)
    (w / "config.yaml").write_text("long_camera: CAM_WIDE\naudio_channel: 1\n" + MICS
                                   + "diarization:\n  method: mics\noutput:\n  layered: false\n")
    assert run(xml) == EXIT_OK
    with open(w / "output" / "cuts.csv", encoding="utf-8-sig") as fh:
        cams = {r["camera"] for r in csv.DictReader(fh)}
    assert {"CAM_A", "CAM_B", "CAM_C"} <= cams
