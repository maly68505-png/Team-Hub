"""Folder layouts of real shoots: audio in several sub-folders, proxies next to the originals."""
from pathlib import Path

from autocut.scan import camera_files, clean_audio_files, discover_cameras


def touch(root: Path, *rels: str) -> None:
    for r in rels:
        p = root / r
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b"")


def names(files):
    return [f.name for f in files]


def test_episode_audio_in_several_folders(tmp_path):
    a = tmp_path / "2_AUDIO"
    touch(a, "1_On_Set_Audio/T001.wav", "1_On_Set_Audio/T002.wav",
          "2_Fixed_Audio/EP/1/T002.wav", "2_Fixed_Audio/EP/1/T010.wav",
          "2_Fixed_Audio/EP/2/T003.wav", "2_Fixed_Audio/EP/2/T004.wav",
          "2_Fixed_Audio/Promo/P1.wav")
    # the whole audio folder: the fixed episode parts, in order; no raw copy, no promo
    files = clean_audio_files(a)
    assert [f.relative_to(a).as_posix() for f in files] == [
        "2_Fixed_Audio/EP/1/T002.wav", "2_Fixed_Audio/EP/1/T010.wav",
        "2_Fixed_Audio/EP/2/T003.wav", "2_Fixed_Audio/EP/2/T004.wav"]
    # the EP folder: both parts
    assert names(clean_audio_files(a / "2_Fixed_Audio" / "EP")) == ["T002.wav", "T010.wav", "T003.wav", "T004.wav"]
    # a single part folder: just it
    assert names(clean_audio_files(a / "2_Fixed_Audio" / "EP" / "2")) == ["T003.wav", "T004.wav"]
    # only a promo: used (it is all there is)
    assert names(clean_audio_files(a / "2_Fixed_Audio" / "Promo")) == ["P1.wav"]


def test_proxies_next_to_the_originals_are_left_out(tmp_path):
    cam = tmp_path / "CAM01"
    touch(cam, "A001.MXF", "A002.MXF", "Proxy/A001_Proxy.mov", "Proxy/A002_Proxy.mov", "A003_proxy.mp4")
    assert names(camera_files(cam)) == ["A001.MXF", "A002.MXF"]
    only = tmp_path / "CAM02"
    touch(only, "Proxies/B001_Proxy.mov")
    assert names(camera_files(only)) == ["B001_Proxy.mov"]       # proxies only: used


def test_raw_footage_chosen_over_proxy_tree(tmp_path):
    touch(tmp_path, "1_RAW_Footage/CAM01/A.MXF", "1_RAW_Footage/CAM02/B.MXF",
          "3_Proxy/CAM01/A.mp4", "3_Proxy/CAM02/B.mp4")
    root, cams = discover_cameras(tmp_path, None)
    assert root == tmp_path / "1_RAW_Footage" and sorted(cams) == ["CAM01", "CAM02"]
    assert [f.suffix for f in cams["CAM01"]] == [".MXF"]
    # pointing at the proxy tree itself still works
    root, cams = discover_cameras(tmp_path / "3_Proxy", None)
    assert sorted(cams) == ["CAM01", "CAM02"]


def test_one_mic_per_person_in_two_parts(tmp_path):
    """EP/1 and EP/2, each with Host.wav + Guest 1..4.wav (one lav per person, each
    hearing a different voice): two takes of five tracks, not ten takes."""
    import numpy as np
    from scipy.io import wavfile
    from autocut.probe import probe
    from autocut.takes import group_takes
    rng = np.random.default_rng(0)
    root = tmp_path / "EP"
    names_ = ["aja.aljanoub.261015_Host", *(f"aja.aljanoub.261015_Guest {i}" for i in range(1, 5))]
    for part, secs in (("1", 40.0), ("2", 31.0)):
        (root / part).mkdir(parents=True)
        for n in names_:
            x = (0.1 * rng.normal(0, 1, int(secs * 8000))).astype(np.float32)   # unrelated signals
            wavfile.write(root / part / f"{n}.wav", 8000, (x * 32767).astype(np.int16))
    takes = group_takes([probe(f) for f in clean_audio_files(root)], "auto")
    assert len(takes) == 2
    assert [len(t.files) for t in takes] == [5, 5]
    assert [round(t.duration) for t in takes] == [40, 31]


def test_proxies_when_chosen(tmp_path):
    cam = tmp_path / "CAM01"
    touch(cam, "A001.MXF", "Proxy/A001_Proxy.mov")
    assert names(camera_files(cam, "proxies")) == ["A001_Proxy.mov"]
    assert names(camera_files(cam, "originals")) == ["A001.MXF"]
    raw_only = tmp_path / "CAM02"
    touch(raw_only, "B001.MXF")
    assert names(camera_files(raw_only, "proxies")) == ["B001.MXF"]     # no proxy: the original
    tree = tmp_path / "ep"
    touch(tree, "1_RAW_Footage/CAM01/A.MXF", "1_RAW_Footage/CAM02/B.MXF",
          "3_Proxy/CAM01/A.mp4", "3_Proxy/CAM02/B.mp4")
    root, cams = discover_cameras(tree, None, "proxies")
    assert root == tree / "3_Proxy" and [f.suffix for f in cams["CAM01"]] == [".mp4"]


def test_person_names_from_files_with_different_dates():
    """One recording whose files carry different date numbers before the "_":
    every part must give the same names, or one guest becomes several speakers."""
    from autocut.mics import file_labels

    class F:
        def __init__(self, n):
            self.path = Path(n + ".wav")
    part1 = ["aja.aljanoub.281015_Guest 1", "aja.aljanoub.261015_Guest 2", "aja.aljanoub.271015_Host"]
    part2 = ["aja.aljanoub.2111015_Guest 1", "aja.aljanoub.261015_Guest 2", "aja.aljanoub.71015_Host"]
    assert file_labels([F(n) for n in part1]) == ["Guest 1", "Guest 2", "Host"]
    assert file_labels([F(n) for n in part2]) == ["Guest 1", "Guest 2", "Host"]
    assert file_labels([F(n) for n in ["ZOOM0001_Tr1", "ZOOM0001_Tr2"]]) == ["Tr1", "Tr2"]


def test_sony_sub_proxies_are_recognised(tmp_path):
    cam = tmp_path / "CAM_08"
    touch(cam, "XDROOT/Clip/MF-080001.MXF", "XDROOT/Sub/MF-080001S03.MP4")
    assert names(camera_files(cam, "originals")) == ["MF-080001.MXF"]
    assert names(camera_files(cam, "proxies")) == ["MF-080001S03.MP4"]
    # no MXF: a Sony S03 file is a proxy only when its original is there
    mp4 = tmp_path / "CAM_09"
    touch(mp4, "C0002.MP4", "C0002S03.MP4", "LONGS03.MP4", "Sub/C0003S03.MP4")
    assert sorted(names(camera_files(mp4, "originals"))) == ["C0002.MP4", "LONGS03.MP4"]
    assert sorted(names(camera_files(mp4, "proxies"))) == ["C0002S03.MP4", "C0003S03.MP4"]


def test_original_and_proxy_with_any_names_become_one_clip(tmp_path):
    """Same timecode, same length, different picture size: one shot in two qualities."""
    import subprocess
    import shutil as sh
    import pytest
    if sh.which("ffmpeg") is None:
        pytest.skip("ffmpeg not installed")
    from autocut.probe import probe
    from autocut.scan import Clip, _one_copy_per_shot
    files = {}
    for name, size in (("BIG.MOV", "640x360"), ("small.mp4", "160x90"), ("OTHER.MOV", "640x360")):
        f = tmp_path / name
        tc = "10:00:00:00" if name != "OTHER.MOV" else "11:00:00:00"
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate=25:duration=3",
                        "-timecode", tc, "-c:v", "libx264", "-preset", "ultrafast", str(f)], check=True)
        files[name] = Clip("CAM", probe(f), f"CAM/{name}")
    clips = list(files.values())
    assert [c.rel for c in _one_copy_per_shot(clips, "originals")] == ["CAM/BIG.MOV", "CAM/OTHER.MOV"]
    assert [c.rel for c in _one_copy_per_shot(clips, "proxies")] == ["CAM/small.mp4", "CAM/OTHER.MOV"]


def test_mxf_is_the_original_whatever_the_folders(tmp_path):
    cam = tmp_path / "CAM_05"
    touch(cam, "A/MF-050001.MXF", "A/MF-050002.MXF", "B/anything.mp4", "C/other_name.mov")
    assert names(camera_files(cam, "originals")) == ["MF-050001.MXF", "MF-050002.MXF"]
    assert names(camera_files(cam, "proxies")) == ["anything.mp4", "other_name.mov"]
    mp4_only = tmp_path / "CAM_06"
    touch(mp4_only, "C0001.MP4", "Proxy/C0001_Proxy.mov")
    assert names(camera_files(mp4_only, "originals")) == ["C0001.MP4"]      # no MXF: the other rules
