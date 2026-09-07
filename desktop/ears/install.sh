#!/bin/bash
# Makes EVE Ears a login agent: it starts at login and comes back within
# seconds if it dies, exactly like the face server and the hotkey. Interactive
# process type so the two permission prompts can reach the screen. Undo with
#   bash desktop/ears/install.sh --remove
set -euo pipefail
cd "$(dirname "$0")"

LABEL=com.umberto.eve.ears
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$(cd .. && pwd)/dist/EVE-Ears.app/Contents/MacOS/Ears"
LOG="$HOME/Library/Logs/eve-ears.log"

if [ "${1:-}" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$DEST"
  echo "removed: $LABEL"
  exit 0
fi

[ -x "$BIN" ] || { echo "build first: bash desktop/ears/build.sh"; exit 1; }
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "installed: $LABEL (starts at login, auto-restarts on death)"
echo "log: $LOG"
echo "undo with: bash desktop/ears/install.sh --remove"
