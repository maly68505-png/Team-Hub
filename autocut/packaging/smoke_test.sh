#!/bin/bash
# Checks a built Autocut.app on the Mac that built it (used in CI).
set -euo pipefail
APP="$(cd "$1" && pwd)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$APP/Contents/Resources/bin/autocut"
PY="$APP/Contents/Resources/python/bin/python3"
export AUTOCUT_HOME="$(mktemp -d)"

echo "==> version"
"$CLI" --version

echo "==> pyannote/torch import (offline, telemetry off)"
HF_HUB_OFFLINE=1 PYANNOTE_METRICS_ENABLED=false "$PY" - <<'PY'
import os, torch, av, numpy, scipy
from pyannote.audio import Pipeline
print("torch", torch.__version__, "mps", torch.backends.mps.is_available(), "av", av.__version__)
assert os.environ["PYANNOTE_METRICS_ENABLED"] == "false"
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
