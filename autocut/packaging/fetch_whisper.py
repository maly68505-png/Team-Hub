"""Build step: the speech-to-text model that ships inside Autocut.app.

Downloads Whisper large-v3-turbo in MLX format (public, no account) and stores
it quantized to 8 bits: ~850 MB instead of 1.6 GB, with no audible change in
accuracy. Run with the app's own Python (it needs mlx-whisper):

    python fetch_whisper.py DEST_DIR [--src LOCAL_MODEL_DIR] [--bits 8]
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

REPO = "mlx-community/whisper-large-v3-turbo"
GROUP = 64


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dest", type=Path)
    ap.add_argument("--src", type=Path, help="an MLX Whisper model folder (default: download %s)" % REPO)
    ap.add_argument("--bits", type=int, default=8)
    a = ap.parse_args()

    import mlx.core as mx
    import mlx.nn as nn
    from mlx.utils import tree_flatten
    from mlx_whisper.load_models import load_model

    src = a.src
    if src is None:
        from huggingface_hub import snapshot_download
        src = Path(snapshot_download(REPO, allow_patterns=["config.json", "weights.*"]))
    print(f"source model: {src}", flush=True)
    cfg = json.loads((src / "config.json").read_text())
    if "quantization" in cfg:
        print("source is already quantized: copied as is", flush=True)
        tmp = a.dest.with_name(a.dest.name + ".partial")
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(src, tmp)
    else:
        model = load_model(str(src), dtype=mx.float16)
        model.set_dtype(mx.float16)  # every float weight: the decoder checks for float16 features
        nn.quantize(model, group_size=GROUP, bits=a.bits,
                    class_predicate=lambda p, m: isinstance(m, (nn.Linear, nn.Embedding))
                    and m.weight.shape[-1] % GROUP == 0)
        tmp = a.dest.with_name(a.dest.name + ".partial")
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        mx.save_safetensors(str(tmp / "weights.safetensors"), dict(tree_flatten(model.parameters())))
        cfg["quantization"] = {"group_size": GROUP, "bits": a.bits}
        (tmp / "config.json").write_text(json.dumps(cfg, indent=1))
    # load it back the way Autocut does: a broken model must fail the build, not the editor
    load_model(str(tmp), dtype=mx.float16)
    shutil.rmtree(a.dest, ignore_errors=True)
    tmp.rename(a.dest)
    size = sum(f.stat().st_size for f in a.dest.iterdir()) / 1e6
    print(f"model ready: {a.dest} ({size:.0f} MB)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
