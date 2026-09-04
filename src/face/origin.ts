// Same-origin test for browser sockets. The page that opened the socket must
// have been served by this host — 127.0.0.1/localhost on the Mac, the tailnet
// name behind Tailscale Serve. Behind a TLS-terminating proxy the browser's
// Host may arrive as X-Forwarded-Host, so both are accepted. Hostnames are
// compared, not ports: the proxy's port and the app's port legitimately differ.
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
  // localhost, 127.0.0.1 and ::1 are the same machine — she is reached by all
  // three spellings here (the server prints 127.0.0.1, a human types localhost).
  const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
  const canon = (h: string): string => (LOOPBACK.has(h) ? "localhost" : h);
  return [hostOf(forwardedHost), hostOf(host)].some(
    (h) => h !== null && canon(h) === canon(originHost),
  );
}
