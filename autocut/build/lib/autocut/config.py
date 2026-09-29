"""config.yaml loading, defaults and validation."""
from __future__ import annotations

import copy
from pathlib import Path

import yaml

DEFAULTS = {
    "fps": None,
    "long_camera": None,
    "audio_folder": "audio",
    "cameras": None,
    "speakers": {},
    "sync": {
        "analysis_rate": 8000,
        "coarse_rate": 1000,
        "probe_seconds": 60,
        "long_clip_minutes": 20,
        "drift_correct_frames": 0.5,
        "max_drift_ppm": 1000,
        "min_confidence": 0.5,
        "good_peak_ratio": 2.0,
        "min_ncc": 0.1,
        "overrides": {},
    },
    "diarization": {
        "model": "community-1",
        "hf_token_env": "HF_TOKEN",
        "num_speakers": None,
        "min_speakers": None,
        "max_speakers": None,
        "min_speaker_seconds": 10,
    },
    "cut": {
        "min_segment": 0.7,
        "overlap_min": 0.5,
        "min_shot": 2.0,
        "cut_lead": 0.0,
        "opening_camera": "long",
    },
    "output": {
        "sequence_name": "autocut rough cut",
        "lock_camera_tracks": True,
        "disable_camera_tracks": True,
    },
}


class ConfigError(Exception):
    pass


def _merge(base: dict, override: dict, where: str = "") -> dict:
    out = copy.deepcopy(base)
    for key, value in (override or {}).items():
        if key not in base:
            raise ConfigError(f"unknown config key '{where}{key}'")
        if isinstance(base[key], dict) and key not in ("speakers", "overrides"):
            if value is None:
                continue
            if not isinstance(value, dict):
                raise ConfigError(f"'{where}{key}' must be a mapping")
            out[key] = _merge(base[key], value, f"{where}{key}.")
        else:
            out[key] = value
    return out


def load(path: Path) -> dict:
    path = Path(path)
    if not path.exists():
        raise ConfigError(
            f"config not found: {path}\n"
            f"Copy config.example.yaml there and set at least 'long_camera'.")
    with open(path, encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must be a YAML mapping")
    cfg = _merge(DEFAULTS, raw)
    cfg["speakers"] = {str(k): str(v) for k, v in (cfg["speakers"] or {}).items()}
    cfg["sync"]["overrides"] = {
        str(k).replace("\\", "/"): float(v) for k, v in (cfg["sync"]["overrides"] or {}).items()}
    if not cfg["long_camera"]:
        raise ConfigError("config: 'long_camera' is required (folder name of the wide shot)")
    c = cfg["cut"]
    for key in ("min_segment", "overlap_min", "min_shot", "cut_lead"):
        if float(c[key]) < 0:
            raise ConfigError(f"config: cut.{key} must be >= 0")
    return cfg
