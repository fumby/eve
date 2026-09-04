// Same-origin test for browser sockets. The page that opened the socket must
// have been served by this host — 127.0.0.1/localhost on the Mac, the tailnet
// name behind Tailscale Serve. Behind a TLS-terminating proxy the browser's
// Host may arrive as X-Forwarded-Host, so both are accepted. Hostnames are
// compared, not ports: the proxy's port and the app's port legitimately differ.
//
// Asking only "do Origin and Host agree?" is the wrong question, because one
// attacker can supply both. Under DNS rebinding a page on evil.example whose
// DNS flips to 127.0.0.1 sends Origin: http://evil.example and Host:
// evil.example — a flawless match that names nowhere EVE is served, and it
// bought that page /api/mind-map and the confirmation gate. So the host that
// matches must ALSO be a name she actually answers to.

// The loopback spellings are one machine — she is opened by all of them (the
// server prints 127.0.0.1, a human types localhost, Node reports IPv6 with the
// brackets on).
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Where EVE is really reachable: this machine, or her tailnet name behind
// Tailscale Serve. The leading dot is load-bearing — a bare "ts.net" suffix
// test would hand the socket to evilts.net.
export function isAllowedHost(host: string | null): boolean {
  if (!host) return false;
  return LOOPBACK.has(host) || host.endsWith(".ts.net");
}

export function sameOrigin(
  origin: string,
  host: string | string[] | undefined,
  forwardedHost?: string | string[],
): boolean {
  const hostOf = (v: string | string[] | undefined): string | null => {
    const s = Array.isArray(v) ? v[0] : v;
    if (!s) return null;
    try {
      return new URL(`http://${s}`).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  let originHost: string;
  try {
    originHost = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  const canon = (h: string): string => (LOOPBACK.has(h) ? "localhost" : h);
  return [hostOf(forwardedHost), hostOf(host)].some(
    (h) => h !== null && isAllowedHost(h) && canon(h) === canon(originHost),
  );
}
