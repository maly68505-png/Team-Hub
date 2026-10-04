"""autocut command line."""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from . import __version__
from .config import ConfigError
from .diarize import DiarizationError
from .log import log
from .pipeline import EXIT_ERROR, run
from .probe import ToolError
from .scan import ScanError

HELP = {
    "scan": "step 1 only: list cameras, clips, fps, timecodes, clean audio",
    "check": "check the clean audio: every channel, every 5 minutes, read to the end?",
    "sync": "steps 1-3: sync every clip and print the confidence table",
    "diarize": "steps 1-4: diarize and write speakers.json (for the speaker mapping)",
    "run": "everything: rough cut XML + cuts.csv",
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="autocut", description="Multicam rough cut for Premiere Pro "
                                 "from clean audio + speaker diarization.")
    ap.add_argument("--version", action="version", version=f"autocut {__version__}")
    sub = ap.add_subparsers(dest="stage", required=True)
    for stage, text in HELP.items():
        p = sub.add_parser(stage, help=text, description=text)
        p.add_argument("project", type=Path, help="project folder (camera folders + audio/)")
        p.add_argument("--config", type=Path, help="config file (default: PROJECT/config.yaml)")
        p.add_argument("-v", "--verbose", action="store_true", help="debug output on the console")
        if stage in ("scan", "check"):
            continue
        p.add_argument("--start", help="start of the test segment in the clean audio "
                       "(HH:MM:SS, MM:SS or seconds)")
        p.add_argument("--duration", help="length of the test segment (e.g. 5:00)")
        if stage in ("diarize", "run"):
            p.add_argument("--rttm", type=Path, help="use this RTTM diarization instead of pyannote")
            p.add_argument("--diarize-full", action="store_true",
                           help="diarize the whole recording even for a test segment "
                                "(keeps speaker labels identical to the full run)")
        if stage == "run":
            p.add_argument("--allow-low-confidence", action="store_true",
                           help="continue despite low-confidence sync: those clips are marked "
                                "LOW-SYNC on the camera tracks and kept out of the rough cut")
    p = sub.add_parser("serve", help="start the Autocut app (local web UI)")
    p.add_argument("--port", type=int, default=47821)
    p.add_argument("--open", action="store_true", help="open the UI in the browser")
    p.add_argument("--app", action="store_true", help="app mode: quit after 30 min idle")
    p = sub.add_parser("models", help="offline diarization model: status/download/import/export")
    msub = p.add_subparsers(dest="action", required=True)
    msub.add_parser("status")
    m = msub.add_parser("download", help="one-time download (needs internet + HF token)")
    m.add_argument("--token", default=os.environ.get("HF_TOKEN"))
    m = msub.add_parser("import", help="install from autocut-models.zip (offline)")
    m.add_argument("zip", type=Path)
    m = msub.add_parser("export", help="write autocut-models.zip to share with the team")
    m.add_argument("dest", type=Path)

    a = ap.parse_args(argv)
    if a.stage == "serve":
        from .server import serve
        return serve(a.port, a.open, a.app)
    if a.stage == "models":
        return _models(a)
    try:
        return run(a.project, until=a.stage, config_path=a.config,
                   start=getattr(a, "start", None), duration=getattr(a, "duration", None),
                   rttm=getattr(a, "rttm", None), diarize_full=getattr(a, "diarize_full", False),
                   allow_low_confidence=getattr(a, "allow_low_confidence", False),
                   verbose=a.verbose)
    except (ConfigError, ScanError, ToolError, DiarizationError, ValueError) as e:
        if not log.handlers:
            print(f"ERROR   {e}", file=sys.stderr)
        else:
            log.error("%s", e)
        return EXIT_ERROR
    except KeyboardInterrupt:
        log.error("interrupted")
        return 130


def _models(a) -> int:
    from . import models
    try:
        if a.action == "status":
            print(json.dumps(models.status(), indent=2))
        elif a.action == "download":
            models.download(a.token)
        elif a.action == "import":
            models.import_zip(a.zip)
        elif a.action == "export":
            models.export_zip(a.dest)
    except models.ModelError as e:
        print(f"ERROR   {e}", file=sys.stderr)
        return EXIT_ERROR
    return 0


if __name__ == "__main__":
    sys.exit(main())
