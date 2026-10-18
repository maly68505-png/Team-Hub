#!/bin/bash
# Checks a built Autocut.app on the Mac that built it (used in CI).
set -euo pipefail
APP="$(cd "$1" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$APP/Contents/Resources/bin/autocut"
export AUTOCUT_HOME="$(mktemp -d)"
export AUTOCUT_RUNTIME_DIR="$AUTOCUT_HOME/runtime"

echo "==> app is a handful of files (engine packed in runtime.tar)"
N=$(find "$APP" | wc -l)
echo "    $N files"
test "$N" -lt 200

echo "==> version (first start unpacks the engine)"
"$CLI" --version
PY="$AUTOCUT_RUNTIME_DIR/$(cat "$APP/Contents/Resources/runtime.id")/python/bin/python3"
test -x "$PY"
"$CLI" --version   # second start: already unpacked

echo "==> pyannote/torch import (offline, telemetry off)"
HF_HUB_OFFLINE=1 PYANNOTE_METRICS_ENABLED=false "$PY" - <<'PY'
import os, torch, av, numpy, scipy
from pyannote.audio import Pipeline
print("torch", torch.__version__, "mps", torch.backends.mps.is_available(), "av", av.__version__)
assert os.environ["PYANNOTE_METRICS_ENABLED"] == "false"
PY

echo "==> speech to text with the model inside the app"
MODEL="$APP/Contents/Resources/models/whisper-large-v3-turbo-8bit"
test -f "$MODEL/config.json" && test -f "$MODEL/weights.safetensors"
du -sh "$MODEL"
SAID="$AUTOCUT_HOME/hello16.wav"
if say -o "$AUTOCUT_HOME/hello.aiff" "Hello, this is a test of the automatic rough cut." 2>/dev/null; then
  ffmpeg -v error -y -i "$AUTOCUT_HOME/hello.aiff" -ar 16000 -ac 1 -c:a pcm_s16le "$SAID"
else
  echo "    (no speech synthesis on this Mac: the model only has to run)"
  SAID=""
fi
AUTOCUT_WHISPER_MODEL="$MODEL" "$PY" - "$SAID" <<'PY'
import sys, time
import numpy as np
from scipy.io import wavfile
from autocut import transcribe
assert transcribe.status()["ready"], transcribe.status()
if sys.argv[1]:
    sr, x = wavfile.read(sys.argv[1])
    x = x.astype(np.float32) / 32768
else:
    x = (0.01 * np.random.default_rng(0).normal(0, 1, 16000 * 5)).astype(np.float32)
t = time.time()
segs = transcribe._run_chunk(x, str(transcribe.model_path()), "en")
text = " ".join(s["text"] for s in segs).lower()
print(f"    {time.time() - t:.1f} s: {text!r}")
if sys.argv[1]:
    assert "hello" in text and "test" in text, text
    assert all(s["words"] for s in segs), "word timings missing"
PY

echo "==> native app binary"
file "$APP/Contents/MacOS/Autocut" | grep -q "Mach-O 64-bit executable arm64"
plutil -lint "$APP/Contents/Info.plist"

echo "==> engine server"
"$CLI" serve --port 0 > "$AUTOCUT_HOME/serve.log" 2>&1 &
PID=$!
for i in $(seq 1 60); do [ -f "$AUTOCUT_HOME/server.json" ] && break; sleep 0.5; done
PORT=$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1]))['port'])" "$AUTOCUT_HOME/server.json")
TOKEN=$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1]))['token'])" "$AUTOCUT_HOME/server.json")
curl -fsS "http://127.0.0.1:$PORT/" | grep -q Autocut
curl -fsS -H "X-Autocut-Token: $TOKEN" "http://127.0.0.1:$PORT/api/ping"; echo
test "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/ping")" = 401
kill $PID

echo "==> test suite with the bundled Python"
"$PY" -m venv --system-site-packages "$AUTOCUT_HOME/venv"
"$AUTOCUT_HOME/venv/bin/python" -m pip install -q pytest
cd "$ROOT"
ffmpeg -version | head -1
"$AUTOCUT_HOME/venv/bin/python" -m pytest -q -s tests/test_decode_timing.py
"$AUTOCUT_HOME/venv/bin/python" -m pytest -q
echo "SMOKE TEST PASSED"
