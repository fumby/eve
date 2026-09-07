// The small seams that let EVE run somewhere other than this Mac: same-origin
// sockets behind a proxy, atomic file writes, and local-time reminders.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameOrigin, reloadAllowedHosts } from "../src/face/origin.js";
import { writeFileAtomic } from "../src/core/atomic.js";
import { localDate, localMinute } from "../src/core/time.js";

test("sameOrigin: localhost page on the Mac is accepted, as before", () => {
  assert.equal(sameOrigin("http://127.0.0.1:3939", "127.0.0.1:3939"), true);
  assert.equal(sameOrigin("http://localhost:3939", "localhost:3939"), true);
  // The loopback spellings are one machine — she is opened by all of them.
  assert.equal(sameOrigin("http://localhost:3939", "127.0.0.1:3939"), true);
  assert.equal(sameOrigin("http://127.0.0.1:3939", "localhost:3939"), true);
  // A non-browser local client (no Origin): the check scripts. The HOST
  // check still applies, so this is loopback-only.
  assert.equal(sameOrigin(undefined, "127.0.0.1:3939"), true);
});

test("sameOrigin: the tailnet name is accepted only when a human allowlisted it", () => {
  // The allowlist is the anchor, so a name that was never added is refused —
  // the whole point of the fix. The old code accepted any host that merely
  // matched the request's own Host header.
  assert.equal(sameOrigin("https://eve.tail1234.ts.net", "eve.tail1234.ts.net"), false);
  // A human adds the tailnet name (via EVE_ALLOWED_HOSTS or
  // config.allowed-hosts); now the proxy spellings all pass.
  process.env.EVE_ALLOWED_HOSTS = "eve.tail1234.ts.net";
  reloadAllowedHosts();
  try {
    // Proxy preserves Host …
    assert.equal(sameOrigin("https://eve.tail1234.ts.net", "eve.tail1234.ts.net"), true);
    // … or hands it over as X-Forwarded-Host while Host is the loopback backend.
    assert.equal(sameOrigin("https://eve.tail1234.ts.net", "127.0.0.1:3939", "eve.tail1234.ts.net"), true);
    // Case-insensitive hostnames.
    assert.equal(sameOrigin("https://EVE.tail1234.ts.net", "eve.tail1234.ts.net"), true);
    // … and the allowlisted host does not open the door to anything else.
    assert.equal(sameOrigin("https://evil.example", "eve.tail1234.ts.net"), false);
  } finally {
    delete process.env.EVE_ALLOWED_HOSTS;
    reloadAllowedHosts();
  }
});

// This is the check that stands between EVE and any page Umberto happens to
// visit: browsers let a page open a socket to any host, so without it a random
// site could read her snapshot and answer her confirmation gate.
test("sameOrigin: any other site opening her socket is rejected", () => {
  assert.equal(sameOrigin("https://evil.example", "127.0.0.1:3939"), false);
  assert.equal(sameOrigin("not a url", "127.0.0.1:3939"), false);
  assert.equal(sameOrigin("http://127.0.0.1:3939", undefined), false);
  // A lookalike host must not pass on a prefix/suffix match.
  assert.equal(sameOrigin("https://eve.tail1234.ts.net.evil.example", "127.0.0.1:3939"), false);
});

// The case the 2026-08-22 audit actually broke: after a DNS rebind, Origin
// and Host are BOTH the attacker's domain, so the old compare-them-to-each-
// other check accepted by construction. Against the allowlist the rebound
// Host is simply not on the list — nothing the request says can fix that.
test("sameOrigin: a DNS-rebound host is refused even though Origin 'matches' Host", () => {
  assert.equal(sameOrigin("https://evil.example", "evil.example:3939"), false);
  // Rebind behind a proxy: Host is loopback, X-Forwarded-Host is the lie.
  assert.equal(sameOrigin("https://evil.example", "127.0.0.1:3939", "evil.example"), false);
  // Origin allowed but Host rebound: still refused — both gates are required.
  process.env.EVE_ALLOWED_HOSTS = "good.example";
  reloadAllowedHosts();
  try {
    assert.equal(sameOrigin("https://good.example", "evil.example:3939"), false);
  } finally {
    delete process.env.EVE_ALLOWED_HOSTS;
    reloadAllowedHosts();
  }
});

test("writeFileAtomic: the target holds the full contents and no temp file is left behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-atomic-"));
  const target = path.join(dir, "state.json");
  writeFileAtomic(target, '{"a":1}\n');
  writeFileAtomic(target, '{"a":2}\n');
  assert.equal(fs.readFileSync(target, "utf8"), '{"a":2}\n');
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("localMinute/localDate: local wall clock, the shape reminders are stored in", () => {
  const d = new Date(2026, 7, 15, 9, 5); // 15 Aug 2026 09:05 local, whatever the TZ
  assert.equal(localDate(d), "2026-08-15");
  assert.equal(localMinute(d), "2026-08-15T09:05");
  // A reminder due "now" in local time is due — the UTC comparison this
  // replaces would have said "not yet" for the length of the UTC offset.
  assert.ok("2026-08-15T09:05" <= localMinute(d));
});
