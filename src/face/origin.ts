// Same-origin test for browser sockets — the fixed-anchor version.
//
// The 2026-08-22 security audit's top finding: the old check compared the
// request's Origin header against the request's OWN Host header — both
// attacker-supplied. After a DNS rebind (evil.test → 127.0.0.1) they agree by
// construction, and a malicious page Umberto merely visited could open the
// socket, read the full memory snapshot, drive voice turns, and answer the
// Tier 6 confirmation gate on his behalf.
//
// The fix is structural: both headers are validated against a FIXED
// allowlist that no request can influence. Rebinding can make evil.test
// resolve to loopback; it cannot make "evil.test" a member of this set.
//
// Why a missing Origin is still allowed: browsers ALWAYS attach Origin to a
// WebSocket handshake — it is the one thing the attacker's page cannot omit
// or forge. A missing Origin therefore means a non-browser client (the
// headless check scripts, curl), not a browser attack; and a remote
// attacker's browser cannot produce that case. The Host check carries the
// load for those: a rebound request arrives with Host: evil.test, which is
// not on the allowlist, and is refused before Origin is even consulted.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../core/config.js";

// Loopback spellings are one host.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const canon = (h: string): string => (LOOPBACK.has(h) ? "localhost" : h);

// Extra hosts join via config.allowed-hosts in the checkout root — one
// hostname per line, "#" starts a comment. This is the one place a human
// widens the door ON PURPOSE (e.g. the tailnet name if Tailscale Serve is
// ever enabled), in config, never through a request. Absent file = loopback
// only, which is the safe default and the documented posture.
const HOSTS_FILE = path.join(ROOT, "config.allowed-hosts");

function loadAllowlist(): Set<string> {
  const hosts = new Set(LOOPBACK);
  for (const raw of (process.env.EVE_ALLOWED_HOSTS ?? "").split(",")) {
    const h = canon(raw.trim().toLowerCase());
    if (h && h !== "localhost") hosts.add(h);
  }
  try {
    for (const raw of fs.readFileSync(HOSTS_FILE, "utf8").split(/\r?\n/)) {
      const line = canon(raw.split("#")[0]!.trim().toLowerCase());
      if (line && !hosts.has(line)) hosts.add(line);
    }
  } catch {
    // No allowlist file = loopback only. Not an error: it is the default.
  }
  return hosts;
}

// Loaded lazily, once per process. A file an attacker could edit is a
// machine they are already on; a request must never be able to change it.
// Tests call reloadAllowedHosts() after pointing EVE_ALLOWED_HOSTS at the
// hosts they want to pin, because import-time loading would freeze the
// module's first importer's environment into every test after it.
let allowed = new Set<string>();
let loaded = false;

export function reloadAllowedHosts(): ReadonlySet<string> {
  allowed = loadAllowlist();
  loaded = true;
  return allowed;
}

/** The active allowlist. Loopback plus anything a human put in config/env. */
export function allowedHosts(): ReadonlySet<string> {
  if (!loaded) reloadAllowedHosts();
  return allowed;
}

function hostnameOf(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s) return null;
  try {
    return canon(new URL(`http://${s}`).hostname.toLowerCase());
  } catch {
    return null;
  }
}

export function isAllowedHost(v: string | string[] | undefined): boolean {
  const h = hostnameOf(v);
  return h !== null && allowedHosts().has(h);
}

// The check the upgrade handler calls. Two independent gates, each compared
// to the allowlist (never to each other):
//   1. Host — or X-Forwarded-Host behind a TLS-terminating proxy — must be
//      allowlisted. This is the rebinding kill: the rebound request's Host
//      is the attacker's domain.
//   2. A PRESENT Origin must be allowlisted. A browser always sends one, so
//      an attacker's page cannot slip past; a missing Origin is a non-browser
//      local client and falls through to the Host check, which it passes only
//      as loopback.
export function sameOrigin(
  origin: string | undefined,
  host: string | string[] | undefined,
  forwardedHost?: string | string[],
): boolean {
  // Gate 1: Host. Behind a proxy the browser's true Host arrives forwarded;
  // EITHER being allowlisted is fine because both are checked against the
  // fixed list, never against each other.
  if (!isAllowedHost(host) && !isAllowedHost(forwardedHost)) return false;

  // Gate 2: Origin, when the client sent one.
  if (origin) {
    let originHost: string;
    try {
      originHost = canon(new URL(origin).hostname.toLowerCase());
    } catch {
      return false; // malformed origin — refuse
    }
    if (!allowedHosts().has(originHost)) return false;
  }
  return true;
}
