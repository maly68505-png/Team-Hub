"""Speech to text, offline: Whisper large-v3-turbo through MLX (the Mac's GPU).

The model ships inside Autocut.app (8-bit, ~850 MB, made at build time by
packaging/fetch_whisper.py); AUTOCUT_WHISPER_MODEL points at it. Nothing is
downloaded at run time.

The clean reference (16 kHz mono, the same file the diarization reads) is cut
into ~5-minute chunks at the quietest moment near each boundary, so a word is
never split, progress can be shown, and a cancelled run resumes where it
stopped (every chunk is cached). Each sentence gets the speaker who talks most
during it (from the diarization / mic analysis).

Outputs (written by the pipeline):
  transcript*.json  sentences + words, in clean-audio time (for topics, paper edit)
  transcript*.srt   subtitles on the sequence's timeline (silence removal included)
  transcript*.txt   readable: [timecode] speaker: text
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
from scipy.io import wavfile

from .log import banner, log
from .timecode import Rate, fmt_seconds, frames_to_tc

MODEL_NAME = "whisper-large-v3-turbo-8bit"
MODEL_ENV = "AUTOCUT_WHISPER_MODEL"
SR = 16000
CHUNK_S = 300.0       # transcribe in chunks of about this length ...
SEEK_S = 20.0         # ... cut at the quietest moment within this much of the boundary
SILENT_DB = -55.0     # a chunk quieter than this throughout is not sent to the model
VERSION = 1           # bump when the output format changes (invalidates caches)


class TranscribeError(Exception):
    pass


@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Sentence:
    start: float
    end: float
    text: str
    speaker: str = ""
    words: list[Word] = field(default_factory=list)


# --- the model -----------------------------------------------------------------

def model_path() -> Path | None:
    """The bundled model (AUTOCUT_WHISPER_MODEL), else <home>/models/<name>."""
    cands = []
    if os.environ.get(MODEL_ENV):
        cands.append(Path(os.environ[MODEL_ENV]).expanduser())
    from .models import models_dir
    cands.append(models_dir() / MODEL_NAME)
    for p in cands:
        if (p / "config.json").is_file():
            return p
    return None


def status() -> dict:
    import importlib.util
    p = model_path()
    backend = importlib.util.find_spec("mlx_whisper") is not None  # no import: the server stays light
    return {"ready": bool(p) and backend, "model": str(p) if p else None, "backend": backend}


def _run_chunk(audio: np.ndarray, model: str, language: str | None) -> list[dict]:
    """One chunk through Whisper -> its segments (with words). Replaced in tests."""
    import mlx_whisper
    opts = dict(path_or_hf_repo=model, language=language, word_timestamps=True,
                condition_on_previous_text=False,     # no repetition loops across windows
                hallucination_silence_threshold=2.0,  # skip text "heard" in long silences
                verbose=None)
    import mlx.core as mx
    try:
        return mlx_whisper.transcribe(audio, **opts)["segments"]
    except Exception as e:  # noqa: BLE001
        # no usable Metal device (a VM, an old macOS): the CPU is slower but works
        if mx.default_device() == mx.cpu:
            raise
        log.warning("GPU not usable (%s) — speech to text on the CPU (slower)", e)
        mx.set_default_device(mx.cpu)
        return mlx_whisper.transcribe(audio, **opts)["segments"]


# --- chunking ------------------------------------------------------------------

def _frame_db(x: np.ndarray, hop: int) -> np.ndarray:
    n = len(x) // hop
    if n == 0:
        return np.full(1, -120.0)
    p = (x[:n * hop].astype(np.float64).reshape(n, hop) ** 2).mean(axis=1)
    return 10 * np.log10(p + 1e-12)


def chunk_bounds(x: np.ndarray, sr: int = SR, chunk_s: float = CHUNK_S, seek_s: float = SEEK_S) -> list[int]:
    """Sample positions [0, b1, b2, ..., len]: every ~chunk_s, moved to the quietest
    0.5 s within seek_s (a pause between words)."""
    hop = int(0.1 * sr)
    db = _frame_db(x, hop)
    smooth = np.convolve(db, np.ones(5) / 5, mode="same")  # 0.5 s
    out = [0]
    t = chunk_s
    total = len(x) / sr
    while t < total - chunk_s / 3:
        a, b = int((t - seek_s) / 0.1), int((t + seek_s) / 0.1)
        a, b = max(a, int(out[-1] / hop) + 10), min(b, len(smooth))
        if b <= a:
            break
        k = a + int(np.argmin(smooth[a:b]))
        out.append(k * hop)
        t = k * 0.1 + chunk_s
    out.append(len(x))
    return out


# --- speakers ------------------------------------------------------------------

def assign_speakers(sentences: list[Sentence], segs) -> None:
    """Each sentence -> the speaker with the most talk time inside it."""
    if not segs:
        return
    segs = sorted(segs, key=lambda s: s.start)
    starts = np.array([s.start for s in segs])
    for s in sentences:
        best, best_t = "", 0.0
        i = max(0, int(np.searchsorted(starts, s.start)) - 50)
        for g in segs[i:]:
            if g.start >= s.end:
                break
            ov = min(g.end, s.end) - max(g.start, s.start)
            if ov > best_t:
                best, best_t = g.speaker, ov
        s.speaker = best


# --- the run -------------------------------------------------------------------

def _clean(text: str) -> str:
    return " ".join(text.split())


def transcribe(wav16k: Path, fp: str, window: tuple[float, float], tcfg: dict, workdir: Path,
               segs=None) -> list[Sentence]:
    """Sentences of the clean audio inside `window` (clean-audio seconds)."""
    model = tcfg.get("model") or model_path()
    if not model:
        raise TranscribeError("the speech-to-text model is not installed in this copy of Autocut")
    language = tcfg.get("language") or None
    t0, t1 = window
    key = hashlib.sha1(f"{fp}|{Path(model).name}|{language}|{VERSION}".encode()).hexdigest()[:16]
    cache = workdir / "transcript" / key
    cache.mkdir(parents=True, exist_ok=True)

    sr, raw = wavfile.read(str(wav16k), mmap=True)
    if sr != SR:
        raise TranscribeError(f"{wav16k.name}: expected {SR} Hz, got {sr}")
    a, b = int(t0 * SR), min(len(raw), int(t1 * SR))
    x = np.asarray(raw[a:b], dtype=np.float32) / 32768.0
    bounds = chunk_bounds(x)
    n = len(bounds) - 1
    log.info("Speech to text: %s in %d part(s), language %s", fmt_seconds(len(x) / SR)[:8], n,
             language or "auto")
    out: list[Sentence] = []
    started = time.time()
    for i in range(n):
        s0, s1 = bounds[i], bounds[i + 1]
        c_start = t0 + s0 / SR
        f = cache / f"{c_start:.2f}-{(t0 + s1 / SR):.2f}.json"
        if f.exists():
            segs_raw = json.loads(f.read_text(encoding="utf-8"))
        else:
            chunk = x[s0:s1]
            if _frame_db(chunk, int(0.1 * SR)).max() < SILENT_DB:
                segs_raw = []
            else:
                segs_raw = [{"start": s["start"], "end": s["end"], "text": s["text"],
                             "words": [{"start": w["start"], "end": w["end"], "word": w["word"]}
                                       for w in s.get("words") or []]}
                            for s in _run_chunk(chunk, str(model), language)]
            f.write_text(json.dumps(segs_raw, ensure_ascii=False), encoding="utf-8")
        for s in segs_raw:
            text = _clean(s["text"])
            if not text:
                continue
            words = [Word(round(c_start + w["start"], 3), round(c_start + w["end"], 3), w["word"].strip())
                     for w in s["words"] if w["word"].strip()]
            out.append(Sentence(round(c_start + s["start"], 3), round(c_start + s["end"], 3), text, "", words))
        done = (i + 1) / n
        el = time.time() - started
        log.info("Speech to text: part %d/%d (%d%%)%s", i + 1, n, round(done * 100),
                 f", about {fmt_seconds(el / done - el)[:8]} left" if i + 1 < n and el > 5 else "")
    assign_speakers(out, segs)
    return out


def save_json(path: Path, sentences: list[Sentence]) -> None:
    path.write_text(json.dumps([asdict(s) for s in sentences], ensure_ascii=False, indent=0),
                    encoding="utf-8")


def load_json(path: Path) -> list[Sentence]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    return [Sentence(d["start"], d["end"], d["text"], d.get("speaker", ""),
                     [Word(**w) for w in d.get("words", [])]) for d in data]


# --- on the sequence -----------------------------------------------------------

def to_sequence(t: float, t0: float, rate: Rate, tm) -> int | None:
    """Clean-audio seconds -> sequence frame (None: inside removed silence)."""
    f = rate.frames(t - t0)
    return tm.map(f) if tm is not None else f


def _span(s: float, e: float, t0: float, rate: Rate, tm) -> tuple[int, int] | None:
    a, b = rate.frames(s - t0), rate.frames(e - t0)
    if tm is None:
        return (a, b) if b > a else None
    parts = tm.split(a, max(b, a + 1))
    return (parts[0][0], parts[-1][1]) if parts else None


def cues(sentences: list[Sentence], max_chars: int = 42, max_s: float = 6.0) -> list[tuple[float, float, str]]:
    """Subtitle cues: at most two lines of max_chars, at most max_s long, split at words."""
    out = []
    for s in sentences:
        words = s.words or [Word(s.start, s.end, s.text)]
        cur: list[Word] = []
        for w in words:
            text = " ".join(x.text for x in cur + [w])
            if cur and (len(text) > 2 * max_chars or w.end - cur[0].start > max_s):
                out.append((cur[0].start, cur[-1].end, " ".join(x.text for x in cur)))
                cur = []
            cur.append(w)
        if cur:
            out.append((cur[0].start, max(cur[-1].end, cur[0].start + 0.5), " ".join(x.text for x in cur)))
    return out


def _two_lines(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    words = text.split()
    best, cut = None, 1
    for i in range(1, len(words)):
        d = abs(len(" ".join(words[:i])) - len(" ".join(words[i:])))
        if best is None or d < best:
            best, cut = d, i
    return " ".join(words[:cut]) + "\n" + " ".join(words[cut:])


def _srt_time(sec: float) -> str:
    ms = int(round(max(0.0, sec) * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def write_srt(path: Path, sentences: list[Sentence], t0: float, rate: Rate, tm=None,
              max_chars: int = 42) -> int:
    """SRT on the sequence's own time (starts at 0, silence removal applied)."""
    n = 0
    lines = []
    last_end = -1
    for s, e, text in cues(sentences, max_chars):
        sp = _span(s, e, t0, rate, tm)
        if not sp:
            continue
        a, b = sp
        a = max(a, last_end)
        if b <= a:
            continue
        last_end = b
        n += 1
        lines += [str(n), f"{_srt_time(a / rate.float)} --> {_srt_time(b / rate.float)}",
                  _two_lines(text, max_chars), ""]
    path.write_text("\n".join(lines), encoding="utf-8")
    return n


def write_txt(path: Path, sentences: list[Sentence], t0: float, rate: Rate, tc_base: int, tm=None,
              names: dict | None = None) -> None:
    """[timecode] speaker: text — one paragraph per speaker turn."""
    names = names or {}
    out, cur_spk, buf, buf_tc = [], None, [], ""
    for s in sentences:
        sp = _span(s.start, s.end, t0, rate, tm)
        if not sp:
            continue
        spk = names.get(s.speaker, s.speaker) or "?"
        if spk != cur_spk and buf:
            out.append(f"[{buf_tc}] {cur_spk}: {' '.join(buf)}")
            buf = []
        if not buf:
            buf_tc = frames_to_tc(tc_base + sp[0], rate)
        cur_spk = spk
        buf.append(s.text)
    if buf:
        out.append(f"[{buf_tc}] {cur_spk}: {' '.join(buf)}")
    path.write_text("\n\n".join(out) + "\n", encoding="utf-8")


def run_stage(ref, window, cfg: dict, workdir: Path, segs) -> list[Sentence] | None:
    """The pipeline step: transcript.json, or None (and a warning) when it cannot run.
    Never stops the cut."""
    tcfg = cfg.get("transcript") or {}
    if not tcfg.get("enabled", True):
        return None
    banner("Speech to text")
    try:
        sentences = transcribe(ref.wav16k, ref.fp, window, tcfg, workdir, segs)
    except TranscribeError as e:
        log.warning("speech to text skipped: %s", e)
        return None
    except Exception as e:  # noqa: BLE001 — a missing transcript must never stop the cut
        log.warning("speech to text failed (the cut goes on without it): %s", e)
        return None
    log.info("Speech to text: %d sentence(s), %d word(s)", len(sentences),
             sum(len(s.text.split()) for s in sentences))
    return sentences
