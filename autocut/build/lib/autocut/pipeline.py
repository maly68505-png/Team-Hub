"""Runs the stages in order, with caching in <project>/_autocut/."""
from __future__ import annotations

from pathlib import Path

from . import config as config_mod
from .audio import build_reference
from .cutlogic import plan_cuts, summarize
from .diarize import clip_segments, diarize, speaker_stats, write_speakers_json
from .log import banner, log, setup
from .probe import require_tools
from .report import write_cuts_csv
from .scan import WORK_DIR, scan
from .sync import sync_all, write_sync_csv
from .timecode import fmt_seconds, parse_time
from .timeline import Timeline
from . import xmeml

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NEED_MAPPING = 2
EXIT_LOW_SYNC = 3

STAGES = ("scan", "sync", "diarize", "run")


def run(project_dir: Path, until: str = "run", config_path: Path | None = None,
        start: str | None = None, duration: str | None = None, rttm: Path | None = None,
        diarize_full: bool = False, allow_low_confidence: bool = False,
        verbose: bool = False) -> int:
    project_dir = Path(project_dir).resolve()
    workdir = project_dir / WORK_DIR
    setup(workdir / "autocut.log", verbose)
    log.info("autocut — project %s", project_dir)
    cfg = config_mod.load(config_path or project_dir / "config.yaml")
    require_tools()

    banner("1. Scan")
    project = scan(project_dir, cfg)
    if until == "scan":
        return EXIT_OK

    banner("2. Reference mix")
    ref = build_reference(project.audio, workdir, int(cfg["sync"]["analysis_rate"]))
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

    banner("3. Sync")
    syncs = sync_all(project, ref, cfg)
    out_dir = workdir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    write_sync_csv(out_dir / "sync_report.csv", syncs)
    log.info("Sync report: %s", out_dir / "sync_report.csv")
    lows = [r for r in syncs.values() if r.low]
    if until == "sync":
        return EXIT_LOW_SYNC if lows else EXIT_OK

    banner("4. Diarization")
    dcfg = cfg["diarization"]
    segs = diarize(ref.wav16k, ref.fp, ref.duration, window, dcfg, workdir, rttm, diarize_full)
    cams = list(project.cameras)
    mapping = cfg["speakers"]
    speakers_json = workdir / "speakers.json"
    write_speakers_json(speakers_json, segs, project.rate, ref.wav16k, cams, mapping,
                        float(dcfg["min_speaker_seconds"]))
    stats = speaker_stats(segs)
    log.info("Speakers (%d):", len(stats))
    for spk, total in stats.items():
        log.info("  %-14s %7.1fs  -> %s", spk, total, mapping.get(spk, "(not mapped)"))
    log.info("speakers.json: %s (samples in %s)", speakers_json, workdir / "speaker_samples")

    bad = {k: v for k, v in mapping.items() if v != "long" and v not in cams}
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
        if lows:
            log.warning("(Also: %d clip(s) have LOW sync confidence — see above.)", len(lows))
        return EXIT_NEED_MAPPING
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
    speaker_cam = {spk: (project.long_camera if cam == "long" else cam) for spk, cam in mapping.items()}
    shots = plan_cuts(clip_segments(segs, t0, t1), window, project.rate, speaker_cam, cams,
                      project.long_camera, tl.coverage, cfg["cut"])
    summarize(shots, project.rate)

    banner("6. Output")
    suffix = ""
    if is_test:
        suffix = "_" + fmt_seconds(t0).replace(":", "").split(".")[0] + f"_{int(round(t1 - t0))}s"
    xml_p = out_dir / f"roughcut{suffix}.xml"
    csv_p = out_dir / f"cuts{suffix}.csv"
    name = cfg["output"]["sequence_name"] + (f" [test {fmt_seconds(t0)[:8]}]" if is_test else "")
    xmeml.write(xml_p, project, tl, shots, cfg, name)
    write_cuts_csv(csv_p, shots, tl, project.rate)
    log.info("Premiere XML: %s", xml_p)
    log.info("Cut list:     %s", csv_p)
    log.info("Log:          %s", workdir / "autocut.log")
    log.info("In Premiere: File > Import > %s", xml_p.name)
    return EXIT_OK
