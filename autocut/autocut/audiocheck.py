"""Audio check: is every channel of every clean-audio file there, all the way?

Per file and per channel, in 5-minute blocks: talking (someone speaks on it),
quiet (signal, no speech), silent (no signal at all), or missing (past the
point where the file can be read). Also flags:
  - a file that decodes shorter than its own header says (decoding stopped);
  - a WAV that is bigger on disk than its header covers — usually a recording
    over 4 GB written as plain WAV: everything past the header's size is not
    read by FFmpeg, nor shown by Premiere;
  - a channel that goes silent while the others still talk (a mic that died);
  - a channel with no speech at all.

Writes <work>/output/audio_check.json for the app; levels are cached and reused
by the "speakers from mics" analysis.
"""
from __future__ import annotations

import json
import math
import re
from pathlib import Path

import av
import numpy as np

from .log import banner, log
from .mics import FLOOR_DB, HOP, channel_levels
from .probe import MediaInfo, ToolError
from .timecode import fmt_seconds

BLOCK = 300.0     # seconds per block
TALK_MIN = 0.02   # share of a block's frames above the speech threshold to count as talking
SILENT_DB = -85.0 # median level under this = no signal at all


def _pcm(info: MediaInfo) -> tuple[int, int, int] | None:
    """(bytes per sample, sample rate, channels) of an uncompressed file, else None."""
    try:
        with av.open(str(info.path)) as c:
            cc = c.streams.audio[0].codec_context
            m = re.match(r"pcm_[suf](\d+)", cc.name or "")
            if not m:
                return None
            return int(m.group(1)) // 8, cc.sample_rate, cc.layout.nb_channels
    except (av.error.FFmpegError, IndexError):
        return None


def check_file(info: MediaInfo, workdir: Path) -> dict:
    notes: list[dict] = []   # {"level": "error"|"warn", "en": ..., "ar": ...}
    errors: list[str] = []
    try:
        lv = channel_levels(info, workdir, errors)
    except ToolError as e:
        return {"name": info.path.name, "path": str(info.path), "error": str(e), "channels": [],
                "notes": [{"level": "error", "en": f"cannot be read: {e}", "ar": f"لا يمكن قراءة الملف: {e}"}]}
    read = lv.shape[1] * HOP
    header = info.duration
    on_disk = None
    pcm = _pcm(info)
    size = info.path.stat().st_size
    if pcm:
        bps, sr, nch = pcm
        on_disk = size / float(bps * sr * nch)       # seconds the file's bytes can hold
        if on_disk > header + 30:
            notes.append({"level": "error",
                          "en": f"the file holds about {fmt_seconds(on_disk)[:8]} of audio "
                                f"({size / 1e9:.1f} GB) but its header covers only {fmt_seconds(header)[:8]} — "
                                f"everything after {fmt_seconds(header)[:8]} is not read (nor shown in Premiere). "
                                f"Usually a recording over 4 GB saved as plain WAV: re-export it as RF64/BWF.",
                          "ar": f"الملف فيه تقريباً {fmt_seconds(on_disk)[:8]} صوت ({size / 1e9:.1f} جيجا) "
                                f"لكن رأس الملف يقول {fmt_seconds(header)[:8]} فقط — ما بعد ذلك لا يُقرأ "
                                f"(ولا يظهر في بريمير). غالباً تسجيل أكبر من 4 جيجا محفوظ كـ WAV عادي: "
                                f"أعد تصديره بصيغة RF64/BWF."})
    if errors or read < header - 2:
        notes.append({"level": "error",
                      "en": f"decoding stops at {fmt_seconds(read)[:8]} of {fmt_seconds(header)[:8]}"
                            + (f" ({errors[0]})" if errors else ""),
                      "ar": f"القراءة تتوقف عند {fmt_seconds(read)[:8]} من {fmt_seconds(header)[:8]}"})
    total = max(header, read, on_disk if on_disk and on_disk > header + 30 else 0.0)
    n_blocks = max(1, math.ceil((total - 1.0) / BLOCK))
    per_block = int(round(BLOCK / HOP))
    chans = []
    talk_by_block = np.zeros((lv.shape[0], n_blocks), bool)
    for ch in range(lv.shape[0]):
        row = lv[ch]
        valid = row[row > -100]
        floor = float(np.percentile(valid, 10)) if len(valid) else -120.0
        speech = float(np.percentile(valid, 99)) if len(valid) else -120.0
        has_speech = len(valid) > 0 and speech > -60 and speech - floor >= FLOOR_DB
        thr = floor + FLOOR_DB
        blocks = []
        for b in range(n_blocks):
            seg = row[b * per_block:(b + 1) * per_block]
            if len(seg) == 0:
                blocks.append({"s": "missing"})
                continue
            med = float(np.median(seg))
            talk = float(np.mean(seg > thr)) if has_speech else 0.0
            # no signal: digital silence, or only the mic's own hiss (a live lav hears the room)
            dead = med < SILENT_DB or (has_speech and float(np.percentile(seg, 95)) < floor + 4)
            state = "silent" if dead and talk < TALK_MIN else ("talk" if talk >= TALK_MIN else "quiet")
            talk_by_block[ch, b] = state == "talk"
            blocks.append({"s": state, "talk": round(talk * 100), "db": round(med, 1)})
        chans.append({"channel": ch + 1, "floor": round(floor, 1), "speech": round(speech, 1),
                      "has_speech": bool(has_speech), "blocks": blocks,
                      "talk_minutes": round(float(np.sum(row > thr)) * HOP / 60, 1) if has_speech else 0.0})
    for c in chans:
        k = c["channel"] - 1
        if not c["has_speech"]:
            notes.append({"level": "warn", "en": f"channel {c['channel']}: no speech anywhere",
                          "ar": f"القناة {c['channel']}: لا يوجد كلام عليها إطلاقاً"})
            continue
        others = np.delete(talk_by_block, k, axis=0).any(axis=0) if lv.shape[0] > 1 else np.ones(n_blocks, bool)
        dead = [b for b, x in enumerate(c["blocks"]) if x["s"] in ("silent", "missing") and others[b]]
        if dead and lv.shape[0] > 1:
            span = ", ".join(f"{fmt_seconds(b * BLOCK)[:8]}" for b in dead[:6]) + ("…" if len(dead) > 6 else "")
            notes.append({"level": "warn",
                          "en": f"channel {c['channel']}: no signal at {span} while other channels talk",
                          "ar": f"القناة {c['channel']}: بلا صوت عند {span} بينما القنوات الأخرى فيها كلام"})
    missing = [b for b in range(n_blocks) if all(c["blocks"][b]["s"] == "missing" for c in chans)]
    if missing and not any(n["level"] == "error" for n in notes):
        notes.append({"level": "error", "en": f"no audio read after {fmt_seconds(missing[0] * BLOCK)[:8]}",
                      "ar": f"لا يُقرأ أي صوت بعد {fmt_seconds(missing[0] * BLOCK)[:8]}"})
    return {"name": info.path.name, "path": str(info.path), "duration": round(header, 1),
            "read": round(read, 1), "on_disk": round(on_disk, 1) if on_disk else None,
            "size_gb": round(size / 1e9, 2), "channels": chans, "notes": notes}


STRIP = {"talk": "█", "quiet": "·", "silent": "_", "missing": "x"}


def run_check(files: list[MediaInfo], workdir: Path, out_dir: Path) -> int:
    banner("Audio check: every channel, every 5 minutes")
    out = {"block": BLOCK, "files": []}
    bad = 0
    for info in files:
        log.info("Checking %s (%d channel(s), %s) ...", info.path.name, info.audio_channels,
                 fmt_seconds(info.duration))
        r = check_file(info, workdir)
        out["files"].append(r)
        for c in r["channels"]:
            log.info("  ch%-2d %s  talk %5.1f min", c["channel"],
                     "".join(STRIP[b["s"]] for b in c["blocks"]), c["talk_minutes"])
        for n in r["notes"]:
            (log.error if n["level"] == "error" else log.warning)("  %s", n["en"])
            bad += n["level"] == "error"
    log.info("Legend: █ talking  · quiet  _ no signal  x not readable  (one mark = 5 min)")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "audio_check.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("Audio check: %s", "PROBLEMS FOUND — see above" if bad else "all files read to the end")
    return 0
