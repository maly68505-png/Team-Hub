"""Offline diarization models.

The diarization pipeline (pyannote/speaker-diarization-community-1, CC-BY-4.0)
is downloaded ONCE by one person with a Hugging Face token, exported as a zip,
and imported on every other machine — no internet or account needed there.
At run time the model is loaded from disk with Hugging Face offline mode on.
"""
from __future__ import annotations

import os
import shutil
import sys
import zipfile
from pathlib import Path

MODEL_REPO = "pyannote/speaker-diarization-community-1"
MODEL_NAME = "speaker-diarization-community-1"
ALIASES = {"community-1", MODEL_REPO, MODEL_NAME}
EXPORT_NAME = "autocut-models.zip"


class ModelError(Exception):
    pass


def home() -> Path:
    """Per-user data folder: ~/Library/Application Support/Autocut on macOS."""
    if os.environ.get("AUTOCUT_HOME"):
        p = Path(os.environ["AUTOCUT_HOME"])
    elif sys.platform == "darwin":
        p = Path.home() / "Library" / "Application Support" / "Autocut"
    else:
        p = Path.home() / ".autocut"
    p.mkdir(parents=True, exist_ok=True)
    return p


def models_dir() -> Path:
    p = home() / "models"
    p.mkdir(parents=True, exist_ok=True)
    return p


def local_pipeline() -> Path:
    return models_dir() / MODEL_NAME


def ready() -> bool:
    return (local_pipeline() / "config.yaml").is_file()


def status() -> dict:
    p = local_pipeline()
    size = sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.exists() else 0
    return {"ready": ready(), "path": str(p), "name": MODEL_REPO, "size_mb": round(size / 1e6, 1)}


def resolve(model: str) -> tuple[str, bool]:
    """-> (what to pass to Pipeline.from_pretrained, is_local)."""
    if model and Path(model).expanduser().is_dir():
        return str(Path(model).expanduser()), True
    if model in ALIASES or not model:
        if ready():
            return str(local_pipeline()), True
        raise ModelError(
            "diarization model is not installed on this Mac. In the Autocut app open "
            "'النماذج' (Models) and import autocut-models.zip from a colleague, or download "
            "it once with a Hugging Face token: autocut models download --token hf_...")
    return model, False  # a Hugging Face id — needs internet + token


def download(token: str, log=print) -> Path:
    try:
        from huggingface_hub import snapshot_download
    except ImportError as e:
        raise ModelError("huggingface_hub missing — install autocut with [diarize]") from e
    if not token:
        raise ModelError("a Hugging Face token is needed for the one-time download")
    tmp = models_dir() / (MODEL_NAME + ".partial")
    shutil.rmtree(tmp, ignore_errors=True)
    log(f"Downloading {MODEL_REPO} (one time) ...")
    try:
        snapshot_download(MODEL_REPO, token=token, local_dir=str(tmp))
    except Exception as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise ModelError(
            f"download failed: {e}\nCheck the token and that you accepted the conditions on "
            f"https://huggingface.co/{MODEL_REPO} with the same account.") from e
    shutil.rmtree(tmp / ".cache", ignore_errors=True)
    if not (tmp / "config.yaml").is_file():
        raise ModelError("downloaded files have no config.yaml — unexpected repository layout")
    shutil.rmtree(local_pipeline(), ignore_errors=True)
    tmp.rename(local_pipeline())
    log(f"Model installed in {local_pipeline()}")
    return local_pipeline()


def export_zip(dest_dir: Path, log=print) -> Path:
    if not ready():
        raise ModelError("no model installed to export")
    dest = Path(dest_dir) / EXPORT_NAME
    src = local_pipeline()
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(src.rglob("*")):
            if f.is_file():
                z.write(f, Path(MODEL_NAME) / f.relative_to(src))
    log(f"Exported {dest} ({dest.stat().st_size / 1e6:.0f} MB) — share it with the team")
    return dest


def import_zip(zip_path: Path, log=print) -> Path:
    zip_path = Path(zip_path)
    if not zip_path.is_file():
        raise ModelError(f"not found: {zip_path}")
    root = models_dir().resolve()
    tmp = root / (MODEL_NAME + ".importing")
    shutil.rmtree(tmp, ignore_errors=True)
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        if f"{MODEL_NAME}/config.yaml" not in names:
            raise ModelError(f"{zip_path.name} is not an Autocut model export")
        for n in names:
            if not n.startswith(MODEL_NAME + "/") or ".." in Path(n).parts or Path(n).is_absolute():
                raise ModelError(f"unsafe path in zip: {n}")
        z.extractall(tmp)
    shutil.rmtree(local_pipeline(), ignore_errors=True)
    (tmp / MODEL_NAME).rename(local_pipeline())
    shutil.rmtree(tmp, ignore_errors=True)
    log(f"Model imported to {local_pipeline()}")
    return local_pipeline()
