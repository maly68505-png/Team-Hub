"""Picture check: problems in the camera files, before the edit finds them.

Every camera clip is read in short windows (2 s every `sample_every` seconds,
by seeking: a few % of each file) at a small size, and each window is measured:
brightness, share of burnt-out pixels, sharpness (variance of the Laplacian),
movement between frames, and missing frames (gaps in the time stamps). What is
"too soft" or "too bright" is judged against the same camera's own normal, so
a dark set or a soft lens is not reported everywhere.

Reported per window: black picture, frozen picture, burnt highlights, out of
focus, missing frames. After sync, also: a camera that stopped recording in the
middle (a gap between its clips). Results: <work>/output/media_check.json and,
in the rough cut, a marker at each problem.
"""
from __future__ import annotations

import json
from pathlib import Path

import av
import numpy as np

from .audio import fingerprint
from .log import banner, log
from .timecode import fmt_seconds

WIN = 2.0              # seconds decoded per window
SIZE = (320, 180)
BLACK_LUMA = 8.0       # mean grey level (0-255) under this = black picture
FROZEN_MOTION = 0.01   # mean frame-to-frame change under this = the same frame repeated
BURNT_SHARE = 0.10     # share of pixels at >= 250 ...
BURNT_OVER = 3.0       # ... and this many times the camera's normal share
SOFT_RATIO = 0.4       # sharpness under this share of the camera's normal = out of focus
GAP_MIN_S = 5.0        # a camera with no picture this long between two clips is reported

KINDS = {
    "black": ("black picture", "صورة سوداء"),
    "frozen": ("frozen picture (the same frame repeats)", "صورة متجمدة (نفس الفريم يتكرر)"),
    "burnt": ("burnt highlights (overexposed)", "إضاءة محروقة"),
    "soft": ("out of focus / soft", "الصورة مش واضحة (Out of focus)"),
    "dropped": ("missing frames", "فريمات ناقصة"),
    "stopped": ("no picture: the camera stopped recording", "مفيش صورة: الكاميرا وقفت تسجيل"),
}


def _laplacian_var(g: np.ndarray) -> float:
    lap = 4 * g[1:-1, 1:-1] - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    return float(lap.var())


def read_window(c, st, t0: float, start: float, length: float = WIN) -> dict:
    tb = st.time_base
    c.seek(int((t0 + max(0.0, start)) / tb), stream=st, backward=True)
    prev, lum, burnt, sharp, motion, pts = None, [], [], [], [], []
    for fr in c.decode(st):
        if fr.pts is None:
            continue
        t = float(fr.pts * tb) - t0
        if t < start:
            continue
        if t >= start + length:
            break
        g = fr.reformat(width=SIZE[0], height=SIZE[1], format="gray").to_ndarray().astype(np.float32)
        lum.append(float(g.mean()))
        burnt.append(float((g >= 250).mean()))
        sharp.append(_laplacian_var(g))
        if prev is not None:
            motion.append(float(np.abs(g - prev).mean()))
        prev = g
        pts.append(t)
    if len(lum) < 3:
        return {"t": round(start, 2), "frames": len(lum)}
    d = np.diff(pts)
    step = float(np.median(d)) if len(d) else 0.0
    dropped = int(np.sum(np.round(d / step) - 1)) if step > 0 else 0
    return {"t": round(start, 2), "frames": len(lum), "luma": round(float(np.mean(lum)), 1),
            "burnt": round(float(np.mean(burnt)), 4), "sharp": round(float(np.median(sharp)), 1),
            "motion": round(float(np.mean(motion)), 3) if motion else 0.0, "dropped": max(0, dropped)}


def sample_clip(path: Path, duration: float, every: float, cache_dir: Path) -> dict:
    """Measurements of one clip (cached)."""
    cache = cache_dir / f"{fingerprint([path], f'media-{every}-{WIN}-{SIZE}')}.json"
    if cache.exists():
        try:
            return json.loads(cache.read_text())
        except ValueError:
            pass
    times = [min(5.0, max(0.0, duration / 2 - WIN / 2))]
    t = times[0] + every
    while t < duration - WIN - 1:
        times.append(round(t, 2))
        t += every
    out: dict = {"samples": []}
    try:
        with av.open(str(path)) as c:
            if not c.streams.video:
                return {"samples": [], "error": "no video"}
            st = c.streams.video[0]
            st.thread_type = "AUTO"
            t0 = float(st.start_time * st.time_base) if st.start_time is not None else 0.0
            for t in times:
                try:
                    out["samples"].append(read_window(c, st, t0, t))
                except (av.error.FFmpegError, ValueError) as e:
                    out["samples"].append({"t": t, "frames": 0, "error": str(e)})
    except (av.error.FFmpegError, IndexError) as e:
        out["error"] = str(e)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps(out))
    return out


def _issue(kind: str, clip: str, t: float, dur: float, extra: str = "") -> dict:
    en, ar = KINDS[kind]
    return {"kind": kind, "clip": clip, "t": round(t, 2), "dur": round(dur, 1),
            "en": en + extra, "ar": ar + extra}


def camera_issues(clips: list[tuple[str, dict]], every: float) -> list[dict]:
    """Problems of one camera from its clips' samples ((rel, sample_clip result) each)."""
    good = [s for _, r in clips for s in r.get("samples", []) if s.get("luma") is not None]
    out: list[dict] = []
    if not good:
        for rel, r in clips:
            if r.get("error"):
                out.append({"kind": "error", "clip": rel, "t": 0.0, "dur": 0.0,
                            "en": f"cannot be read: {r['error']}", "ar": f"الملف لا يُقرأ: {r['error']}"})
        return out
    lit = [s for s in good if s["luma"] >= BLACK_LUMA]
    sharp_n = float(np.median([s["sharp"] for s in lit])) if lit else 0.0
    burnt_n = float(np.median([s["burnt"] for s in lit])) if lit else 0.0
    moving = float(np.median([s["motion"] for s in lit])) if lit else 0.0
    for rel, r in clips:
        found: list[tuple[str, float]] = []
        for s in r.get("samples", []):
            if s.get("luma") is None:
                continue
            if s["luma"] < BLACK_LUMA:
                found.append(("black", s["t"]))
                continue
            frozen = s["motion"] < FROZEN_MOTION and moving > 10 * FROZEN_MOTION
            if frozen:
                found.append(("frozen", s["t"]))
            if s["burnt"] > BURNT_SHARE and s["burnt"] > BURNT_OVER * burnt_n + 0.02:
                found.append(("burnt", s["t"]))
            if not frozen and sharp_n > 0 and s["sharp"] < SOFT_RATIO * sharp_n and s["luma"] >= 20:
                found.append(("soft", s["t"]))
            if s.get("dropped", 0) > 0:
                found.append(("dropped", s["t"]))
        # neighbouring windows with the same problem: one issue over the whole stretch
        for kind in KINDS:
            ts = sorted(t for k, t in found if k == kind)
            i = 0
            while i < len(ts):
                j = i
                while j + 1 < len(ts) and ts[j + 1] - ts[j] <= every * 1.01:
                    j += 1
                out.append(_issue(kind, rel, ts[i], ts[j] - ts[i] + WIN))
                i = j + 1
    out.sort(key=lambda x: (x["clip"], x["t"]))
    return out


def stopped_gaps(project, syncs: dict) -> list[dict]:
    """Per camera, stretches with no picture between two of its placed clips."""
    out = []
    for name, cam in project.cameras.items():
        spans = sorted((syncs[c.rel].ref_start, syncs[c.rel].ref_end, c.rel) for c in cam.clips
                       if c.rel in syncs and not syncs[c.rel].low
                       and syncs[c.rel].method not in ("failed", "parked"))
        end, last = None, None
        for a, b, rel in spans:
            if end is not None and a - end >= GAP_MIN_S:
                d = a - end
                iss = _issue("stopped", last, 0.0, d, f" ({fmt_seconds(d)[:8]})")
                iss.update(camera=name, ref_t=round(end, 2))
                out.append(iss)
            if end is None or b > end:
                end, last = b, rel
    return out


def run_media_check(project, workdir: Path, out_dir: Path, every: float = 120.0,
                    syncs: dict | None = None) -> dict:
    banner("Picture check: every camera, a few seconds every %d s" % every)
    cache = workdir / "mediacheck"
    clips = [c for cam in project.cameras.values() for c in cam.clips]
    res: dict = {"sample_every": every, "cameras": []}
    k = 0
    for name, cam in project.cameras.items():
        got = []
        for clip in cam.clips:
            k += 1
            log.info("Picture check %d/%d: %s (%s)", k, len(clips), clip.rel, fmt_seconds(clip.info.duration)[:8])
            got.append((clip.rel, sample_clip(clip.path, clip.info.duration, every, cache)))
        issues = camera_issues(got, every)
        for iss in issues:
            iss["camera"] = name
            r = (syncs or {}).get(iss["clip"])
            if r is not None and not r.low and r.method not in ("failed", "parked"):
                iss["ref_t"] = round(r.ref_time(iss["t"]), 2)
        res["cameras"].append({"name": name, "clips": len(cam.clips), "issues": issues})
    if syncs:
        gaps = stopped_gaps(project, syncs)
        for c in res["cameras"]:
            c["issues"] += [g for g in gaps if g["camera"] == c["name"]]
    n = 0
    for c in res["cameras"]:
        for iss in c["issues"]:
            n += 1
            log.warning("  %s  %s at %s: %s", c["name"], iss["clip"], fmt_seconds(iss["t"])[:8], iss["en"])
    log.info("Picture check: %s", f"{n} problem(s) — see above" if n else "no problems found")
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "media_check.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    return res


def markers(res: dict) -> list[tuple[float, str, str]]:
    """(clean-audio seconds, name, comment) for each placed problem."""
    out = []
    for c in res.get("cameras", []):
        for iss in c["issues"]:
            if "ref_t" in iss:
                out.append((iss["ref_t"], f"⚠ {c['name']}: {iss['ar']}",
                            f"{iss['en']} — {iss['clip']}"))
    return sorted(out)
