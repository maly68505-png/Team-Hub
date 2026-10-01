"""Sync only (synced.xml) and the rough cut of an already-synced sequence (XML in)."""
import shutil
import xml.etree.ElementTree as ET

import pytest

from autocut.pipeline import EXIT_NEED_MAPPING, EXIT_OK, run
from autocut.xmlcut import SyncedSequence, workdir_for

import synth

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
MAP = "speakers:\n  SPEAKER_A: CAM_A\n  SPEAKER_B: CAM_B\n  SPEAKER_C: CAM_C\n"


@pytest.fixture(scope="module")
def synced(tmp_path_factory):
    root = synth.make_project(tmp_path_factory.mktemp("proj"))
    assert run(root, until="sync") == EXIT_OK
    xml = root / "_autocut" / "output" / "synced.xml"
    # where an editor keeps it: next to the shoot, not inside _autocut
    dst = root / "Episode synced.xml"
    shutil.copy(xml, dst)
    return root, dst


def tracks(path):
    seq = ET.parse(path).getroot().find("sequence")
    return seq, seq.findall("media/video/track"), seq.findall("media/audio/track")


def items(track):
    return [(int(c.findtext("start")), int(c.findtext("end")), int(c.findtext("in")), c)
            for c in track.findall("clipitem")]


def file_ids(root):
    return {f.get("id"): f.findtext("pathurl") for f in root.iter("file") if f.find("pathurl") is not None}


def test_sync_only_xml(synced):
    root, xml = synced
    seq, vt, at = tracks(xml)
    assert len(vt) == 4                                   # one per camera, no cut track
    assert all(c.findtext("enabled") == "TRUE" for tr in vt for c in tr.findall("clipitem"))
    assert all(tr.findtext("locked") == "FALSE" for tr in vt)
    assert len(at) == 2 + 4                               # clean tracks + one per camera
    cam_audio = [c for tr in at[2:] for c in tr.findall("clipitem")]
    assert cam_audio and all(c.findtext("enabled") == "FALSE" for c in cam_audio)
    # camera audio sits exactly under its picture
    for v, a in zip(vt, at[2:]):
        assert [(s, e, i) for s, e, i, _ in items(v)] == [(s, e, i) for s, e, i, _ in items(a)]
    assert not (root / "_autocut" / "speakers.json").exists()   # no diarization ran


def test_reads_cameras_and_clean_audio(synced):
    _, xml = synced
    sq = SyncedSequence(xml)
    assert sorted(sq.cameras) == sorted(synth.CAMERAS)
    assert {sq.file_path(it.file_id).name for it in sq.speech_items()} == {"TR1.WAV", "TR2.WAV"}
    assert sq.n == 180 * 25


def _cut(xml, rttm, extra=""):
    work = workdir_for(xml)
    work.mkdir(parents=True, exist_ok=True)
    (work / "config.yaml").write_text("long_camera: CAM_WIDE\n" + MAP + extra)
    return run(xml, rttm=rttm)


def test_first_run_asks_for_speakers(synced, tmp_path):
    root, xml = synced
    x = tmp_path / "s.xml"
    shutil.copy(xml, x)
    assert run(x, rttm=root / "truth.rttm") == EXIT_NEED_MAPPING
    assert (workdir_for(x) / "speakers.json").exists()


def test_cut_on_top_track_keeps_sync(synced):
    root, xml = synced
    assert _cut(xml, root / "truth.rttm", "output:\n  layered: false\n") == EXIT_OK
    out = workdir_for(xml) / "output" / "roughcut.xml"
    seq, vt, at = tracks(out)
    assert len(vt) == 5 and len(at) == 6
    _, vt0, _ = tracks(xml)
    cut = items(vt[-1])
    assert cut[0][0] == 0 and cut[-1][1] == 180 * 25
    assert all(a[1] == b[0] for a, b in zip(cut, cut[1:])), "the cut has no holes"
    # every cut clip shows the same source frame at the same sequence frame as the synced original
    orig = {}
    for tr in vt0:
        for s, e, i, c in items(tr):
            orig.setdefault(c.findtext("name"), []).append((s, e, i))
    for s, e, i, c in cut:
        assert any(os_ <= s and e <= oe and i - s == oi - os_ for os_, oe, oi in orig[c.findtext("name")])
    for tr in vt[:-1]:
        assert tr.findtext("enabled") == "FALSE"
    r = ET.parse(out).getroot()
    # each file defined once, before or at its first use; no dangling links
    first = {}
    for f in r.iter("file"):
        first.setdefault(f.get("id"), f.find("pathurl") is not None)
    assert all(first.values())
    ids = {c.get("id") for c in r.iter("clipitem")}
    assert len(ids) == sum(1 for _ in r.iter("clipitem"))
    assert all(ln.findtext("linkclipref") in ids for ln in r.iter("link"))


def test_layered_silence_and_test_window_stay_in_sync(synced):
    """Re-timed output: at every frame each camera clip and the clean audio
    still come from the same recording moment."""
    root, xml = synced
    assert _cut(xml, root / "truth.rttm",
                "cut:\n  remove_silence: true\noutput:\n  layered: true\n") == EXIT_OK
    assert run(xml, rttm=root / "truth.rttm", start="0:20", duration="90") == EXIT_OK
    out = workdir_for(xml) / "output" / "roughcut_000020_90s_tight_layers.xml"
    seq, vt, at = tracks(out)
    assert int(seq.findtext("duration")) < 90 * 25            # silences removed
    assert seq.findtext("timecode/string") == "00:00:20:00"
    _, vt0, at0 = tracks(xml)
    paths = file_ids(ET.parse(xml).getroot())

    def offsets(trs):  # file -> sequence frame minus source frame, in the synced original
        d = {}
        for tr in trs:
            for s, e, i, c in items(tr):
                d.setdefault(paths[c.find("file").get("id")], set()).add(s - i)
        return d

    vo, ao = offsets(vt0), offsets(at0[:1])
    (audio_off,) = ao[next(iter(ao))]
    clean = items(at[0])
    on = 0
    for tr in vt:
        for s, e, i, c in items(tr):
            # recording frame of output frame s, via the clean audio clip covering it
            a = next(x for x in clean if x[0] <= s < x[1])
            rec_audio = a[2] + (s - a[0]) + audio_off
            p = paths[c.find("file").get("id")]
            assert any(i + off == rec_audio for off in vo[p]), f"{p} out of sync at {s}"
            on += c.findtext("enabled") == "TRUE"
    assert on > 3
    # one enabled camera at a time
    frames = {}
    for tr in vt:
        for s, e, i, c in items(tr):
            if c.findtext("enabled") == "TRUE":
                for f in range(s, e):
                    assert f not in frames
                    frames[f] = True


def test_premiere_style_xml(synced, tmp_path):
    """pproTicks, video/audio links and a transition, like a Premiere export."""
    root, xml = synced
    tree = ET.parse(xml)
    seq = tree.getroot().find("sequence")
    vt, at = seq.findall("media/video/track"), seq.findall("media/audio/track")
    T = 254016000000 // 25
    for c in tree.getroot().iter("clipitem"):
        ET.SubElement(c, "pproTicksIn").text = str(int(c.findtext("in")) * T)
        ET.SubElement(c, "pproTicksOut").text = str(int(c.findtext("out")) * T)
    for v, a in zip(vt, at[2:]):
        for cv, ca in zip(v.findall("clipitem"), a.findall("clipitem")):
            for x, y in ((cv, ca), (ca, cv)):
                ln = ET.SubElement(x, "link")
                ET.SubElement(ln, "linkclipref").text = y.get("id")
    # a transition between CAM_A's two clips (FCP7: -1 on the clips next to it)
    a1, a2 = vt[0].findall("clipitem")[:2]
    e1 = int(a1.findtext("end"))
    tr = ET.Element("transitionitem")
    ET.SubElement(tr, "start").text = str(e1 - 12)
    ET.SubElement(tr, "end").text = str(e1 + 12)
    vt[0].insert(list(vt[0]).index(a2), tr)
    x = tmp_path / "premiere.xml"
    tree.write(x, encoding="utf-8")

    assert _cut(x, root / "truth.rttm", "cut:\n  remove_silence: true\noutput:\n  layered: false\n") == EXIT_OK
    out = ET.parse(workdir_for(x) / "output" / "roughcut_tight.xml").getroot()
    n = 0
    for c in out.iter("clipitem"):
        assert int(c.findtext("pproTicksIn")) == int(c.findtext("in")) * T
        assert int(c.findtext("pproTicksOut")) == int(c.findtext("out")) * T
        n += 1
    assert n > 10
    ids = {c.get("id") for c in out.iter("clipitem")}
    assert all(ln.findtext("linkclipref") in ids for ln in out.iter("link"))
    assert not list(out.iter("transitionitem"))
