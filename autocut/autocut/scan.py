"""Step 1 — find cameras, clips and clean audio; read fps/duration/timecode."""
from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from .log import log
from .probe import MediaInfo, probe
from .timecode import Rate, tc_to_frames

VIDEO_EXT = {".mp4", ".mov", ".mxf", ".mts", ".m2ts", ".avi", ".mkv", ".m4v", ".mpg", ".mpeg"}
AUDIO_EXT = {".wav", ".bwf", ".rf64", ".aif", ".aiff", ".caf", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus"}
WORK_DIR = "_autocut"


class ScanError(Exception):
    """`ar` carries the same problem in Arabic for the app."""

    def __init__(self, msg: str, ar: str | None = None):
        super().__init__(msg)
        self.ar = ar


@dataclass
class Clip:
    camera: str
    info: MediaInfo
    rel: str  # "CAM_A/C0001.MP4" — key used in reports and sync overrides

    @property
    def path(self) -> Path:
        return self.info.path


@dataclass
class Camera:
    name: str
    clips: list[Clip] = field(default_factory=list)


@dataclass
class Project:
    root: Path
    cameras: dict[str, Camera]
    audio: list[MediaInfo]
    rate: Rate
    long_camera: str
    audio_dir: Path | None = None

    @property
    def workdir(self) -> Path:
        return self.root / WORK_DIR

    def all_clips(self) -> list[Clip]:
        return [c for cam in self.cameras.values() for c in cam.clips]


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def _files(folder: Path, exts: set[str], recursive: bool = False) -> list[Path]:
    it = folder.rglob("*") if recursive else folder.iterdir()
    found = [p for p in it
             if p.is_file() and p.suffix.lower() in exts
             and not any(part.startswith(".") for part in p.relative_to(folder).parts)]
    return sorted(found, key=lambda p: natural_key(p.relative_to(folder).as_posix()))


AUDIO_NAME = re.compile(r"audio|sound|صوت|wav", re.IGNORECASE)


def find_audio_dir(root: Path, name: str) -> Path:
    """The clean-audio folder: `audio_folder` from the config (relative to the
    project, e.g. "../2_AUDIO", or absolute); with the default name, a folder
    called like audio/sound/صوت inside the project or next to it."""
    p = (root / name).resolve()
    if p.is_dir():
        return p
    if name == "audio":
        for where in (root, root.parent):
            cands = [d for d in where.iterdir() if d.is_dir() and d.resolve() != root
                     and not d.name.startswith(".") and d.name != WORK_DIR and AUDIO_NAME.search(d.name)]
            if len(cands) == 1:
                log.info("Clean audio folder found: %s", cands[0])
                return cands[0].resolve()
            if len(cands) > 1:
                names = ", ".join(c.name for c in cands)
                raise ScanError(f"several folders look like the clean audio: {names} — choose one "
                                f"(audio_folder in config.yaml / the app settings)",
                                ar=f"أكثر من مجلد يبدو أنه الصوت النظيف: {names} — اختر واحداً.")
    raise ScanError(f"clean audio folder not found ('{name}' in {root}). Choose it in the app "
                    f"settings, or set audio_folder in config.yaml (e.g. ../2_AUDIO)",
                    ar="لم أجد مجلد الصوت النظيف — اضغط «اختر…» وحدده.")


def _order_clips(cam: Camera, rate: Rate) -> None:
    by_name = list(cam.clips)
    tcs = [c.info.start_tc for c in by_name]
    if len(by_name) < 2:
        return
    if all(tcs) and len(set(tcs)) == len(tcs):
        try:
            by_tc = sorted(by_name, key=lambda c: tc_to_frames(c.info.start_tc, rate))
        except ValueError:
            log.warning("  %s: unreadable timecode, ordering by filename", cam.name)
            return
        if by_tc != by_name:
            log.warning("  %s: timecode order differs from filename order — using TIMECODE order",
                        cam.name)
        cam.clips = by_tc
        log.info("  %s: clips ordered by start timecode", cam.name)
    else:
        log.info("  %s: clips ordered by filename (timecode missing or duplicated)", cam.name)


def _video_subdirs(folder: Path, audio_dir: Path | None) -> dict[str, list[Path]]:
    out = {}
    for p in sorted(folder.iterdir(), key=lambda p: natural_key(p.name)):
        if (p.is_dir() and p.name != WORK_DIR and not p.name.startswith(".")
                and (audio_dir is None or p.resolve() != audio_dir)):
            files = _files(p, VIDEO_EXT, recursive=True)
            if files:
                out[p.name] = files
            else:
                log.debug("folder '%s' has no video files — not a camera", p.name)
    return out


def _describe(folder: Path) -> str:
    """What is in a folder, for error messages: '3 folders, 12 .mp4, 1 .txt'."""
    kinds: Counter = Counter()
    for p in folder.iterdir():
        if p.name.startswith("."):
            continue
        kinds["folders" if p.is_dir() else (p.suffix.lower() or "no extension")] += 1
    return ", ".join(f"{n} {k}" for k, n in kinds.most_common()) or "empty"


def clean_audio_files(audio_dir: Path) -> list[Path]:
    """Audio files of ONE recording: directly in the folder, or in its only
    sub-folder that has audio (recorders like Zoom write ZOOM0001/...WAV).
    Several sub-folders with audio are separate takes: the user must choose."""
    flat = _files(audio_dir, AUDIO_EXT)
    if flat:
        return flat
    deep = _files(audio_dir, AUDIO_EXT, recursive=True)
    if not deep:
        exts = " ".join(sorted(AUDIO_EXT))
        raise ScanError(
            f"no audio files in {audio_dir} (looked for {exts}, also in sub-folders); "
            f"it contains: {_describe(audio_dir)}",
            ar=f"لا توجد ملفات صوت داخل «{audio_dir.name}» ولا داخل مجلداته الفرعية. "
               f"محتواه: {_describe(audio_dir)}. اختر المجلد الذي فيه ملفات WAV.")
    groups: dict[Path, list[Path]] = {}
    for f in deep:
        groups.setdefault(f.parent, []).append(f)
    if len(groups) == 1:
        (folder, files), = groups.items()
        log.info("Clean audio is in the sub-folder %s", folder.relative_to(audio_dir))
        return files
    listing = ", ".join(f"{g.relative_to(audio_dir)} ({len(fs)})" for g, fs in groups.items())
    raise ScanError(
        f"audio files are in several sub-folders of {audio_dir}: {listing} — these look like "
        f"separate takes; choose the one sub-folder of this recording as the clean-audio folder",
        ar=f"ملفات الصوت موزّعة على أكثر من مجلد فرعي داخل «{audio_dir.name}»: {listing}. "
           f"غالباً هذه تسجيلات منفصلة — اختر المجلد الفرعي الخاص بهذا التصوير من «مجلد الصوت النظيف».")


def discover_cameras(root: Path, audio_dir: Path | None) -> tuple[Path, dict[str, list[Path]]]:
    """Camera folders with their video files. If the chosen folder holds just one
    folder that itself holds several camera folders (e.g. 0000/3_Proxy/CAM 01..),
    the cameras are taken from there."""
    found = _video_subdirs(root, audio_dir)
    if len(found) == 1:
        (only,) = found
        inner = _video_subdirs(root / only, audio_dir)
        if len(inner) >= 2:
            return root / only, inner
    if not found:
        raise ScanError(f"no camera folders with video files in {root}")
    return root, found


def scan(root: Path, cfg: dict) -> Project:
    root = Path(root).resolve()
    if not root.is_dir():
        raise ScanError(f"project folder not found: {root}")
    audio_dir = find_audio_dir(root, str(cfg["audio_folder"] or "audio"))

    explicit = bool(cfg["cameras"])
    if explicit:
        cam_root = root
        cam_names = [str(c) for c in cfg["cameras"]]
        for n in cam_names:
            if not (root / n).is_dir():
                raise ScanError(f"camera folder listed in config not found: {root / n}")
        videos = {n: _files(root / n, VIDEO_EXT, recursive=True) for n in cam_names}
        for n, v in videos.items():
            if not v:
                raise ScanError(f"camera folder '{n}' has no video files ({', '.join(sorted(VIDEO_EXT))})")
    else:
        cam_root, videos = discover_cameras(root, audio_dir)
        cam_names = list(videos)
    if cam_root != root:
        log.info("Camera folders are in %s", cam_root)
    if cfg["long_camera"] not in cam_names:
        raise ScanError(f"long_camera '{cfg['long_camera']}' is not one of the camera folders: "
                        f"{', '.join(cam_names)}")
    if len(cam_names) > 12:
        raise ScanError(f"found {len(cam_names)} camera folders — expected at most 12: {cam_names}")
    if not 4 <= len(cam_names) <= 7:
        log.warning("found %d cameras (expected 4-7) — continuing", len(cam_names))

    cameras: dict[str, Camera] = {}
    fps_votes: Counter = Counter()
    for name in cam_names:
        cam = Camera(name)
        for p in videos[name]:
            rel = f"{name}/{p.relative_to(cam_root / name).as_posix()}"
            info = probe(p)
            if not info.has_video:
                log.warning("  skip %s: no video stream", rel)
                continue
            cam.clips.append(Clip(name, info, rel))
            if info.fps:
                fps_votes[info.fps] += 1
        cameras[name] = cam

    if not fps_votes:
        raise ScanError("could not read a frame rate from any camera clip")
    seq_fps = fps_votes.most_common(1)[0][0]
    rate = Rate(seq_fps)

    log.info("Cameras (%d):", len(cameras))
    for cam in cameras.values():
        _order_clips(cam, rate)
        for c in cam.clips:
            i = c.info
            fps_s = f"{float(i.fps):.3f}".rstrip("0").rstrip(".") if i.fps else "?"
            flag = ""
            if i.fps != seq_fps:
                flag = f"   <-- WARNING fps {fps_s} differs from sequence {rate}"
            log.info("  %-28s %6s fps  %s  %dx%s  tc %s  audio %s%s",
                     c.rel, fps_s, _dur(i.duration), i.width or 0, i.height or "?",
                     i.start_tc or "-", f"{i.audio_channels}ch" if i.has_audio else "NONE", flag)
            if i.fps != seq_fps:
                log.warning("%s runs at %s fps, sequence is %s fps — Premiere will conform it",
                            c.rel, fps_s, rate)
            if not i.has_audio:
                log.warning("%s has no audio: it can only be placed with a sync override", c.rel)

    expected = cfg.get("fps")
    if expected and abs(float(expected) - rate.float) > 0.01:
        log.warning("config fps is %s but the cameras are %s fps — the sequence uses the "
                    "cameras' %s fps", expected, rate, rate)
    log.info("Sequence frame rate: %s fps (from the cameras)", rate)

    log.info("Clean audio folder: %s", audio_dir)
    audio_files = clean_audio_files(audio_dir)
    audio = []
    log.info("Clean audio (%d files):", len(audio_files))
    for p in audio_files:
        info = probe(p)
        if not info.has_audio:
            log.warning("  skip %s: no audio stream", p.name)
            continue
        audio.append(info)
        log.info("  %-28s %s  %dch  %d Hz", p.name, _dur(info.duration),
                 info.audio_channels, info.sample_rate)
    durs = [a.duration for a in audio]
    if max(durs) - min(durs) > 1.0:
        log.warning("clean audio files differ in length by %.1fs — they are assumed to START "
                    "together; check that they come from one recorder", max(durs) - min(durs))
    return Project(root, cameras, audio, rate, cfg["long_camera"], audio_dir)


def _dur(sec: float) -> str:
    s = int(round(sec))
    return f"{s // 3600:d}:{s // 60 % 60:02d}:{s % 60:02d}"
