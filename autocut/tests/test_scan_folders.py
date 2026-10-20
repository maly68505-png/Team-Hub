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
