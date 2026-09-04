#!/bin/bash
# launchd's way into EVE's server. If a manually-started server already owns
# the port, wait politely instead of crash-looping; the moment the port frees
# up, take over. When the server dies, this process exits and launchd
# (KeepAlive) respawns it within seconds — that's the resurrection.
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
cd "$HOME/TRILLION" || exit 1
mkdir -p logs

# Only a LISTENing socket means another server owns the port. A bare
# `lsof -ti tcp:3939` also matches client connections (a face tab's WebSocket,
# even half-closed ones), which once kept this loop standing by forever after
# a restart while a browser was open.
while lsof -nP -iTCP:3939 -sTCP:LISTEN >/dev/null 2>&1; do
  echo "[agent] port 3939 already served — standing by"
  sleep 15
done

exec npm run --silent face -- --no-open
