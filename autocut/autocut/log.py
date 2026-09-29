"""Logging to the console and to <project>/_autocut/autocut.log."""
from __future__ import annotations

import logging
import sys
from pathlib import Path

log = logging.getLogger("autocut")


def setup(log_file: Path | None = None, verbose: bool = False) -> None:
    log.setLevel(logging.DEBUG)
    for h in list(log.handlers):
        log.removeHandler(h)
        h.close()
    console = logging.StreamHandler(sys.stderr)
    console.setLevel(logging.DEBUG if verbose else logging.INFO)
    console.setFormatter(logging.Formatter("%(levelname)-7s %(message)s"))
    log.addHandler(console)
    if log_file:
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        fh = logging.FileHandler(log_file, encoding="utf-8")
        fh.setLevel(logging.DEBUG)
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
        log.addHandler(fh)
    log.propagate = False


def banner(title: str) -> None:
    log.info("")
    log.info("=== %s %s", title, "=" * max(3, 60 - len(title)))
