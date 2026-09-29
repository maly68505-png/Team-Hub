"""ffprobe wrapper."""
from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

from .timecode import parse_rate


class ToolError(Exception):
    pass


def require_tools() -> None:
    missing = [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]
    if missing:
        raise ToolError(f"{', '.join(missing)} not found on PATH — install ffmpeg (see README)")


@dataclass
class MediaInfo:
    path: Path
    duration: float
    fps: Fraction | None = None
    start_tc: str | None = None
    width: int | None = None
    height: int | None = None
    has_video: bool = False
    has_audio: bool = False
    audio_channels: int = 0
    sample_rate: int = 0
    av_offset: float = 0.0  # audio stream start - video stream start (s)
    nb_frames: int | None = None


def _f(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def probe(path: Path) -> MediaInfo:
    path = Path(path)
    cmd = ["ffprobe", "-v", "error", "-print_format", "json",
           "-show_format", "-show_streams", str(path)]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise ToolError(f"ffprobe failed on {path}: {res.stderr.strip()}")
    data = json.loads(res.stdout)
    fmt = data.get("format", {})
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    duration = _f(fmt.get("duration"))
    if duration is None:
        duration = max((_f(s.get("duration"), 0.0) for s in streams), default=0.0)

    info = MediaInfo(path=path, duration=duration or 0.0)
    tc = None
    for s in ([video] if video else []) + streams:
        tc = tc or (s.get("tags") or {}).get("timecode")
    tc = tc or (fmt.get("tags") or {}).get("timecode")
    info.start_tc = tc

    if video:
        info.has_video = True
        info.fps = parse_rate(video.get("r_frame_rate")) or parse_rate(video.get("avg_frame_rate"))
        info.width = video.get("width")
        info.height = video.get("height")
        nb = video.get("nb_frames")
        info.nb_frames = int(nb) if nb and str(nb).isdigit() else None
        vdur = _f(video.get("duration"))
        if vdur:
            info.duration = vdur
    if audio:
        info.has_audio = True
        info.audio_channels = int(audio.get("channels") or 1)
        info.sample_rate = int(audio.get("sample_rate") or 0)
        if video:
            a0 = _f(audio.get("start_time"), 0.0)
            v0 = _f(video.get("start_time"), 0.0)
            info.av_offset = a0 - v0
    return info
