#!/bin/bash
# Builds EVE-QuickBar.app and EVE-Orb.app — two small, hand-rolled,
# ad-hoc-signed macOS bundles. Plain Swift, no Python (contrast with
# ../build.sh which embeds a Python framework interpreter).
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p build ../dist

ICON_SRC="../dist/EVE.app/Contents/Resources/EVE.icns"

echo "== compiling =="
swiftc -O QuickBar.swift -o build/QuickBar
echo "QuickBar: clean"
swiftc -O Orb.swift -o build/Orb
echo "Orb: clean"

make_plist() {
  local path="$1" name="$2" display="$3" exe="$4" bundleid="$5"
  cat > "$path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${display}</string>
  <key>CFBundleIdentifier</key><string>${bundleid}</string>
  <key>CFBundleExecutable</key><string>${exe}</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
}

assemble() {
  local app="$1" exe="$2" name="$3" display="$4" bundleid="$5"
  echo "== assembling $app =="
  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "build/$exe" "$app/Contents/MacOS/$exe"
  cp "$ICON_SRC" "$app/Contents/Resources/AppIcon.icns"
  make_plist "$app/Contents/Info.plist" "$name" "$display" "$exe" "$bundleid"
}

assemble "../dist/EVE-QuickBar.app" "QuickBar" "EVE QuickBar" "EVE QuickBar" "com.umberto.eve.quickbar"
assemble "../dist/EVE-Orb.app"      "Orb"      "EVE Orb"      "EVE Orb"      "com.umberto.eve.orb"

echo "== ad-hoc signing =="
codesign --force -s - --identifier com.umberto.eve.quickbar ../dist/EVE-QuickBar.app
codesign --force -s - --identifier com.umberto.eve.orb ../dist/EVE-Orb.app
echo "signatures: ok"

echo
echo "Build complete:"
echo "  $(pwd)/../dist/EVE-QuickBar.app"
echo "  $(pwd)/../dist/EVE-Orb.app"
