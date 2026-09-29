"""Folder layouts editors actually use."""
import shutil

import numpy as np
import pytest

from autocut.config import DEFAULTS
from autocut.scan import ScanError, find_audio_dir, scan

import synth

pytestmark = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@pytest.fixture(scope="module")
def clip(tmp_path_factory):
    p = tmp_path_factory.mktemp("media") / "clip.mp4"
    synth.write_video(p, np.zeros(2 * synth.SR, np.float32))
    return p


def cfg(**kw):
    c = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULTS.items()}
    c.update(long_camera="CAM 01", **kw)
    return c


def shoot(tmp_path, clip, audio_at="sibling"):
    """0000/2_AUDIO + 0000/3_Proxy/CAM 01..04 (like a real editor's tree)."""
    top = tmp_path / "0000"
    proxy = top / "3_Proxy"
    for i in range(1, 5):
        (proxy / f"CAM 0{i}").mkdir(parents=True)
        shutil.copy(clip, proxy / f"CAM 0{i}" / "C0001.MP4")
    audio = (top / "2_AUDIO") if audio_at == "sibling" else (proxy / "Sound")
    audio.mkdir(parents=True)
    synth.write_wav(audio / "TR1.WAV", np.zeros(synth.SR, np.float32))
    return proxy, audio


def test_audio_folder_next_to_the_camera_folder(tmp_path, clip):
    proxy, audio = shoot(tmp_path, clip)
    assert find_audio_dir(proxy.resolve(), "audio") == audio.resolve()
    p = scan(proxy, cfg())
    assert p.audio_dir == audio.resolve()
    assert list(p.cameras) == ["CAM 01", "CAM 02", "CAM 03", "CAM 04"]


def test_audio_folder_inside_with_another_name(tmp_path, clip):
    proxy, audio = shoot(tmp_path, clip, audio_at="inside")
    p = scan(proxy, cfg())
    assert p.audio_dir == audio.resolve() and "Sound" not in p.cameras


def test_explicit_relative_audio_folder_and_errors(tmp_path, clip):
    proxy, audio = shoot(tmp_path, clip)
    assert scan(proxy, cfg(audio_folder="../2_AUDIO")).audio_dir == audio.resolve()
    with pytest.raises(ScanError, match="not found"):
        scan(proxy, cfg(audio_folder="../nothing"))
    (tmp_path / "0000" / "4_AUDIO_MIX").mkdir()
    with pytest.raises(ScanError, match="several folders"):
        scan(proxy, cfg())


def test_non_video_folders_skipped_and_card_subfolders_searched(tmp_path, clip):
    proxy, _ = shoot(tmp_path, clip)
    (proxy / "Exports").mkdir()
    (proxy / "Exports" / "notes.txt").write_text("x")
    card = proxy / "CAM 02" / "PRIVATE" / "M4ROOT" / "CLIP"
    card.mkdir(parents=True)
    shutil.copy(clip, card / "C0002.MP4")
    p = scan(proxy, cfg())
    assert "Exports" not in p.cameras
    assert [c.rel for c in p.cameras["CAM 02"].clips] == ["CAM 02/C0001.MP4", "CAM 02/PRIVATE/M4ROOT/CLIP/C0002.MP4"]


def test_choosing_the_top_folder_finds_cameras_inside_proxy(tmp_path, clip):
    proxy, audio = shoot(tmp_path, clip)
    top = proxy.parent  # 0000/ with 2_AUDIO and 3_Proxy
    p = scan(top, cfg())
    assert p.audio_dir == audio.resolve()
    assert list(p.cameras) == ["CAM 01", "CAM 02", "CAM 03", "CAM 04"]
    assert p.cameras["CAM 01"].clips[0].path.resolve() == (proxy / "CAM 01" / "C0001.MP4").resolve()


def test_audio_in_the_recorders_subfolder(tmp_path, clip):
    proxy, audio = shoot(tmp_path, clip)
    (audio / "TR1.WAV").rename(audio / "tmp.wav")
    (audio / "ZOOM0001").mkdir()
    (audio / "tmp.wav").rename(audio / "ZOOM0001" / "ZOOM0001_Tr1.WAV")
    p = scan(proxy.parent, cfg())
    assert [a.path.name for a in p.audio] == ["ZOOM0001_Tr1.WAV"]


def test_several_takes_must_be_chosen(tmp_path, clip):
    proxy, audio = shoot(tmp_path, clip)
    for take in ("ZOOM0001", "ZOOM0002"):
        (audio / take).mkdir()
        shutil.copy(audio / "TR1.WAV", audio / take / f"{take}_Tr1.WAV")
    (audio / "TR1.WAV").unlink()
    with pytest.raises(ScanError, match="several sub-folders") as e:
        scan(proxy.parent, cfg())
    assert "ZOOM0001" in e.value.ar and "ZOOM0002" in e.value.ar
    p = scan(proxy.parent, cfg(audio_folder="2_AUDIO/ZOOM0002"))
    assert [a.path.name for a in p.audio] == ["ZOOM0002_Tr1.WAV"]


def test_audio_folder_without_audio_says_what_is_there(tmp_path, clip):
    proxy, audio = shoot(tmp_path, clip)
    (audio / "TR1.WAV").unlink()
    shutil.copy(clip, audio / "camera_by_mistake.mp4")
    with pytest.raises(ScanError, match=r"1 \.mp4") as e:
        scan(proxy.parent, cfg())
    assert "WAV" in e.value.ar
