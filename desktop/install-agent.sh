#!/bin/bash
# Makes EVE's server a login agent: macOS starts it at login and brings it
# back within seconds if it dies. Run once; survives reboots. To undo:
#   launchctl bootout gui/$(id -u)/com.umberto.eve.face
#   rm ~/Library/LaunchAgents/com.umberto.eve.face.plist
set -euo pipefail
cd "$(dirname "$0")"

LABEL=com.umberto.eve.face
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"

chmod +x run-server.sh
mkdir -p "$HOME/Library/LaunchAgents"
cp "$LABEL.plist" "$DEST"

# If an old copy of the agent is registered, replace it cleanly.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Hand ownership to launchd: stop any manually-started server first.
PIDS=$(lsof -ti tcp:3939 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "stopping manually-started server (pid $PIDS) — launchd takes over"
  kill $PIDS
  sleep 1
fi

launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "installed: $LABEL (starts at login, auto-restarts on death)"
echo "undo with: launchctl bootout gui/\$(id -u)/$LABEL && rm $DEST"
