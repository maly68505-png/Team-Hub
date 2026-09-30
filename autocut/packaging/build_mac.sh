#!/bin/bash
# Build a self-contained Autocut.app for Apple Silicon Macs + the team installer zip.
#
#   bash packaging/build_mac.sh            (run on an Apple Silicon Mac, or in CI)
#
# The app carries its own Python (python-build-standalone) with autocut, PyAV
# (FFmpeg), PyTorch and pyannote installed into it: nothing else to install on
# the Macs that use it, and it runs offline.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="${DIST:-$ROOT/dist}"
NAME="Autocut-mac-arm64"
OUT="$DIST/$NAME"
APP="$OUT/Autocut.app"
PYSERIES="${PYSERIES:-3.12}"

[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || {
  echo "build_mac.sh must run on an Apple Silicon Mac" >&2; exit 1; }

rm -rf "$OUT" "$DIST/$NAME.zip"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin"

echo "==> Python $PYSERIES (python-build-standalone)"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
URL="$(curl -fsSL "${AUTH[@]}" https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest \
  | /usr/bin/python3 -c '
import json, re, sys
series = sys.argv[1].replace(".", r"\.")
pat = re.compile(r"cpython-" + series + r"\.\d+\+\d+-aarch64-apple-darwin-install_only\.tar\.gz$")
print(next(a["browser_download_url"] for a in json.load(sys.stdin)["assets"] if pat.match(a["name"])))
' "$PYSERIES")"
echo "    $URL"
curl -fsSL "$URL" | tar -xz -C "$APP/Contents/Resources"
PY="$APP/Contents/Resources/python/bin/python3"
"$PY" --version

echo "==> autocut + dependencies"
export PIP_DISABLE_PIP_VERSION_CHECK=1
"$PY" -m pip install --no-cache-dir --upgrade pip wheel
"$PY" -m pip install --no-cache-dir "$ROOT[diarize]"
"$PY" -m pip freeze > "$APP/Contents/Resources/requirements.lock"
# precompile so the app never writes into its own bundle at run time
"$PY" -m compileall -q -j 0 "$APP/Contents/Resources/python/lib" || true

echo "==> launchers"
cat > "$APP/Contents/Resources/bin/autocut" <<'SH'
#!/bin/bash
# Command-line entry point (also used by the Premiere panel).
R="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 PYANNOTE_METRICS_ENABLED=false
exec "$R/python/bin/python3" -m autocut "$@"
SH
cat > "$APP/Contents/MacOS/Autocut" <<'SH'
#!/bin/bash
# Double-click: start the local engine in the background and open the UI.
R="$(cd "$(dirname "$0")/../Resources" && pwd)"
mkdir -p "$HOME/Library/Logs"
nohup "$R/bin/autocut" serve --app --open >> "$HOME/Library/Logs/Autocut.log" 2>&1 &
disown
SH
chmod +x "$APP/Contents/Resources/bin/autocut" "$APP/Contents/MacOS/Autocut"

VERSION="$("$PY" -c 'import autocut; print(autocut.__version__)')"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Autocut</string>
  <key>CFBundleDisplayName</key><string>Autocut</string>
  <key>CFBundleIdentifier</key><string>com.autocut.app</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Autocut</string>
  <key>CFBundleIconFile</key><string>Autocut</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "==> icon"
"$PY" "$HERE/make_icon.py" "$OUT/icon.iconset" && \
  iconutil -c icns "$OUT/icon.iconset" -o "$APP/Contents/Resources/Autocut.icns" || echo "    (no icon)"
rm -rf "$OUT/icon.iconset"

echo "==> Premiere panel + installer"
ditto "$ROOT/premiere-panel" "$OUT/AutocutPanel"
cp "$HERE/Install Autocut.command" "$OUT/"
chmod +x "$OUT/Install Autocut.command"
cp "$HERE/README-EN.md" "$OUT/README.md"
cp "$HERE/README-AR.md" "$OUT/اقرأني.md"

echo "==> zip"
( cd "$DIST" && ditto -c -k --sequesterRsrc --keepParent "$NAME" "$NAME.zip" )
du -sh "$APP" "$DIST/$NAME.zip"
echo "Built $DIST/$NAME.zip"
