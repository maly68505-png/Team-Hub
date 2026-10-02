"""Media probing with PyAV (FFmpeg libraries bundled in the `av` package —
nothing to install separately, works offline inside the Mac app)."""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path

import av

from .timecode import tc_seconds


class ToolError(Exception):
    pass


def require_tools() -> None:
    """Kept for the pipeline's start-up check; PyAV ships its own FFmpeg."""
    try:
        av.library_versions  # noqa: B018
    except Exception as e:  # pragma: no cover
        raise ToolError(f"PyAV (FFmpeg) is not usable: {e}") from e


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
    tc_seconds: float | None = None  # timecode of the first frame / sample, seconds since midnight


def _seconds(value, time_base) -> float | None:
    if value is None or time_base is None:
        return None
    return float(value * time_base)


def probe(path: Path) -> MediaInfo:
    path = Path(path)
    try:
        c = av.open(str(path))
    except Exception as e:
        raise ToolError(f"cannot open {path}: {e}") from e
    with c:
        video = next((s for s in c.streams.video
                      if not (s.disposition & av.stream.Disposition.attached_pic)), None)
        audio = c.streams.audio[0] if c.streams.audio else None
        duration = c.duration / 1_000_000 if c.duration else 0.0
        info = MediaInfo(path=path, duration=duration)

        tc = None
        for s in ([video] if video else []) + list(c.streams.data) + list(c.streams):
            tc = tc or s.metadata.get("timecode")
        info.start_tc = tc or c.metadata.get("timecode")

        if video is not None:
            info.has_video = True
            rate = video.average_rate or video.guessed_rate or video.base_rate
            info.fps = Fraction(rate) if rate else None
            info.width = video.codec_context.width
            info.height = video.codec_context.height
            info.nb_frames = video.frames or None
            vdur = _seconds(video.duration, video.time_base)
            if vdur:
                info.duration = vdur
        if audio is not None:
            info.has_audio = True
            info.audio_channels = audio.codec_context.layout.nb_channels or 1
            info.sample_rate = audio.codec_context.sample_rate or 0
            if not info.duration:
                info.duration = _seconds(audio.duration, audio.time_base) or 0.0
            if video is not None:
                a0 = _seconds(audio.start_time, audio.time_base) or 0.0
                v0 = _seconds(video.start_time, video.time_base) or 0.0
                info.av_offset = a0 - v0
        tr = c.metadata.get("time_reference")  # BWF: samples since midnight
        if tr and info.sample_rate and not info.has_video:
            try:
                info.tc_seconds = int(tr) / info.sample_rate
            except ValueError:
                pass
        if info.tc_seconds is None and info.start_tc and info.fps:
            info.tc_seconds = tc_seconds(info.start_tc, info.fps)
        if info.duration <= 0:
            # some recorder WAVs (long BWF / RF64) carry no duration in the header:
            # measure it from the packets instead of treating the file as empty
            stream = audio if audio is not None else video
            if stream is not None:
                info.duration = demux_duration(c, stream)
    return info


def demux_duration(c, stream) -> float:
    total = 0
    for pkt in c.demux(stream):
        if pkt.duration:
            total += pkt.duration
    return float(total * stream.time_base) if stream.time_base else 0.0
