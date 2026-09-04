# EVE.app — the desktop app

A chrome-less native window (WKWebView via pywebview) over EVE's local server,
bundled as a dock-launchable macOS app. The brain never moved: everything runs
in the Node server at `http://127.0.0.1:3939`; this is only the window.

## Build and launch

```
bash desktop/build.sh          # → desktop/dist/EVE.app
open desktop/dist/EVE.app      # launch; then drag it to the Dock and keep it
```

Quitting the app leaves the server (and EVE's heartbeat) running on purpose.

## Always on (login agent)

The server is registered as a macOS LaunchAgent (`com.umberto.eve.face`):
macOS starts it at login and resurrects it within seconds if it dies — so the
heartbeat (and the repo watch) run whenever the Mac is awake, no manual
starts. Reinstall/repair with `bash desktop/install-agent.sh`. Remove with:

```
launchctl bootout gui/$(id -u)/com.umberto.eve.face
rm ~/Library/LaunchAgents/com.umberto.eve.face.plist
```

While the agent is installed, `kill $(lsof -ti tcp:3939)` only restarts the
server — removing the agent (above) is how you actually stop EVE.

## What the shell patches in (and why)

- **Mic, half 1** — WKWebView's media-permission hook is absent in pywebview,
  so `getUserMedia` is denied silently; the delegate subclass grants it (the
  real macOS prompt still applies on top).
- **Mic, half 2** — macOS reads the mic usage string from the *hosting
  process's main bundle*. Under plain `python3` that's Python.app (no string →
  WebKit hides `navigator.mediaDevices` entirely). The bundle embeds the real
  framework interpreter binary (`Python.app/Contents/MacOS/Python` — NOT
  `bin/python3.13`, which re-execs and flips the bundle back), so the main
  bundle is EVE.app and the prompt names EVE.
- **Pop-ups** — JS `window.open()` dies silently in an embedded view; the
  delegate routes it (and `target=_blank`) to the system browser.
- **Cold start** — if the server is down, a pulsing-orb splash appears, the
  app starts `npm run face -- --no-open` itself (detached), polls up to 60 s,
  and swaps to the UI; on failure it says so and names the log.

## Troubleshooting (these all fail quietly)

- **Mic prompt never appears** → wrong main bundle or missing usage string:
  check `ps` shows `EVE-python` hosting the window and the plist carries
  `NSMicrophoneUsageDescription`. In-app check: `--selftest` must print
  `mediaDevices=object` (dev mode prints `undefined` — that's expected there).
- **Prompt appears but audio dead** → grant hook not firing: `logs/desktop.log`
  should show `media capture requested -> grant`.
- **Sign-in/external link does nothing** → popup routing: the log should show
  `popup -> system browser: <url>`.
- **Blank window on launch** → server down and splash failed: read
  `logs/desktop-server.log`.
- **Mic re-prompts after reboot** → unstable identity: `codesign -dv
  desktop/dist/EVE.app` must show `Identifier=com.umberto.eve`; a TCC reset is
  `tccutil reset Microphone com.umberto.eve`.
- **Generic dock icon** → rebuild; `EVE.icns` must exist in
  `Contents/Resources` and be named in the plist.

## Files

`shell.py` (window + the three patches + splash), `build.sh` (bundle, icon,
plist, embedded interpreter, launcher, ad-hoc signature), `make-icon.py`
(stdlib-only orb icon). `venv/` and `dist/` are git-ignored build products.

Local-only: the ad-hoc signature is valid on this Mac alone. Distributing to
others needs a Developer ID certificate + notarization (and stricter
entitlements) — deliberately out of scope.
