"""Rough cut of a sequence that is already synced (Final Cut Pro 7 XML from Premiere).

In Premiere: select the synced sequence, File > Export > Final Cut Pro XML.
Every video track holding clips is one camera (named after the clips' folder).
The sequence's audio — the audio-only files when there are any (the clean
recorder), otherwise everything — is mixed for speaker detection, and the cut
is planned exactly as for a shoot folder.

The output is a COPY of the sequence with the cut in it; nothing else is
re-synced or moved:
  layered (output.layered)  each camera track split at the cuts, only its shots enabled
  otherwise                 a new top video track with the cut; camera tracks disabled
Silence removal and test segments re-time every track (video, all audio) together.
"""
from __future__ import annotations

import copy
import csv
import json
import re
import time
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from urllib.parse import unquote, urlparse

import numpy as np
from scipy.io import wavfile

from .audio import DIARIZE_RATE, Reference, decode_windows, fingerprint
from .cutlogic import Shot, _runs, breakdown, plan_cuts, silence_frames, summarize
from .diarize import clip_segments, diarize
from .log import banner, log
from .probe import MediaInfo, ToolError, probe
from .scan import WORK_DIR, ScanError
from .timecode import Rate, fmt_seconds, frames_to_tc, parse_time
from .timeline import TimeMap

PPRO_TICKS = 254016000000  # Premiere ticks per second


def is_xml(path) -> bool:
    p = Path(path)
    return p.suffix.lower() == ".xml" and p.is_file()


def workdir_for(xml_path: Path) -> Path:
    """<folder of the XML>/_autocut/xml-<name>: one per XML, next to it."""
    xml_path = Path(xml_path).resolve()
    return xml_path.parent / WORK_DIR / f"xml-{xml_path.stem}"


@dataclass
class Item:
    el: ET.Element
    start: int          # sequence frames, -1 already resolved
    end: int
    src_in: int
    file_id: str | None
    enabled: bool


def _int(el, tag, default=0) -> int:
    x = el.find(tag)
    try:
        return int(float(x.text)) if x is not None and x.text else default
    except ValueError:
        return default


def _rate_of(el) -> Rate | None:
    r = el.find("rate")
    if r is None or r.find("timebase") is None:
        return None
    tb = int(r.find("timebase").text)
    ntsc = (r.findtext("ntsc") or "FALSE").strip().upper() == "TRUE"
    return Rate(Fraction(tb * 1000, 1001) if ntsc else Fraction(tb))


def _path(pathurl: str) -> Path:
    u = urlparse(pathurl)
    p = unquote(u.path if u.scheme == "file" else pathurl)
    if len(p) > 3 and p[0] == "/" and p[2] == ":":  # /C:/... (Windows)
        p = p[1:]
    return Path(p)


def _find_sequence(root: ET.Element) -> ET.Element:
    seq = root.find("sequence")
    if seq is None:
        seq = root.find("project/children/sequence")
    if seq is None:
        seq = root.find(".//sequence")
    if seq is None or seq.find("media") is None:
        raise ScanError("no sequence in this XML — export it from Premiere with "
                        "File > Export > Final Cut Pro XML",
                        "ملف XML لا يحتوي على تسلسل — صدّره من بريمير: File > Export > Final Cut Pro XML")
    return seq


def _items(track: ET.Element) -> list[Item]:
    """Clip items of a track with transition-adjacent -1 starts/ends resolved."""
    kids = list(track)
    out = []
    for k, el in enumerate(kids):
        if el.tag not in ("clipitem", "generatoritem"):
            continue
        s, e = _int(el, "start", -1), _int(el, "end", -1)
        if s < 0:  # incoming clip of a transition: starts where the transition starts
            prev = next((x for x in reversed(kids[:k]) if x.tag == "transitionitem"), None)
            s = _int(prev, "start", -1) if prev is not None else -1
        if e < 0:  # outgoing clip: ends where the next transition ends
            nxt = next((x for x in kids[k + 1:] if x.tag == "transitionitem"), None)
            e = _int(nxt, "end", -1) if nxt is not None else -1
        if s < 0 or e <= s:
            continue
        f = el.find("file")
        en = (el.findtext("enabled") or "TRUE").strip().upper() != "FALSE"
        out.append(Item(el, s, e, _int(el, "in", 0), f.get("id") if f is not None else None, en))
    return out


class SyncedSequence:
    """The parsed XML: cameras (video tracks), audio for diarization, files."""

    def __init__(self, path: Path):
        self.path = Path(path).resolve()
        try:
            self.tree = ET.parse(self.path)
        except ET.ParseError as e:
            raise ScanError(f"not a readable XML file: {e}", f"ملف XML غير صالح: {e}") from e
        self.root = self.tree.getroot()
        self.seq = _find_sequence(self.root)
        self.name = self.seq.findtext("name") or self.path.stem
        rate = _rate_of(self.seq)
        if rate is None:
            raise ScanError("the sequence has no frame rate", "التسلسل بلا معدل إطارات")
        self.rate = rate
        # full <file> definitions by id (later references are <file id="..."/>)
        self.files: dict[str, ET.Element] = {}
        for f in self.root.iter("file"):
            if f.get("id") and len(f) and f.get("id") not in self.files:
                self.files[f.get("id")] = f
        self.video_tracks = self.seq.findall("media/video/track")
        self.audio_tracks = self.seq.findall("media/audio/track")
        self.n = max([_int(self.seq, "duration", 0)] +
                     [it.end for tr in self.video_tracks + self.audio_tracks for it in _items(tr)])
        tc = self.seq.find("timecode")
        self.tc_start = _int(tc, "frame", 0) if tc is not None else 0

        # cameras: one per video track that holds media clips
        self.cameras: dict[str, int] = {}
        names = []
        for i, tr in enumerate(self.video_tracks):
            folders = [self.file_path(it.file_id).parent.name for it in _items(tr)
                       if it.file_id and self.file_path(it.file_id) and self.has_video(it.file_id)]
            if folders:
                names.append((i, Counter(folders).most_common(1)[0][0] or f"V{i + 1}"))
        counts = Counter(n for _, n in names)
        for i, n in names:
            self.cameras[n if counts[n] == 1 else f"{n} (V{i + 1})"] = i
        if not self.cameras:
            raise ScanError("no video clips on the sequence's tracks",
                            "لا توجد مقاطع فيديو على مسارات التسلسل")

    # --- files -----------------------------------------------------------
    def file_path(self, fid: str | None) -> Path | None:
        f = self.files.get(fid or "")
        url = f.findtext("pathurl") if f is not None else None
        return _path(url) if url else None

    def has_video(self, fid: str) -> bool:
        f = self.files.get(fid)
        return f is not None and f.find("media/video") is not None

    # --- what the cut needs ------------------------------------------------
    def coverage(self) -> dict[str, np.ndarray]:
        cov = {}
        track_on = [(tr.findtext("enabled") or "TRUE").upper() != "FALSE" for tr in self.video_tracks]
        for cam, i in self.cameras.items():
            c = np.zeros(self.n, bool)
            if track_on[i]:
                for it in _items(self.video_tracks[i]):
                    if it.enabled and it.file_id:
                        c[it.start:it.end] = True
            cov[cam] = c
        return cov

    def speech_items(self) -> list[Item]:
        """Audio clips to listen to: the audio-only files if there are any."""
        items = []
        for tr in self.audio_tracks:
            if (tr.findtext("enabled") or "TRUE").upper() == "FALSE":
                continue
            items += [it for it in _items(tr) if it.enabled and self.file_path(it.file_id)]
        clean = [it for it in items if not self.has_video(it.file_id)]
        return clean or items

    def describe(self) -> dict:
        cov = self.coverage()
        fps = self.rate.float
        sp = self.speech_items()
        return {
            "name": self.name, "fps": str(self.rate), "duration": round(self.n / fps, 2),
            "cameras": [{"name": cam, "track": i + 1,
                         "clips": len([it for it in _items(self.video_tracks[i]) if it.file_id]),
                         "covered": round(float(cov[cam].sum()) / fps, 2)}
                        for cam, i in self.cameras.items()],
            "audio": sorted({self.file_path(it.file_id).name for it in sp}),
            "audio_clean": bool(sp) and not any(self.has_video(it.file_id) for it in sp),
            "missing": sorted({str(p) for p in (self.file_path(it.file_id) for it in sp) if not p.exists()})[:10],
        }

    def speech_channels(self) -> int:
        """Most channels among the (reachable) speech files: >2 = a multitrack recorder."""
        n = 0
        for p in {self.file_path(it.file_id) for it in self.speech_items()}:
            if p.exists():
                try:
                    n = max(n, probe(p).audio_channels)
                except ToolError:
                    pass
        return n

    def mic_segments(self, workdir: Path, dcfg: dict, mix_channel: int | None):
        """diarization.method mics: each speech file's mic channels, where the clip sits."""
        from . import mics
        fps = self.rate.float
        tl = mics.Timeline(self.n / fps)
        infos: dict[Path, MediaInfo] = {}
        levels: dict[Path, np.ndarray] = {}
        seen = set()
        clean = {id(it.el) for it in self.speech_items()}
        for ti, tr in enumerate(self.audio_tracks):
            for it in _items(tr):
                p = self.file_path(it.file_id)
                key = (it.file_id, it.start, it.end, it.src_in)
                if id(it.el) not in clean or key in seen or not p or not p.exists():
                    continue
                seen.add(key)
                info = infos.get(p) or infos.setdefault(p, probe(p))
                if not info.has_audio:
                    continue
                chans = mics.mic_channels(info, dcfg, mix_channel)
                if not chans:
                    continue
                if p not in levels:
                    log.info("Mic levels: %s (channels %s)", p.name, ", ".join(map(str, chans)))
                    levels[p] = mics.channel_levels(info, workdir)
                irate = _rate_of(it.el) or self.rate
                src = max(0.0, it.src_in / irate.float - info.av_offset)
                split_ch = re.search(r"_ch(\d+)$", p.stem)  # a mono copy made by autocut (split.py)
                if info.audio_channels == 1 and split_ch:
                    if int(split_ch.group(1)) == mix_channel or (
                            dcfg.get("mic_channels") and int(split_ch.group(1)) not in dcfg["mic_channels"]):
                        continue
                for ch in chans:
                    if ch <= levels[p].shape[0]:
                        label = (f"MIC {ch}" if info.audio_channels > 1 else
                                 f"MIC {split_ch.group(1)}" if split_ch else f"MIC A{ti + 1}")
                        tl.place(label, levels[p][ch - 1], it.start / fps, src, (it.end - it.start) / fps)
        return mics._finish(tl, dcfg)

    def reference(self, workdir: Path, channel: int | None = None) -> Reference:
        """The sequence's audio mixed to mono at 16 kHz (diarization + silences);
        `channel`: only that channel of each file (a recorder's mix)."""
        sp = self.speech_items()
        if not sp:
            raise ScanError("no audio clips on the sequence", "لا يوجد صوت على مسارات التسلسل")
        fps = self.rate.float
        seen, todo = set(), []
        for it in sp:
            key = (it.file_id, it.start, it.end, it.src_in)  # channels of one file: read once
            if key not in seen:
                seen.add(key)
                todo.append(it)
        paths = sorted({self.file_path(it.file_id) for it in todo})
        missing = [p for p in paths if not p.exists()]
        if missing:
            raise ScanError(f"audio files of the sequence not found (drive not connected?): "
                            f"{', '.join(str(p) for p in missing[:5])}",
                            "ملفات الصوت في التسلسل غير موجودة (الهارد غير موصّل؟): "
                            + "، ".join(str(p) for p in missing[:5]))
        layout = json.dumps([(str(self.file_path(it.file_id)), it.start, it.end, it.src_in) for it in todo])
        fp = fingerprint(paths, f"xml|ch{channel or 'all'}|" + layout)
        wav = workdir / "reference_16k.wav"
        npy = workdir / f"reference_{fp}.npy"
        if npy.exists() and wav.exists():
            log.info("Sequence audio: cached mix (%s)", npy.name)
            return Reference(np.load(npy), DIARIZE_RATE, wav, fp)
        log.info("Mixing the sequence audio: %d clip(s) from %d file(s)%s", len(todo), len(paths),
                 "" if all(not self.has_video(it.file_id) for it in todo)
                 else " (camera audio — no audio-only clips found)")
        sr = DIARIZE_RATE
        x = np.zeros(int(self.n / fps * sr) + sr, np.float32)
        infos: dict[Path, MediaInfo] = {}
        for k, it in enumerate(todo, 1):
            p = self.file_path(it.file_id)
            info = infos.get(p) or infos.setdefault(p, probe(p))
            if not info.has_audio:
                continue
            irate = _rate_of(it.el) or self.rate
            src = max(0.0, it.src_in / irate.float - info.av_offset)
            length = (it.end - it.start) / fps
            try:
                y = decode_windows(info, sr, [src], length, channel)[0]
            except ToolError as e:
                log.warning("skipped %s: %s", p.name, e)
                continue
            a = int(round(it.start / fps * sr))
            y = y[:max(0, len(x) - a)]
            x[a:a + len(y)] += y
            if k % 10 == 0 or k == len(todo):
                log.info("  [%d/%d] %s", k, len(todo), p.name)
        x = x[:int(self.n / fps * sr)]
        peak = float(np.max(np.abs(x))) if len(x) else 0.0
        if peak > 0:
            x *= 0.9 / peak
        workdir.mkdir(parents=True, exist_ok=True)
        wavfile.write(wav, sr, (x * 32767).astype(np.int16))
        np.save(npy, x)
        return Reference(x, sr, wav, fp)


# --- writing ---------------------------------------------------------------

def _set(el: ET.Element, tag: str, value) -> None:
    x = el.find(tag)
    if x is None:
        x = ET.SubElement(el, tag)
    x.text = str(value)


class _Retimer:
    """Copies clip items into the new sequence: only the part inside the
    working window, cut to `ranges`, through the silence TimeMap."""

    def __init__(self, f0: int, n: int, tm: TimeMap):
        self.f0, self.n, self.tm = f0, n, tm
        self.k = 0

    def pieces(self, it: Item, ranges) -> list[tuple[int, int, int, bool | None]]:
        a, b = max(it.start, self.f0) - self.f0, min(it.end, self.f0 + self.n) - self.f0
        base = it.src_in + max(it.start, self.f0) - it.start  # source frame at window frame a
        out = []
        for ra, rb, flag in ranges:
            lo, hi = max(a, ra), min(b, rb)
            if hi <= lo:
                continue
            for s, e, skip in self.tm.split(lo, hi):
                out.append((s, e, base + (lo - a) + skip, flag))
        return out

    @staticmethod
    def _ticks(c: ET.Element, src_in: int, src_out: int) -> None:
        """Premiere's own in/out (pproTicksIn/Out) win over in/out on import: keep them equal."""
        if c.find("pproTicksIn") is None and c.find("pproTicksOut") is None:
            return
        r = _rate_of(c)
        if r is None:
            for x in c.findall("pproTicksIn") + c.findall("pproTicksOut"):
                c.remove(x)
            return
        _set(c, "pproTicksIn", int(round(src_in * PPRO_TICKS / r.fps)))
        _set(c, "pproTicksOut", int(round(src_out * PPRO_TICKS / r.fps)))

    def emit(self, it: Item, ranges, copy_always: bool = False) -> list[ET.Element]:
        ps = self.pieces(it, ranges)
        whole = (not copy_always and len(ps) == 1 and ps[0][:3] == (it.start, it.end, it.src_in)
                 and _int(it.el, "start", -1) >= 0 and _int(it.el, "end", -1) >= 0)
        if whole:  # not cut: the original item, keeping its id and links
            if ps[0][3] is not None:
                _set(it.el, "enabled", "TRUE" if ps[0][3] and it.enabled else "FALSE")
            return [it.el]
        out = []
        for s, e, src, flag in ps:
            c = copy.deepcopy(it.el)
            self.k += 1
            c.set("id", f"{it.el.get('id') or 'clipitem'}-ac{self.k}")
            for ln in c.findall("link"):
                c.remove(ln)
            _set(c, "start", s)
            _set(c, "end", e)
            _set(c, "in", src)
            _set(c, "out", src + e - s)
            self._ticks(c, src, src + e - s)
            if flag is not None:
                _set(c, "enabled", "TRUE" if flag and it.enabled else "FALSE")
            out.append(c)
        return out


def _rebuild(track: ET.Element, items: list[ET.Element]) -> None:
    rest = [x for x in track if x.tag not in ("clipitem", "generatoritem", "transitionitem")]
    for x in list(track):
        track.remove(x)
    for x in items + rest:
        track.append(x)


def _fix_files_and_links(root: ET.Element, defs: dict[str, ET.Element]) -> None:
    """First <file> of each id carries the full definition, the others refer to
    it; links to clip items that no longer exist are dropped."""
    seen = set()
    for f in list(root.iter("file")):
        fid = f.get("id")
        if not fid or fid not in defs:
            continue
        for x in list(f):
            f.remove(x)
        if fid not in seen:
            seen.add(fid)
            for x in defs[fid]:
                f.append(copy.deepcopy(x))
    ids = {c.get("id") for c in root.iter("clipitem")}
    for parent in list(root.iter("clipitem")):
        for ln in parent.findall("link"):
            if ln.findtext("linkclipref") not in ids:
                parent.remove(ln)


def write_cut(sq: SyncedSequence, shots: list[Shot], f0: int, n: int, tm: TimeMap,
              cfg: dict, name: str, path: Path) -> None:
    root = copy.deepcopy(sq.root)
    seq = _find_sequence(root)
    # the copy's tracks, in the same order as the parsed ones
    vtracks = seq.findall("media/video/track")
    atracks = seq.findall("media/audio/track")
    defs = {fid: copy.deepcopy(f) for fid, f in sq.files.items()}
    rt = _Retimer(f0, n, tm)
    layered = bool(cfg["output"]["layered"])
    ocfg = cfg["output"]
    cam_of_track = {i: cam for cam, i in sq.cameras.items()}
    retimed = f0 > 0 or n < sq.n or tm.removed > 0
    dropped = 0

    cut_items: list[ET.Element] = []
    for i, tr in enumerate(vtracks):
        cam = cam_of_track.get(i)
        items = _items(tr)
        if cam is not None and not layered:
            # the cut: this camera's shots, on a new track
            ranges = [(s.start, s.end, True) for s in shots if s.camera == cam]
            for it in items:
                if it.file_id:
                    cut_items += rt.emit(it, ranges, copy_always=True)
        if cam is None:
            ranges = [(0, n, None)]
        elif layered:
            on = np.zeros(n, bool)
            for s in shots:
                if s.camera == cam:
                    on[s.start:s.end] = True
            ranges = [(a, b, bool(on[a])) for a, b in _runs(on)]
        else:
            ranges = [(0, n, not ocfg["disable_camera_tracks"])]
        new = [c for it in items for c in rt.emit(it, ranges)]
        dropped += sum(1 for x in tr if x.tag == "transitionitem")
        _rebuild(tr, new)
        if cam is not None and not layered:
            _set(tr, "enabled", "FALSE" if ocfg["disable_camera_tracks"] else "TRUE")
            _set(tr, "locked", "TRUE" if ocfg["lock_camera_tracks"] else "FALSE")
    for tr in atracks:
        new = [c for it in _items(tr) for c in rt.emit(it, [(0, n, None)])]
        dropped += sum(1 for x in tr if x.tag == "transitionitem")
        _rebuild(tr, new)

    if not layered:
        # Premiere shows the highest video track: the cut goes on top
        video = seq.find("media/video")
        tr = ET.SubElement(video, "track")
        for c in sorted(cut_items, key=lambda c: _int(c, "start")):
            _set(c, "enabled", "TRUE")
            tr.append(c)
        _set(tr, "enabled", "TRUE")
        _set(tr, "locked", "FALSE")
    if dropped:
        log.warning("%d transition(s) dropped (the clips stay, as straight cuts)", dropped)

    _set(seq, "name", name)
    _set(seq, "duration", tm.total)
    for tag in ("uuid",):  # a new sequence, not a replacement of the original
        for x in seq.findall(tag):
            seq.remove(x)
    tc = seq.find("timecode")
    if tc is not None and retimed:
        _set(tc, "frame", sq.tc_start + f0)
        _set(tc, "string", frames_to_tc(sq.tc_start + f0, sq.rate))
    _fix_files_and_links(root, defs)
    ET.indent(root, space="  ")
    body = ET.tostring(root, encoding="unicode")
    path.write_text('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n' + body + "\n",
                    encoding="utf-8")
    log.info("XML: %s cut on %s", "layered" if layered else "a new top track",
             f"{len(sq.cameras)} camera track(s)")


def write_cuts_csv(path: Path, shots: list[Shot], rate: Rate, base: int, tm: TimeMap) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.writer(fh)
        w.writerow(["timecode", "camera", "speaker", "reason", "timecode_out", "duration_s",
                    "recording_timecode"])
        for s in shots:
            parts = tm.split(s.start, s.end)
            if not parts:
                continue
            a, b = parts[0][0], parts[-1][1]
            w.writerow([frames_to_tc(base + a, rate), s.camera or "(gap)", s.speaker, s.reason,
                        frames_to_tc(base + b, rate),
                        f"{sum(e - x for x, e, _ in parts) / rate.float:.2f}",
                        frames_to_tc(base + s.start, rate)])


def run_xml(xml_path: Path, cfg: dict, until: str, start: str | None, duration: str | None,
            rttm: Path | None, diarize_full: bool) -> int:
    from .pipeline import (EXIT_ERROR, EXIT_OK, _test_name, _test_suffix, check_speakers,
                           silence_map, speaker_cameras)
    workdir = workdir_for(xml_path)
    banner("1. Read the synced sequence (XML)")
    sq = SyncedSequence(xml_path)
    rate = sq.rate
    d = sq.describe()
    log.info("Sequence \"%s\": %s fps, %s", d["name"], d["fps"], fmt_seconds(d["duration"]))
    for c in d["cameras"]:
        log.info("  V%-2d %-24s %3d clip(s), %s with picture", c["track"], c["name"], c["clips"],
                 fmt_seconds(c["covered"]))
    log.info("  Audio for speaker detection: %s%s", ", ".join(d["audio"][:6]) or "(none)",
             "" if d["audio_clean"] else "  (camera audio)")
    cams = list(sq.cameras)
    long_cam = cfg.get("long_camera")
    if long_cam not in cams:
        cov = sq.coverage()
        long_cam = max(cams, key=lambda c: cov[c].sum())
        log.info("Wide camera: %s (the one with the most picture — set long_camera to change)", long_cam)
    if until == "check":
        from . import audiocheck
        paths = sorted({sq.file_path(it.file_id) for it in sq.speech_items()})
        return audiocheck.run_check([probe(p) for p in paths if p.exists()], workdir, workdir / "output")
    if until in ("scan", "sync"):
        return EXIT_OK

    ref = sq.reference(workdir, cfg.get("audio_channel"))
    total = sq.n / rate.float
    t0 = parse_time(start, rate) if start else 0.0
    if t0 >= total:
        log.error("--start %s is past the end of the sequence (%s)", fmt_seconds(t0), fmt_seconds(total))
        return EXIT_ERROR
    t1 = min(total, t0 + parse_time(duration, rate)) if duration else total
    window = (t0, t1)
    is_test = t0 > 0.01 or t1 < total - 0.01
    f0, n = rate.frames(t0), rate.frames(t1 - t0)
    log.info("Working range: %s -> %s%s", fmt_seconds(t0), fmt_seconds(t1),
             "  [TEST SEGMENT]" if is_test else "  [FULL]")

    if cfg["diarization"]["method"] == "mics" and not rttm:
        banner("2. Speakers from the recorder's mic channels")
        segs = sq.mic_segments(workdir, cfg["diarization"], cfg.get("audio_channel"))
    else:
        banner("2. Diarization")
        segs = diarize(ref.wav16k, ref.fp, ref.duration, window, cfg["diarization"], workdir, rttm, diarize_full)
    code = check_speakers(segs, cams, cfg, workdir, ref.wav16k, rate)
    if code is not None:
        return code
    if until == "diarize":
        return EXIT_OK

    banner("3. Cut")
    coverage = {c: v[f0:f0 + n] for c, v in sq.coverage().items()}
    coverage = {c: np.pad(v, (0, n - len(v))) for c, v in coverage.items()}
    quiet = silence_frames(ref.x, ref.rate, window, rate)
    shots = plan_cuts(clip_segments(segs, t0, t1), window, rate, speaker_cameras(cfg["speakers"], long_cam),
                      cams, long_cam, coverage, cfg["cut"], quiet)
    summarize(shots, rate)
    cc = cfg["cut"]
    tm = silence_map(n, segs, window, rate, quiet, cc)

    banner("4. Output")
    out_dir = workdir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    suffix = (_test_suffix(t0, t1) if is_test else "") + ("_tight" if cc["remove_silence"] else "")
    layered = bool(cfg["output"]["layered"])
    suffix += "_layers" if layered else ""
    xml_p = out_dir / f"roughcut{suffix}.xml"
    csv_p = out_dir / f"cuts{suffix}.csv"
    name = f"{sq.name} autocut" + (_test_name(t0, t1) if is_test else " FULL") + (
        " no-silence" if cc["remove_silence"] else "") + (" layers" if layered else "") + time.strftime(" %H.%M")
    write_cut(sq, shots, f0, n, tm, cfg, name, xml_p)
    write_cuts_csv(csv_p, shots, rate, sq.tc_start + f0, tm)
    summary = dict(breakdown(shots, rate), full=not is_test, sequence=name, xml=xml_p.name,
                   length=round(tm.total / rate.float, 1), removed=round(tm.removed / rate.float, 1))
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("Premiere XML: %s", xml_p)
    log.info("Cut list:     %s", csv_p)
    log.info("In Premiere: File > Import > %s", xml_p.name)
    return EXIT_OK
