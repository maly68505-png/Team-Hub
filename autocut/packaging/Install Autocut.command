#!/bin/bash
# Autocut installer — double-click (or: bash "Install Autocut.command")
# Installs Autocut.app, the Premiere Pro panel, and the offline model if
# autocut-models.zip sits next to this file. Needs no internet.
set -e
cd "$(dirname "$0")"
echo "=== تثبيت Autocut ==="

# stop a running older version so the new one starts fresh
pkill -f "autocut serve" 2>/dev/null || true

DEST="/Applications"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"
echo "• البرنامج ← $DEST/Autocut.app"
rm -rf "$DEST/Autocut.app"
ditto "Autocut.app" "$DEST/Autocut.app"
xattr -dr com.apple.quarantine "$DEST/Autocut.app" 2>/dev/null || true

EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.autocut.panel"
echo "• لوحة بريمير ← Window > Extensions > Autocut"
rm -rf "$EXT"
mkdir -p "$(dirname "$EXT")"
ditto "AutocutPanel" "$EXT"
xattr -dr com.apple.quarantine "$EXT" 2>/dev/null || true
# the panel is not signed by Adobe: allow unsigned extensions (CEP 9-13)
for v in 9 10 11 12 13; do defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1; done

CLI="$DEST/Autocut.app/Contents/Resources/bin/autocut"
if [ -f "autocut-models.zip" ]; then
  echo "• النموذج (بدون إنترنت) ..."
  "$CLI" models import "autocut-models.zip"
fi
if "$CLI" models status | grep -q '"ready": true'; then
  echo "• النموذج: جاهز ✓"
else
  echo "• النموذج: غير مثبت — من داخل Autocut اضغط «النموذج غير مثبت» واستورد autocut-models.zip"
fi

echo
echo "تم التثبيت ✓  أعد تشغيل بريمير إن كان مفتوحاً."
open "$DEST/Autocut.app"
