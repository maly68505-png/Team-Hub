"""Step 6 — Final Cut Pro 7 XML (xmeml v4) for Premiere Pro.

  V1        the rough cut
  V2..Vn    each camera, fully synced, one track per camera (locked, disabled)
  A1..An    the clean audio, one track per channel of each file
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

from .cutlogic import Shot
from .log import log
from .probe import MediaInfo
from .scan import Clip, Project
from .timecode import Rate, frames_to_tc, tc_to_frames
from .timeline import Piece, Timeline

LABELS = ["Iris", "Caribbean", "Lavender", "Forest", "Mango", "Cerulean", "Violet",
          "Magenta", "Teal", "Tan", "Blue", "Purple", "Green", "Brown", "Yellow"]
LOW_LABEL = "Rose"


def pathurl(p: Path) -> str:
    s = Path(p).resolve().as_posix()
    if not s.startswith("/"):
        s = "/" + s  # Windows: C:/x -> /C:/x
    return "file://localhost" + quote(s, safe="/")


def _sub(parent, tag, text=None, **attrs):
    el = ET.SubElement(parent, tag, {k: str(v) for k, v in attrs.items()})
    if text is not None:
        el.text = str(text)
    return el


def _rate(parent, rate: Rate):
    r = _sub(parent, "rate")
    _sub(r, "timebase", rate.timebase)
    _sub(r, "ntsc", "TRUE" if rate.ntsc else "FALSE")
    return r


def _timecode(parent, rate: Rate, frame: int):
    tc = _sub(parent, "timecode")
    _rate(tc, rate)
    _sub(tc, "string", frames_to_tc(frame, rate))
    _sub(tc, "frame", frame)
    _sub(tc, "displayformat", "NDF")
    return tc


class Writer:
    def __init__(self, project: Project, tl: Timeline, cfg: dict):
        self.p = project
        self.tl = tl
        self.rate = project.rate
        self.cfg = cfg
        self.files: dict[str, str] = {}
        self.clip_n = 0
        self.cam_label = {name: LABELS[i % len(LABELS)] for i, name in enumerate(project.cameras)}

    # --- <file> ----------------------------------------------------------
    def _file(self, parent, info: MediaInfo, total_frames: int, audio_only: bool = False):
        key = str(info.path.resolve())
        if key in self.files:
            _sub(parent, "file", id=self.files[key])
            return
        fid = f"file-{len(self.files) + 1}"
        self.files[key] = fid
        f = _sub(parent, "file", id=fid)
        _sub(f, "name", info.path.name)
        _sub(f, "pathurl", pathurl(info.path))
        _rate(f, self.rate)
        _sub(f, "duration", total_frames)
        start = 0
        if info.start_tc and not audio_only:
            try:
                start = tc_to_frames(info.start_tc, self.rate)
            except ValueError:
                start = 0
        _timecode(f, self.rate, start)
        media = _sub(f, "media")
        if info.has_video and not audio_only:
            v = _sub(media, "video")
            sc = _sub(v, "samplecharacteristics")
            _rate(sc, self.rate)
            _sub(sc, "width", info.width or 1920)
            _sub(sc, "height", info.height or 1080)
            _sub(sc, "anamorphic", "FALSE")
            _sub(sc, "pixelaspectratio", "square")
            _sub(sc, "fielddominance", "none")
        if info.has_audio:
            a = _sub(media, "audio")
            sc = _sub(a, "samplecharacteristics")
            _sub(sc, "depth", 16)
            _sub(sc, "samplerate", info.sample_rate or 48000)
            _sub(a, "channelcount", info.audio_channels)

    # --- clipitems -------------------------------------------------------
    def _video_item(self, track, piece: Piece, name: str, label: str, enabled: bool):
        self.clip_n += 1
        ci = _sub(track, "clipitem", id=f"clipitem-{self.clip_n}")
        _sub(ci, "name", name)
        _sub(ci, "enabled", "TRUE" if enabled else "FALSE")
        total = self.tl.total_src_frames(piece.clip)
        _sub(ci, "duration", total)
        _rate(ci, self.rate)
        _sub(ci, "start", piece.start)
        _sub(ci, "end", piece.end)
        _sub(ci, "in", piece.src_in)
        _sub(ci, "out", piece.src_in + (piece.end - piece.start))
        _sub(ci, "alphatype", "none")
        _sub(ci, "pixelaspectratio", "square")
        _sub(ci, "anamorphic", "FALSE")
        self._file(ci, piece.clip.info, total)
        labels = _sub(ci, "labels")
        _sub(labels, "label2", LOW_LABEL if piece.low else label)

    def _audio_item(self, track, info: MediaInfo, channel: int, start: int, end: int, src_in: int):
        self.clip_n += 1
        ci = _sub(track, "clipitem", id=f"clipitem-{self.clip_n}", premiereChannelType="mono")
        _sub(ci, "name", info.path.name if info.audio_channels == 1 else f"{info.path.name} ch{channel}")
        _sub(ci, "enabled", "TRUE")
        total = int(info.duration * self.rate.float)
        _sub(ci, "duration", total)
        _rate(ci, self.rate)
        _sub(ci, "start", start)
        _sub(ci, "end", end)
        _sub(ci, "in", src_in)
        _sub(ci, "out", src_in + end - start)
        self._file(ci, info, total, audio_only=True)
        st = _sub(ci, "sourcetrack")
        _sub(st, "mediatype", "audio")
        _sub(st, "trackindex", channel)

    # --- document --------------------------------------------------------
    def build(self, shots: list[Shot], name: str) -> ET.Element:
        tl, rate = self.tl, self.rate
        ocfg = self.cfg["output"]
        root = ET.Element("xmeml", version="4")
        seq = _sub(root, "sequence", id="sequence-1")
        _sub(seq, "name", name)
        _sub(seq, "duration", tl.n)
        _rate(seq, rate)
        _timecode(seq, rate, rate.frames(tl.t0))
        _sub(seq, "in", -1)
        _sub(seq, "out", -1)
        media = _sub(seq, "media")

        video = _sub(media, "video")
        fmt = _sub(video, "format")
        sc = _sub(fmt, "samplecharacteristics")
        _rate(sc, rate)
        long_clip = self.p.cameras[self.p.long_camera].clips[0].info
        _sub(sc, "width", long_clip.width or 1920)
        _sub(sc, "height", long_clip.height or 1080)
        _sub(sc, "anamorphic", "FALSE")
        _sub(sc, "pixelaspectratio", "square")
        _sub(sc, "fielddominance", "none")

        # V1 — rough cut
        v1 = _sub(video, "track")
        n_v1 = 0
        for shot in shots:
            if shot.camera is None:
                continue
            for piece in tl.pieces(shot.camera, shot.start, shot.end):
                self._video_item(v1, piece, f"{shot.camera} | {piece.clip.path.name}",
                                 self.cam_label[shot.camera], True)
                n_v1 += 1
        _sub(v1, "enabled", "TRUE")
        _sub(v1, "locked", "FALSE")

        # V2..Vn — every camera, synced
        cam_on = not ocfg["disable_camera_tracks"]
        for cam in self.p.cameras:
            tr = _sub(video, "track")
            for piece in tl.pieces(cam, 0, tl.n):
                label = f"{'LOW-SYNC ' if piece.low else ''}{cam} | {piece.clip.path.name}"
                self._video_item(tr, piece, label, self.cam_label[cam], cam_on)
            _sub(tr, "enabled", "TRUE" if cam_on else "FALSE")
            _sub(tr, "locked", "TRUE" if ocfg["lock_camera_tracks"] else "FALSE")

        # A1..An — clean audio
        audio = _sub(media, "audio")
        _sub(audio, "numOutputChannels", 2)
        afmt = _sub(audio, "format")
        asc = _sub(afmt, "samplecharacteristics")
        _sub(asc, "depth", 16)
        _sub(asc, "samplerate", 48000)
        seq_in = rate.frames(tl.t0)
        for info in self.p.audio:
            total = int(info.duration * rate.float)
            end = min(tl.n, total - seq_in)
            for ch in range(1, max(1, info.audio_channels) + 1):
                tr = _sub(audio, "track", premiereTrackType="Mono")
                if end > 0:
                    self._audio_item(tr, info, ch, 0, end, seq_in)
                _sub(tr, "enabled", "TRUE")
                _sub(tr, "locked", "FALSE")
        log.info("XML: V1 %d clip(s), V2..V%d cameras, A1..A%d clean audio",
                 n_v1, 1 + len(self.p.cameras), len(audio.findall("track")))
        return root


def write(path: Path, project: Project, tl: Timeline, shots: list[Shot], cfg: dict, name: str) -> None:
    root = Writer(project, tl, cfg).build(shots, name)
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    Path(path).write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + "\n",
                          encoding="utf-8")
