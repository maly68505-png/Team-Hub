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
AUDIO_EXT = {".wav", ".bwf", ".aif", ".aiff", ".flac", ".mp3", ".m4a", ".aac"}
WORK_DIR = "_autocut"


class ScanError(Exception):
    pass


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

    @property
    def workdir(self) -> Path:
        return self.root / WORK_DIR

    def all_clips(self) -> list[Clip]:
        return [c for cam in self.cameras.values() for c in cam.clips]


def natural_key(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def _files(folder: Path, exts: set[str]) -> list[Path]:
    return sorted((p for p in folder.iterdir()
                   if p.is_file() and not p.name.startswith(".") and p.suffix.lower() in exts),
                  key=lambda p: natural_key(p.name))


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


def scan(root: Path, cfg: dict) -> Project:
    root = Path(root).resolve()
    if not root.is_dir():
        raise ScanError(f"project folder not found: {root}")
    audio_name = cfg["audio_folder"]
    audio_dir = root / audio_name
    if not audio_dir.is_dir():
        raise ScanError(f"no '{audio_name}' folder with the clean audio in {root}")

    if cfg["cameras"]:
        cam_names = [str(c) for c in cfg["cameras"]]
        for n in cam_names:
            if not (root / n).is_dir():
                raise ScanError(f"camera folder listed in config not found: {root / n}")
    else:
        cam_names = sorted((p.name for p in root.iterdir()
                            if p.is_dir() and p.name not in (audio_name, WORK_DIR)
                            and not p.name.startswith(".")), key=natural_key)
    if cfg["long_camera"] not in cam_names:
        raise ScanError(f"long_camera '{cfg['long_camera']}' is not one of the camera folders: "
                        f"{', '.join(cam_names) or '(none)'}")
    if not 1 <= len(cam_names) <= 12:
        raise ScanError(f"found {len(cam_names)} camera folders — expected 1..12: {cam_names}")
    if not 4 <= len(cam_names) <= 7:
        log.warning("found %d cameras (expected 4-7) — continuing", len(cam_names))

    cameras: dict[str, Camera] = {}
    fps_votes: Counter = Counter()
    for name in cam_names:
        cam = Camera(name)
        files = _files(root / name, VIDEO_EXT)
        if not files:
            raise ScanError(f"camera folder '{name}' has no video files ({', '.join(sorted(VIDEO_EXT))})")
        for p in files:
            info = probe(p)
            if not info.has_video:
                log.warning("  skip %s/%s: no video stream", name, p.name)
                continue
            cam.clips.append(Clip(name, info, f"{name}/{p.name}"))
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

    audio_files = _files(audio_dir, AUDIO_EXT)
    if not audio_files:
        raise ScanError(f"no audio files in {audio_dir}")
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
    return Project(root, cameras, audio, rate, cfg["long_camera"])


def _dur(sec: float) -> str:
    s = int(round(sec))
    return f"{s // 3600:d}:{s // 60 % 60:02d}:{s % 60:02d}"
