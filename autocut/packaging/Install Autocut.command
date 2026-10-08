#!/bin/bash
# Autocut installer — double-click (or: bash "Install Autocut.command")
# Installs Autocut.app, the Premiere Pro panel, and the offline model if
# autocut-models.zip sits next to this file. Needs no internet.
set -e
cd "$(dirname "$0")"
echo "=== Installing Autocut ==="

# stop a running older version so the new one starts fresh
pkill -f "autocut serve" 2>/dev/null || true

DEST="/Applications"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
echo "• App → $DEST/Autocut.app"
rm -rf "$DEST/Autocut.app"
ditto "Autocut.app" "$DEST/Autocut.app"
xattr -dr com.apple.quarantine "$DEST/Autocut.app" 2>/dev/null || true

EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.autocut.panel"
echo "• Premiere panel → Window > Extensions > Autocut"
rm -rf "$EXT"
mkdir -p "$(dirname "$EXT")"
ditto "AutocutPanel" "$EXT"
xattr -dr com.apple.quarantine "$EXT" 2>/dev/null || true
# the panel is not signed by Adobe: allow unsigned extensions (CEP 9-13)
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

CLI="$DEST/Autocut.app/Contents/Resources/bin/autocut"
echo "• Preparing the engine (about a minute, once per version) ..."
"$CLI" --version
if [ -f "autocut-models.zip" ]; then
  echo "• Model (offline) ..."
  "$CLI" models import "autocut-models.zip"
fi
if "$CLI" models status | grep -q '"ready": true'; then
  echo "• Model: ready ✓"
else
  echo "• Model: not installed — in Autocut click 'Model not installed' and import autocut-models.zip"
fi

echo
echo "Installed ✓  Restart Premiere if it is open."
open "$DEST/Autocut.app"
