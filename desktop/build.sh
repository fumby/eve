#!/bin/bash
# Builds desktop/dist/EVE.app — a hand-rolled, ad-hoc-signed macOS bundle.
#
# The one subtle move (Tier 2, Problem B): the bundle embeds the REAL
# framework interpreter binary (Python.app/Contents/MacOS/Python), not
# bin/python3.13 — the latter is a launcher that re-execs the framework copy,
# which would flip the process's main bundle back to Python.app and silently
# kill the microphone. With the real binary inside our bundle, the main bundle
# is EVE.app, which carries the NSMicrophoneUsageDescription below, so the
# mic prompt names EVE.
set -euo pipefail
cd "$(dirname "$0")"

PROJECT="$(cd .. && pwd)"
APP=dist/EVE.app
PYFW=/Library/Frameworks/Python.framework/Versions/3.13
BUNDLE_ID=com.umberto.eve

echo "== assembling $APP =="
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# ---- icon ------------------------------------------------------------
if [ ! -f icon_1024.png ]; then
  venv/bin/python make-icon.py
fi
rm -rf EVE.iconset && mkdir EVE.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s icon_1024.png --out "EVE.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d icon_1024.png --out "EVE.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns EVE.iconset -o "$APP/Contents/Resources/EVE.icns"
echo "icon: ok"

# ---- Info.plist ------------------------------------------------------
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>EVE</string>
  <key>CFBundleDisplayName</key><string>EVE</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>EVE</string>
  <key>CFBundleIconFile</key><string>EVE.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>EVE listens only while you hold the mic open — your voice goes to speech recognition and nowhere else.</string>
</dict>
</plist>
PLIST
echo "plist: ok"

# ---- embedded interpreter (Problem B) --------------------------------
cp "$PYFW/Resources/Python.app/Contents/MacOS/Python" "$APP/Contents/MacOS/EVE-python"
echo "embedded interpreter: ok"

# ---- launcher --------------------------------------------------------
cat > "$APP/Contents/MacOS/EVE" <<LAUNCH
#!/bin/bash
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
export PYTHONHOME="$PYFW"
export PYTHONPATH="$PROJECT/desktop/venv/lib/python3.13/site-packages"
cd "$PROJECT"
mkdir -p logs
exec "\$DIR/EVE-python" desktop/shell.py "\$@" >> logs/desktop.log 2>&1
LAUNCH
chmod +x "$APP/Contents/MacOS/EVE"
echo "launcher: ok"

# ---- ad-hoc signature (stable identity for the TCC mic grant) --------
codesign --force -s - --identifier "$BUNDLE_ID" "$APP/Contents/MacOS/EVE-python"
codesign --force -s - --identifier "$BUNDLE_ID" "$APP"
echo "signature: ok"

echo
echo "Build complete: $(pwd)/$APP"
echo "Launch with:    open $(pwd)/$APP"
echo "Then drag it to the Dock and keep it there."
