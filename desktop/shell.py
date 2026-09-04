"""EVE.app shell — a chrome-less native window over EVE's local server.

The brain never moved: everything (voice pipeline, model calls, memory,
WebSocket) stays in the Node server at http://127.0.0.1:3939. This file is
only the window, plus the three native behaviors an embedded WKWebView
silently drops:

  Tier 2A  media-capture permission hook (without it, getUserMedia is denied
           with no prompt — pywebview 6.2.1 has no handler at all)
  Tier 3   window.open()/popups routed to the system browser (pywebview only
           routes real link clicks; JS window.open dies silently)
  Tier 4   a splash that starts the server when it's asleep and swaps to the
           real UI the moment it answers

Tier 2B (the OS attributing the mic prompt to EVE rather than to Python) is
solved by the bundle, not this file — see desktop/build.sh.

Run directly for development:   desktop/venv/bin/python desktop/shell.py
Self-checks (window flashes briefly):  ... shell.py --selftest[=title|mic|popup]
"""

import os
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
NODE_BIN = Path.home() / ".nvm/versions/node/v22.23.2/bin"


def resolve_url() -> str:
    """Where EVE lives. Local by default; once she runs in the cloud, put her
    tailnet address in desktop/eve-url.txt (or EVE_URL) and this window
    becomes a viewer of THAT EVE — it will never start a second one here."""
    env = os.environ.get("EVE_URL", "").strip()
    if env:
        return env if env.endswith("/") else env + "/"
    marker = PROJECT / "desktop" / "eve-url.txt"
    if marker.exists():
        text = marker.read_text().strip()
        if text:
            return text if text.endswith("/") else text + "/"
    return "http://127.0.0.1:3939/"


URL = resolve_url()
# The local server is only ever started for a local URL. If the URL points at
# the cloud and she isn't answering, the fix is Tailscale or the server —
# spawning a Mac copy would silently fork her memory (a takeover, unannounced).
LOCAL = URL.startswith("http://127.0.0.1") or URL.startswith("http://localhost")
SERVER_LOG = PROJECT / "logs" / "desktop-server.log"
WAKE_TIMEOUT_S = 60

# ---------------------------------------------------------------- tier 2A + 3
# The delegate subclass. pywebview looks its delegate class up by attribute at
# window-creation time, so swapping the class in BEFORE create_window is
# enough — no fork of the library.
def install_delegate_patches() -> None:
    import WebKit  # noqa: F401  (pyobjc)
    import webview.platforms.cocoa as cocoa

    Base = cocoa.BrowserView.BrowserDelegate
    grant = getattr(WebKit, "WKPermissionDecisionGrant", 1)

    class EveBrowserDelegate(Base):
        # Tier 2A: WKWebView asks "may this page capture media?" — with no
        # handler the answer defaults to deny, silently. Grant it; the OS-level
        # microphone permission (TCC) still applies on top, so this does not
        # bypass the real prompt — it lets the real prompt happen.
        def webView_requestMediaCapturePermissionForOrigin_initiatedByFrame_type_decisionHandler_(
            self, webview, origin, frame, media_type, decision_handler
        ):
            print("[eve-shell] media capture requested -> grant", file=sys.stderr)
            decision_handler(grant)

        # Tier 3: anything that wants a NEW web view (JS window.open, OAuth
        # pop-ups, target=_blank) goes to the system browser instead. The
        # stock implementation only handles real link clicks.
        def webView_createWebViewWithConfiguration_forNavigationAction_windowFeatures_(
            self, webview, config, action, features
        ):
            try:
                url = action.request().URL()
                s = url.absoluteString() if url is not None else ""
            except Exception:
                s = ""
            if s and not s.startswith("about:"):
                print(f"[eve-shell] popup -> system browser: {s}", file=sys.stderr)
                webbrowser.open(str(s))
            return None

    cocoa.BrowserView.BrowserDelegate = EveBrowserDelegate


# ---------------------------------------------------------------- tier 4
def server_is_up(timeout: float = 1.0) -> bool:
    try:
        with urllib.request.urlopen(URL, timeout=timeout) as res:
            return 200 <= res.status < 400
    except Exception:
        return False


SPLASH_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#05070B;display:flex;align-items:center;
    justify-content:center;font-family:-apple-system,sans-serif;color:rgba(255,255,255,.75)}
  .wrap{text-align:center}
  .orb{width:90px;height:90px;border-radius:50%;margin:0 auto 26px;
    background:radial-gradient(circle at 50% 45%, #fff 0%, #9ff0da 18%, #2DD4A8 45%, rgba(45,212,168,.12) 72%, transparent 75%);
    animation:pulse 2.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.12);opacity:1}}
  p{font-size:14px;letter-spacing:.06em;margin:0}
  .sub{font-size:11px;color:rgba(255,255,255,.35);margin-top:10px}
</style></head><body><div class="wrap">
  <div class="orb"></div>
  <p id="msg">Waking EVE up&hellip;</p>
  <p class="sub" id="sub"></p>
</div></body></html>"""


def start_server() -> None:
    """No supervisor exists for EVE, so launch the server directly — detached,
    so it (and the heartbeat) keeps running after the window closes."""
    SERVER_LOG.parent.mkdir(exist_ok=True)
    env = dict(os.environ)
    env["PATH"] = f"{NODE_BIN}:{env.get('PATH', '')}"
    with open(SERVER_LOG, "ab") as log:
        subprocess.Popen(
            [str(NODE_BIN / "npm"), "run", "--silent", "face", "--", "--no-open"],
            cwd=PROJECT,
            env=env,
            stdout=log,
            stderr=log,
            start_new_session=True,  # survives the app quitting, on purpose
        )


def wake_then_load(window) -> None:
    if not LOCAL:
        # Cloud EVE not answering: wait for her, never start a local one.
        print(f"[eve-shell] {URL} not answering — waiting (not starting a local server)", file=sys.stderr)
        window.evaluate_js(
            "document.getElementById('msg').textContent = 'Reaching EVE\\u2026';"
            f"document.getElementById('sub').textContent = '{URL} — is Tailscale connected on this Mac?';"
        )
    else:
        print("[eve-shell] server down — starting it", file=sys.stderr)
        try:
            start_server()
        except Exception as err:
            print(f"[eve-shell] failed to start server: {err}", file=sys.stderr)
    for _ in range(WAKE_TIMEOUT_S):
        if server_is_up():
            print("[eve-shell] server answered — loading UI", file=sys.stderr)
            window.load_url(URL)
            return
        time.sleep(1)
    # Never a blank window: say what happened and where to look.
    hint = f"See {SERVER_LOG} — or run: npm run face" if LOCAL else f"{URL} — check Tailscale, then the server (deploy.md)"
    window.evaluate_js(
        "document.getElementById('msg').textContent = 'EVE didn\\'t wake up.';"
        f"document.getElementById('sub').textContent = '{hint}';"
    )


# ---------------------------------------------------------------- selftests
def run_selftest(window, mode: str) -> None:
    def on_loaded() -> None:
        time.sleep(1.2)
        try:
            if mode == "title":
                title = window.evaluate_js("document.title")
                mic_btn = window.evaluate_js("!!document.getElementById('micBtn')")
                # mediaDevices is hidden by WebKit unless the HOSTING APP's
                # Info.plist carries NSMicrophoneUsageDescription — so this
                # line distinguishes dev mode (undefined) from the bundle
                # (object) without ever firing the real permission prompt.
                md = window.evaluate_js("typeof navigator.mediaDevices")
                print(f"SELFTEST title={title!r} micButton={mic_btn} mediaDevices={md}")
            elif mode == "mic":
                window.evaluate_js(
                    "window.__micResult='pending';"
                    "navigator.mediaDevices.getUserMedia({audio:true})"
                    ".then(s=>{s.getTracks().forEach(t=>t.stop());window.__micResult='GRANTED'})"
                    ".catch(e=>{window.__micResult='ERR:'+e.name}); 0"
                )
                result = "pending"
                for _ in range(16):
                    time.sleep(0.5)
                    result = window.evaluate_js("window.__micResult")
                    if result != "pending":
                        break
                print(f"SELFTEST mic={result}")
            elif mode == "popup":
                window.evaluate_js("window.open('https://example.com/'); 0")
                time.sleep(1.0)
                print("SELFTEST popup dispatched (interception should be logged above)")
        finally:
            window.destroy()

    window.events.loaded += on_loaded


# ---------------------------------------------------------------- main
def main() -> None:
    import webview

    selftest = None
    for arg in sys.argv[1:]:
        if arg.startswith("--selftest"):
            selftest = arg.split("=", 1)[1] if "=" in arg else "title"

    install_delegate_patches()

    up = server_is_up()
    window = webview.create_window(
        "EVE",
        url=URL if up else None,
        html=None if up else SPLASH_HTML,
        width=1280,
        height=820,
        min_size=(900, 600),
    )

    if selftest:
        run_selftest(window, selftest)
    if not up:
        threading.Thread(target=wake_then_load, args=(window,), daemon=True).start()

    webview.start()


if __name__ == "__main__":
    main()
