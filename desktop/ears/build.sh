#!/bin/bash
# Builds EVE-Ears.app — a fixed launcher stub in an ad-hoc-signed bundle, and
# the real code as a dylib kept next to the bundle. Same recipe as
# ../quickbar/build.sh for the bundle; the split exists because macOS privacy
# identifies an ad-hoc app by its executable's hash, and a helper that needs
# Microphone and Speech Recognition must keep the same hash across rebuilds or
# be allowed again at the screen every time (see the header of Ears.swift).
#
# The stub is compiled only when build/stub/Ears is missing (delete it to
# force a new identity — and expect the two prompts again). The bundle is
# re-assembled from identical parts, so its cdhash stays put; the script
# prints it and refuses to finish if it drifted from the recorded one.
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build/stub ../dist/EVE-Ears-lib

APP="../dist/EVE-Ears.app"
LIB="../dist/EVE-Ears-lib/libEars.dylib"
ICON_SRC="../dist/EVE.app/Contents/Resources/EVE.icns"

echo "== compiling the library =="
# -swift-version 5: callbacks and a run loop; Swift 6's strict concurrency
# has nothing to protect here and a lot to object to.
swiftc -O -swift-version 5 -parse-as-library -emit-library -module-name EarsLib Ears.swift -o "$LIB"
codesign --force -s - "$LIB"
echo "libEars.dylib: clean"

if [ ! -x build/stub/Ears ]; then
  echo "== compiling the launcher stub (once) =="
  swiftc -O -swift-version 5 EarsStub.swift -o build/stub/Ears
  echo "stub: clean (new identity — the two permission prompts will show again)"
fi

echo "== assembling $APP =="
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp build/stub/Ears "$APP/Contents/MacOS/Ears"
[ -f "$ICON_SRC" ] && cp "$ICON_SRC" "$APP/Contents/Resources/AppIcon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>EVE Ears</string>
  <key>CFBundleDisplayName</key><string>EVE Ears</string>
  <key>CFBundleIdentifier</key><string>com.umberto.eve.ears</string>
  <key>CFBundleExecutable</key><string>Ears</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>EVE Ears listens for "Hey Eve" so you can talk to EVE from across the room.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>EVE Ears recognises "Hey Eve" on this Mac, on-device — nothing is sent anywhere until you say it.</string>
</dict>
</plist>
PLIST

echo "== ad-hoc signing =="
codesign --force -s - --identifier com.umberto.eve.ears "$APP"
# The identity TCC keys on is the designated requirement: for an ad-hoc
# signature that is `cdhash H"…"` of the main executable.
CDHASH=$(codesign -d -r- "$APP" 2>&1 | sed -n 's/.*designated => cdhash H"\([0-9a-f]*\)".*/\1/p')
[ -n "$CDHASH" ] || { echo "!! could not read the app's cdhash"; exit 1; }
if [ -f build/stub/cdhash ]; then
  if [ "$(cat build/stub/cdhash)" != "$CDHASH" ]; then
    echo "!! the app's identity drifted: $(cat build/stub/cdhash) → $CDHASH — permissions will be asked again"
    echo "$CDHASH" > build/stub/cdhash
    exit 1
  fi
else
  echo "$CDHASH" > build/stub/cdhash
fi
echo "signature: ok — identity (cdhash) $CDHASH"
echo
echo "Build complete: $(cd .. && pwd)/dist/EVE-Ears.app  (code: $(cd .. && pwd)/dist/EVE-Ears-lib/libEars.dylib)"
