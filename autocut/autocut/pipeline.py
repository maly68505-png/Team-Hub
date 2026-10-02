"""Runs the stages in order, with caching in <project>/_autocut/."""
from __future__ import annotations

import copy
import json
import time
from pathlib import Path

from . import config as config_mod
from .cutlogic import breakdown, keep_ranges, plan_cuts, silence_frames, speech_mask, summarize
from .diarize import clip_segments, diarize, speaker_stats, write_speakers_json
from .log import banner, log, setup
from .probe import require_tools
from .report import write_cuts_csv
from .scan import WORK_DIR, scan
from .sync import report_sync, write_sync_csv
from .takes import build_reference_takes, group_takes, place
from .timecode import fmt_seconds, parse_time
from .timeline import TimeMap, Timeline
from . import mics, xmeml, xmlcut

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NEED_MAPPING = 2
EXIT_LOW_SYNC = 3

STAGES = ("scan", "sync", "diarize", "run")


def _test_suffix(t0: float, t1: float) -> str:
    return "_" + fmt_seconds(t0).replace(":", "").split(".")[0] + f"_{int(round(t1 - t0))}s"


def _test_name(t0: float, t1: float) -> str:
    return f" TEST {fmt_seconds(t0)[:8]} +{fmt_seconds(t1 - t0)[3:8]}"


def write_synced(project, syncs, window, is_test: bool, cfg: dict, out_dir: Path) -> Path:
    """Sync only: every camera on its own track, synced, nothing cut."""
    banner("Output: synced timeline (no cut)")
    t0, t1 = window
    tl = Timeline(project, syncs, window, use_low=True)
    suffix = _test_suffix(t0, t1) if is_test else ""
    xml_p = out_dir / f"synced{suffix}.xml"
    name = "autocut synced" + (_test_name(t0, t1) if is_test else "") + time.strftime(" %H.%M")
    xmeml.write(xml_p, project, tl, None, cfg, name)
    lows = [r.rel for r in syncs.values() if r.low and r.method != "failed"]
    if lows:
        log.warning("%d clip(s) with LOW sync confidence are on their tracks with a red label: %s",
                    len(lows), ", ".join(lows))
    log.info("Synced XML: %s", xml_p)
    log.info("In Premiere: File > Import > %s", xml_p.name)
    return xml_p


def check_speakers(segs, cams: list[str], cfg: dict, workdir: Path, wav16k: Path, rate) -> int | None:
    """speakers.json + samples; an exit code when the speaker mapping is wrong or missing."""
    dcfg = cfg["diarization"]
    mapping = cfg["speakers"]
    speakers_json = workdir / "speakers.json"
    write_speakers_json(speakers_json, segs, rate, wav16k, cams, mapping,
                        float(dcfg["min_speaker_seconds"]))
    stats = speaker_stats(segs)
    log.info("Speakers (%d):", len(stats))
    for spk, total in stats.items():
        log.info("  %-14s %7.1fs  -> %s", spk, total, mapping.get(spk, "(not mapped)"))
    log.info("speakers.json: %s (samples in %s)", speakers_json, workdir / "speaker_samples")

    bad = {k: v for k, v in mapping.items() if any(x != "long" and x not in cams for x in targets(v))}
    if bad:
        log.error("config speakers map to unknown cameras: %s (cameras: %s, or 'long')",
                  bad, ", ".join(cams))
        return EXIT_ERROR
    for k in mapping:
        if k not in stats:
            log.warning("config maps '%s' but diarization has no such label — stale mapping?", k)
    missing = [s for s, t in stats.items()
               if s not in mapping and t >= float(dcfg["min_speaker_seconds"])]
    if missing:
        log.warning("")
        log.warning("Speaker mapping needed for: %s", ", ".join(missing))
        log.warning("Listen to the samples listed in %s, then add to config.yaml:", speakers_json)
        for spk in stats:
            log.warning("    %s: %s", spk, mapping.get(spk, "<camera folder or long>"))
        log.warning("and run again. Stopping here.")
        return EXIT_NEED_MAPPING
    return None


def targets(v) -> list[str]:
    return v if isinstance(v, list) else [v]


def speaker_cameras(mapping: dict, long_camera: str) -> dict:
    def resolve(v):
        out = [long_camera if x == "long" else x for x in targets(v)]
        return out if len(out) > 1 else out[0]
    return {spk: resolve(v) for spk, v in mapping.items()}


def silence_map(n: int, segs, window, rate, quiet, cc: dict) -> TimeMap:
    """Identity, or the kept frames when cut.remove_silence is on."""
    if not cc["remove_silence"]:
        return TimeMap(n)
    t0, t1 = window
    sound = speech_mask(clip_segments(segs, t0, t1), window, rate) | ~quiet
    max_pause = max(float(cc["silence_max"]), 2 * float(cc["silence_pad"]) + 1 / rate.float)
    tm = TimeMap(n, keep_ranges(sound, rate, max_pause, float(cc["silence_pad"])))
    log.info("Silence removal: pauses over %.2fs shortened — %s removed, %s -> %s",
             max_pause, fmt_seconds(tm.removed / rate.float),
             fmt_seconds(n / rate.float), fmt_seconds(tm.total / rate.float))
    return tm


def run(project_dir: Path, until: str = "run", config_path: Path | None = None,
        start: str | None = None, duration: str | None = None, rttm: Path | None = None,
        diarize_full: bool = False, allow_low_confidence: bool = False,
        verbose: bool = False) -> int:
    project_dir = Path(project_dir).resolve()
    if xmlcut.is_xml(project_dir):  # a sequence already synced in Premiere
        workdir = xmlcut.workdir_for(project_dir)
        setup(workdir / "autocut.log", verbose)
        log.info("autocut — synced sequence %s", project_dir)
        cfg_p = Path(config_path or workdir / "config.yaml")
        cfg = config_mod.load(cfg_p, require_long=False) if cfg_p.exists() else copy.deepcopy(config_mod.DEFAULTS)
        require_tools()
        return xmlcut.run_xml(project_dir, cfg, until, start, duration, rttm, diarize_full)
    workdir = project_dir / WORK_DIR
    setup(workdir / "autocut.log", verbose)
    log.info("autocut — project %s", project_dir)
    cfg = config_mod.load(config_path or project_dir / "config.yaml")
    require_tools()

    banner("1. Scan")
    project = scan(project_dir, cfg)
    takes = group_takes(project.audio, cfg["audio_mode"])
    project.takes = takes
    if len(takes) > 1:
        log.info("Clean audio: %d separate takes (not simultaneous tracks)", len(takes))
    if until == "scan":
        return EXIT_OK

    rate = int(cfg["sync"]["analysis_rate"])
    banner("2-3. Sync: " + {"audio": "camera samples against the clean audio",
                             "timecode": "by timecode",
                             "timecode+audio": "camera samples, checked against timecode"}[cfg["sync"]["method"]])
    syncs = place(project, takes, cfg)
    ref = build_reference_takes(takes, workdir, rate, cfg.get("audio_channel"))
    report_sync(project, syncs, ref.duration)

    t0 = parse_time(start, project.rate) if start else 0.0
    if t0 >= ref.duration:
        log.error("--start %s is past the end of the clean audio (%s)", fmt_seconds(t0),
                  fmt_seconds(ref.duration))
        return EXIT_ERROR
    t1 = min(ref.duration, t0 + parse_time(duration, project.rate)) if duration else ref.duration
    window = (t0, t1)
    is_test = t0 > 0.01 or t1 < ref.duration - 0.01
    log.info("Working range: %s -> %s (%s)%s", fmt_seconds(t0), fmt_seconds(t1),
             fmt_seconds(t1 - t0), "  [TEST SEGMENT]" if is_test else "  [FULL]")

    out_dir = workdir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    write_sync_csv(out_dir / "sync_report.csv", syncs)
    log.info("Sync report: %s", out_dir / "sync_report.csv")
    lows = [r for r in syncs.values() if r.low]
    if until == "sync":
        write_synced(project, syncs, window, is_test, cfg, out_dir)
        return EXIT_LOW_SYNC if lows else EXIT_OK

    dcfg = cfg["diarization"]
    if dcfg["method"] == "mics" and not rttm:
        banner("4. Speakers from the recorder's mic channels")
        segs = mics.from_takes(takes, ref.duration, dcfg, cfg.get("audio_channel"), workdir)
    else:
        banner("4. Diarization")
        segs = diarize(ref.wav16k, ref.fp, ref.duration, window, dcfg, workdir, rttm, diarize_full)
    cams = list(project.cameras)
    code = check_speakers(segs, cams, cfg, workdir, ref.wav16k, project.rate)
    if code == EXIT_NEED_MAPPING and lows:
        log.warning("(Also: %d clip(s) have LOW sync confidence — see above.)", len(lows))
    if code is not None:
        return code
    if until == "diarize":
        return EXIT_OK

    if lows and not allow_low_confidence:
        log.error("")
        log.error("%d clip(s) have LOW sync confidence — not guessing:", len(lows))
        for r in lows:
            guess = "unknown" if r.method == "failed" else fmt_seconds(r.offset)
            log.error("  %s  (best guess %s, conf %.2f) %s", r.rel, guess,
                      r.confidence, "; ".join(r.notes))
        log.error("Fix: add the correct start (seconds into the clean audio where the clip's "
                  "first frame lands) under sync.overrides in config.yaml, e.g.")
        log.error("    sync:\n      overrides:\n        %s: 123.456", lows[0].rel)
        log.error("or re-run with --allow-low-confidence: those clips then go on their camera "
                  "track marked LOW-SYNC (red label) and are NOT used in the rough cut.")
        return EXIT_LOW_SYNC
    if lows:
        placed = [r.rel for r in lows if r.method != "failed"]
        unplaced = [r.rel for r in lows if r.method == "failed"]
        if placed:
            log.warning("--allow-low-confidence: %d LOW-SYNC clip(s) are on the camera tracks "
                        "with a red label and are excluded from V1: %s", len(placed), ", ".join(placed))
        if unplaced:
            log.warning("NOT placed at all (no usable audio — needs a sync override): %s",
                        ", ".join(unplaced))

    banner("5. Cut")
    tl = Timeline(project, syncs, window, use_low=allow_low_confidence)
    speaker_cam = speaker_cameras(cfg["speakers"], project.long_camera)
    quiet = silence_frames(ref.x, ref.rate, window, project.rate)
    shots = plan_cuts(clip_segments(segs, t0, t1), window, project.rate, speaker_cam, cams,
                      project.long_camera, tl.coverage, cfg["cut"], quiet)
    summarize(shots, project.rate)

    cc = cfg["cut"]
    tm = silence_map(tl.n, segs, window, project.rate, quiet, cc)

    banner("6. Output")
    suffix = ""
    if is_test:
        suffix = _test_suffix(t0, t1)
    if cc["remove_silence"]:
        suffix += "_tight"
    layered = bool(cfg["output"]["layered"])
    if layered:
        suffix += "_layers"
    xml_p = out_dir / f"roughcut{suffix}.xml"
    csv_p = out_dir / f"cuts{suffix}.csv"
    name = cfg["output"]["sequence_name"] + (
        _test_name(t0, t1) if is_test else " FULL") + (
        " no-silence" if cc["remove_silence"] else "") + (" layers" if layered else "") + time.strftime(" %H.%M")  # tells re-imports apart
    xmeml.write(xml_p, project, tl, shots, cfg, name, tm)
    write_cuts_csv(csv_p, shots, tl, project.rate, tm)
    summary = dict(breakdown(shots, project.rate), full=not is_test, sequence=name, xml=xml_p.name,
                   length=round(tm.total / project.rate.float, 1),
                   removed=round(tm.removed / project.rate.float, 1))
    (out_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("Premiere XML: %s", xml_p)
    log.info("Cut list:     %s", csv_p)
    log.info("Log:          %s", workdir / "autocut.log")
    log.info("In Premiere: File > Import > %s", xml_p.name)
    return EXIT_OK
