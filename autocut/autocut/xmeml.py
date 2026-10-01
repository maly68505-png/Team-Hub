"""Step 6 — Final Cut Pro 7 XML (xmeml v4) for Premiere Pro.

  V1        the rough cut
  V2..Vn    each camera, fully synced, one track per camera (locked, disabled)
  A1..An    the clean audio, one track per channel of each file

Synced only (no shots): V1..Vn the cameras, all enabled, nothing cut; A1..An the
clean audio, then one muted track per camera with its own audio (to check sync).

Layered (output.layered): no V1. V1..Vn are the cameras, each fully synced and
split wherever that camera goes on or off the cut: its shots enabled, the rest
disabled — one camera shows at a time. A cut moves with a rolling edit on the
two tracks, a shot changes camera by enabling another track's clip there.
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import quote

import numpy as np

from .cutlogic import Shot, _runs
from .log import log
from .probe import MediaInfo
from .scan import Project
from .timecode import Rate, frames_to_tc, tc_to_frames
from .timeline import Piece, TimeMap, Timeline

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
    def __init__(self, project: Project, tl: Timeline, cfg: dict, tm: TimeMap | None = None):
        self.p = project
        self.tl = tl
        self.tm = tm or TimeMap(tl.n)
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
    def _video(self, track, piece: Piece, name: str, label: str, enabled: bool) -> int:
        """Emit the kept parts of a piece (silence removal may split it)."""
        n = 0
        for s, e, skip in self.tm.split(piece.start, piece.end):
            self._video_item(track, Piece(piece.clip, s, e, piece.src_in + skip, piece.low),
                             name, label, enabled)
            n += 1
        return n

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

    def _audio_item(self, track, info: MediaInfo, channel: int, start: int, end: int, src_in: int,
                    enabled: bool = True, total: int | None = None):
        self.clip_n += 1
        ci = _sub(track, "clipitem", id=f"clipitem-{self.clip_n}")
        _sub(ci, "name", info.path.name if info.audio_channels == 1 else f"{info.path.name} ch{channel}")
        _sub(ci, "enabled", "TRUE" if enabled else "FALSE")
        if total is None:
            total = int(info.duration * self.rate.float)
        _sub(ci, "duration", total)
        _rate(ci, self.rate)
        _sub(ci, "start", start)
        _sub(ci, "end", end)
        _sub(ci, "in", src_in)
        _sub(ci, "out", src_in + end - start)
        self._file(ci, info, total, audio_only=not info.has_video)
        st = _sub(ci, "sourcetrack")
        _sub(st, "mediatype", "audio")
        _sub(st, "trackindex", channel)

    # --- document --------------------------------------------------------
    def build(self, shots: list[Shot] | None, name: str) -> ET.Element:
        tl, rate = self.tl, self.rate
        ocfg = self.cfg["output"]
        root = ET.Element("xmeml", version="4")
        seq = _sub(root, "sequence", id="sequence-1")
        _sub(seq, "name", name)
        _sub(seq, "duration", self.tm.total)
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

        if shots is None:
            self._cameras_only(video)
        elif ocfg.get("layered"):
            self._layers(video, shots)
        else:
            self._v1_and_cameras(video, shots)
        audio = self._audio(media)
        if shots is None:
            self._camera_audio(audio)
        return root

    def _cameras_only(self, video):
        tl = self.tl
        for cam in self.p.cameras:
            tr = _sub(video, "track")
            for piece in tl.pieces(cam, 0, tl.n):
                label = f"{'LOW-SYNC ' if piece.low else ''}{cam} | {piece.clip.path.name}"
                self._video(tr, piece, label, self.cam_label[cam], True)
            _sub(tr, "enabled", "TRUE")
            _sub(tr, "locked", "FALSE")
        log.info("XML (synced, no cut): V1..V%d cameras", len(self.p.cameras))

    def _camera_audio(self, audio):
        """One track per camera with its first audio channel, clips disabled:
        switch one on in Premiere to hear the camera mic against the clean audio."""
        tl = self.tl
        for cam in self.p.cameras:
            tr = _sub(audio, "track")
            for piece in tl.pieces(cam, 0, tl.n):
                info = piece.clip.info
                if not info.has_audio:
                    continue
                for s, e, skip in self.tm.split(piece.start, piece.end):
                    self._audio_item(tr, info, 1, s, e, piece.src_in + skip, enabled=False,
                                     total=tl.total_src_frames(piece.clip))
            _sub(tr, "enabled", "TRUE")
            _sub(tr, "locked", "FALSE")

    def _layers(self, video, shots: list[Shot]):
        tl = self.tl
        n_on = 0
        for cam in self.p.cameras:
            on = np.zeros(tl.n, bool)
            for s in shots:
                if s.camera == cam:
                    on[s.start:s.end] = True
            tr = _sub(video, "track")
            for piece in tl.pieces(cam, 0, tl.n):
                label = f"{'LOW-SYNC ' if piece.low else ''}{cam} | {piece.clip.path.name}"
                for a, b in _runs(on[piece.start:piece.end]):
                    sub = Piece(piece.clip, piece.start + a, piece.start + b, piece.src_in + a, piece.low)
                    enabled = bool(on[sub.start])
                    k = self._video(tr, sub, label, self.cam_label[cam], enabled)
                    n_on += k if enabled else 0
            _sub(tr, "enabled", "TRUE")
            _sub(tr, "locked", "FALSE")
        log.info("XML (layered): V1..V%d cameras, %d enabled shot clip(s)", len(self.p.cameras), n_on)

    def _v1_and_cameras(self, video, shots: list[Shot]):
        tl, ocfg = self.tl, self.cfg["output"]
        # V1 — rough cut
        v1 = _sub(video, "track")
        n_v1 = 0
        for shot in shots:
            if shot.camera is None:
                continue
            for piece in tl.pieces(shot.camera, shot.start, shot.end):
                n_v1 += self._video(v1, piece, f"{shot.camera} | {piece.clip.path.name}",
                                    self.cam_label[shot.camera], True)
        _sub(v1, "enabled", "TRUE")
        _sub(v1, "locked", "FALSE")

        # V2..Vn — every camera, synced
        cam_on = not ocfg["disable_camera_tracks"]
        for cam in self.p.cameras:
            tr = _sub(video, "track")
            for piece in tl.pieces(cam, 0, tl.n):
                label = f"{'LOW-SYNC ' if piece.low else ''}{cam} | {piece.clip.path.name}"
                self._video(tr, piece, label, self.cam_label[cam], cam_on)
            _sub(tr, "enabled", "TRUE" if cam_on else "FALSE")
            _sub(tr, "locked", "TRUE" if ocfg["lock_camera_tracks"] else "FALSE")
        log.info("XML: V1 %d clip(s), V2..V%d cameras", n_v1, 1 + len(self.p.cameras))

    def _audio(self, media):
        tl, rate = self.tl, self.rate

        # A1..An — clean audio (standard FCP7 layout: stereo output group, mono tracks)
        audio = _sub(media, "audio")
        _sub(audio, "numOutputChannels", 2)
        afmt = _sub(audio, "format")
        asc = _sub(afmt, "samplecharacteristics")
        _sub(asc, "depth", 16)
        _sub(asc, "samplerate", 48000)
        outs = _sub(audio, "outputs")
        grp = _sub(outs, "group")
        _sub(grp, "index", 1)
        _sub(grp, "numchannels", 2)
        _sub(grp, "downmix", 0)
        for i in (1, 2):
            _sub(_sub(grp, "channel"), "index", i)

        takes = self.p.takes or [_OneTake(self.p.audio)]
        slots = max(len(t.files) for t in takes)
        n_audio = 0
        for j in range(slots):
            chans = max(t.files[j].audio_channels for t in takes if j < len(t.files))
            for ch in range(1, max(1, chans) + 1):
                tr = _sub(audio, "track")
                for t in takes:
                    if j >= len(t.files) or ch > max(1, t.files[j].audio_channels):
                        continue
                    info = t.files[j]
                    total = int(info.duration * rate.float)
                    start_f = rate.frames(t.position - tl.t0)  # take start on the sequence
                    a, b = max(0, start_f), min(tl.n, start_f + total)
                    if b <= a:
                        continue
                    for s2, e2, skip in self.tm.split(a, b):
                        self._audio_item(tr, info, ch, s2, e2, a - start_f + skip)
                        n_audio += 1
                _sub(tr, "enabled", "TRUE")
                _sub(tr, "locked", "FALSE")
        if not n_audio:
            log.error("NO clean audio could be placed on the audio tracks — check the audio files")
        log.info("XML: A1..A%d clean audio", len(audio.findall("track")))
        return audio


class _OneTake:
    """All clean files as one take at position 0 (simultaneous tracks)."""

    def __init__(self, files):
        self.files, self.position = list(files), 0.0


def write(path: Path, project: Project, tl: Timeline, shots: list[Shot] | None, cfg: dict, name: str,
          tm: TimeMap | None = None) -> None:
    root = Writer(project, tl, cfg, tm).build(shots, name)
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    Path(path).write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + "\n",
                          encoding="utf-8")
