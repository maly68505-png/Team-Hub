"""Step 4 — speaker diarization of the clean reference (pyannote.audio), cached.

Speaker labels (SPEAKER_00 ...) are only stable within ONE diarization run.
So the whole reference is diarized once and cached; a test segment reuses
that full result when it exists. If it does not, only the segment is
diarized (fast) and you are warned that the labels may be numbered
differently in the full run.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.io import wavfile

from .log import log
from .timecode import Rate, fmt_seconds, frames_to_tc


class DiarizationError(Exception):
    pass


@dataclass
class Segment:
    start: float
    end: float
    speaker: str

    @property
    def duration(self) -> float:
        return self.end - self.start


def read_rttm(path: Path) -> list[Segment]:
    segs = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) >= 8 and parts[0] == "SPEAKER":
            s, d = float(parts[3]), float(parts[4])
            segs.append(Segment(s, s + d, parts[7]))
    segs.sort(key=lambda x: (x.start, x.end))
    return segs


def write_rttm(path: Path, segs: list[Segment], uri: str = "reference") -> None:
    with open(path, "w", encoding="utf-8") as fh:
        for s in segs:
            fh.write(f"SPEAKER {uri} 1 {s.start:.3f} {s.duration:.3f} <NA> <NA> {s.speaker} <NA> <NA>\n")


def clip_segments(segs: list[Segment], t0: float, t1: float) -> list[Segment]:
    return [Segment(max(s.start, t0), min(s.end, t1), s.speaker)
            for s in segs if s.end > t0 and s.start < t1]


def _key(ref_fp: str, dcfg: dict, t0: float, t1: float | None) -> str:
    parts = [ref_fp, dcfg["model"], str(dcfg["num_speakers"]), str(dcfg["min_speakers"]),
             str(dcfg["max_speakers"]), f"{t0:.3f}", "end" if t1 is None else f"{t1:.3f}"]
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:16]


def _run_pyannote(wav16k: Path, t0: float, t1: float | None, dcfg: dict) -> list[Segment]:
    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError as e:
        raise DiarizationError(
            f"pyannote.audio is not installed ({e}). Install it (see README) or pass "
            f"--rttm FILE with a diarization made elsewhere.") from e
    token = os.environ.get(dcfg["hf_token_env"])
    if not token:
        raise DiarizationError(
            f"environment variable {dcfg['hf_token_env']} is not set. Create a Hugging Face "
            f"token, accept the conditions of {dcfg['model']} on huggingface.co, then "
            f"export {dcfg['hf_token_env']}=hf_...  (see README)")
    log.info("Loading %s ...", dcfg["model"])
    try:
        pipe = Pipeline.from_pretrained(dcfg["model"], token=token)          # pyannote >= 4
    except TypeError:
        pipe = Pipeline.from_pretrained(dcfg["model"], use_auth_token=token)  # pyannote 3.x
    if pipe is None:
        raise DiarizationError(
            f"could not load {dcfg['model']} — accept its user conditions on huggingface.co "
            f"with the account that owns the token")
    if torch.cuda.is_available():
        pipe.to(torch.device("cuda"))
        log.info("Diarization on CUDA GPU")
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        pipe.to(torch.device("mps"))
        log.info("Diarization on Apple GPU (mps)")
    else:
        log.info("Diarization on CPU — a 2 h file can take a long while; the result is cached")

    sr, x = wavfile.read(wav16k)
    a = int(t0 * sr)
    b = len(x) if t1 is None else min(len(x), int(t1 * sr))
    wav = torch.from_numpy(x[a:b].astype(np.float32) / 32768.0)[None, :]
    kwargs = {k: dcfg[k] for k in ("num_speakers", "min_speakers", "max_speakers") if dcfg[k]}
    started = time.time()
    try:
        from pyannote.audio.pipelines.utils.hook import ProgressHook
        with ProgressHook() as hook:
            out = pipe({"waveform": wav, "sample_rate": sr}, hook=hook, **kwargs)
    except ImportError:
        out = pipe({"waveform": wav, "sample_rate": sr}, **kwargs)
    ann = getattr(out, "speaker_diarization", out)  # pyannote 4 returns DiarizeOutput
    segs = [Segment(t0 + turn.start, t0 + turn.end, str(spk))
            for turn, _, spk in ann.itertracks(yield_label=True)]
    log.info("Diarization took %.0fs", time.time() - started)
    segs.sort(key=lambda s: (s.start, s.end))
    return segs


def diarize(wav16k: Path, ref_fp: str, ref_duration: float, window: tuple[float, float],
            dcfg: dict, workdir: Path, rttm: Path | None = None,
            force_full: bool = False) -> list[Segment]:
    """Return segments in reference time, covering at least `window`."""
    t0, t1 = window
    if rttm:
        segs = read_rttm(rttm)
        log.info("Diarization: read %d segments from %s (pyannote skipped)", len(segs), rttm)
        return segs
    cache = workdir / "diarization"
    cache.mkdir(parents=True, exist_ok=True)
    full = cache / f"{_key(ref_fp, dcfg, 0.0, None)}.rttm"
    is_full = t0 <= 0.01 and t1 >= ref_duration - 0.01
    if full.exists():
        log.info("Diarization: cached full-length result (%s)", full.name)
        return read_rttm(full)
    if is_full or force_full:
        segs = _run_pyannote(wav16k, 0.0, None, dcfg)
        write_rttm(full, segs)
        log.info("Diarization cached to %s", full)
        return segs
    part = cache / f"{_key(ref_fp, dcfg, t0, t1)}.rttm"
    log.warning("Diarizing only the test segment. Speaker labels may be numbered DIFFERENTLY "
                "in the full run — re-check speakers.json then (or use --diarize-full now).")
    if part.exists():
        log.info("Diarization: cached segment result (%s)", part.name)
        return read_rttm(part)
    segs = _run_pyannote(wav16k, t0, t1, dcfg)
    write_rttm(part, segs)
    return segs


def speaker_stats(segs: list[Segment]) -> dict[str, float]:
    tot: dict[str, float] = {}
    for s in segs:
        tot[s.speaker] = tot.get(s.speaker, 0.0) + s.duration
    return dict(sorted(tot.items(), key=lambda kv: -kv[1]))


def _solo_segments(segs: list[Segment], spk: str) -> list[Segment]:
    """This speaker's turns with every other speaker's speech cut out."""
    others = [s for s in segs if s.speaker != spk]
    out = []
    for s in (x for x in segs if x.speaker == spk):
        pieces = [(s.start, s.end)]
        for o in others:
            if o.end <= s.start or o.start >= s.end:
                continue
            nxt = []
            for a, b in pieces:
                if o.end <= a or o.start >= b:
                    nxt.append((a, b))
                    continue
                if o.start > a:
                    nxt.append((a, o.start))
                if o.end < b:
                    nxt.append((o.end, b))
            pieces = nxt
        out += [Segment(a, b, spk) for a, b in pieces if b - a > 0.5]
    return out


def pick_samples(segs: list[Segment], spk: str, n: int = 3) -> list[Segment]:
    solo = _solo_segments(segs, spk)
    if not solo:
        return []
    longer = [s for s in solo if s.duration >= 2.0]
    if len(longer) >= n:
        solo = longer
    lo, hi = min(s.start for s in solo), max(s.end for s in solo)
    picks: list[Segment] = []
    for i in range(n):  # one from each third of the recording, longest there
        a, b = lo + (hi - lo) * i / n, lo + (hi - lo) * (i + 1) / n
        cands = [s for s in solo if a <= s.start < b and s not in picks]
        if cands:
            picks.append(max(cands, key=lambda s: s.duration))
    for s in sorted(solo, key=lambda s: -s.duration):
        if len(picks) >= n:
            break
        if s not in picks:
            picks.append(s)
    return sorted(picks, key=lambda s: s.start)


def write_speakers_json(path: Path, segs: list[Segment], rate: Rate, wav16k: Path | None,
                        cameras: list[str], mapping: dict[str, str], min_seconds: float) -> dict:
    stats = speaker_stats(segs)
    samples_dir = path.parent / "speaker_samples"
    audio = None
    if wav16k and Path(wav16k).exists():
        samples_dir.mkdir(exist_ok=True)
        sr, audio = wavfile.read(wav16k)
    speakers = {}
    for spk, total in stats.items():
        entry = {"total_seconds": round(total, 1),
                 "turns": sum(1 for s in segs if s.speaker == spk),
                 "needs_mapping": total >= min_seconds,
                 "mapped_to": mapping.get(spk),
                 "samples": []}
        for i, s in enumerate(pick_samples(segs, spk)):
            smp = {"start": round(s.start, 2), "end": round(s.end, 2),
                   "timecode": frames_to_tc(rate.frames(s.start), rate),
                   "hhmmss": fmt_seconds(s.start)}
            if audio is not None:
                a, b = int(s.start * sr), int(min(s.end, s.start + 8.0) * sr)
                wp = samples_dir / f"{spk}_{i + 1}.wav"
                wavfile.write(wp, sr, audio[a:b])
                smp["wav"] = str(wp.relative_to(path.parent))
            entry["samples"].append(smp)
        speakers[spk] = entry
    snippet = "speakers:\n" + "".join(
        f"  {spk}: {mapping.get(spk, '???')}   # {stats[spk]:.0f}s\n" for spk in stats)
    data = {"speakers": speakers, "cameras": cameras + ["long"], "config_snippet": snippet}
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data
