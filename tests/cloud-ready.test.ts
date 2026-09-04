// The small seams that let EVE run somewhere other than this Mac: same-origin
// sockets behind a proxy, atomic file writes, and local-time reminders.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sameOrigin, isAllowedHost } from "../src/face/origin.js";
import { writeFileAtomic } from "../src/core/atomic.js";
import { localDate, localMinute } from "../src/core/time.js";

test("sameOrigin: localhost page on the Mac is accepted, as before", () => {
  assert.equal(sameOrigin("http://127.0.0.1:3939", "127.0.0.1:3939"), true);
  assert.equal(sameOrigin("http://localhost:3939", "localhost:3939"), true);
  // The loopback spellings are one machine — she is opened by all of them.
  assert.equal(sameOrigin("http://localhost:3939", "127.0.0.1:3939"), true);
  assert.equal(sameOrigin("http://127.0.0.1:3939", "localhost:3939"), true);
});

test("sameOrigin: the tailnet name behind Tailscale Serve is accepted", () => {
  // Proxy preserves Host …
  assert.equal(sameOrigin("https://eve.tail1234.ts.net", "eve.tail1234.ts.net"), true);
  // … or hands it over as X-Forwarded-Host while Host is the loopback backend.
  assert.equal(sameOrigin("https://eve.tail1234.ts.net", "127.0.0.1:3939", "eve.tail1234.ts.net"), true);
  // Case-insensitive hostnames.
  assert.equal(sameOrigin("https://EVE.tail1234.ts.net", "eve.tail1234.ts.net"), true);
});

// This is the check that stands between EVE and any page Umberto happens to
// visit: browsers let a page open a socket to any host, so without it a random
// site could read her snapshot and answer her confirmation gate.
test("sameOrigin: any other site opening her socket is rejected", () => {
  assert.equal(sameOrigin("https://evil.example", "eve.tail1234.ts.net"), false);
  assert.equal(sameOrigin("https://evil.example", "127.0.0.1:3939", "eve.tail1234.ts.net"), false);
  assert.equal(sameOrigin("https://evil.example", "127.0.0.1:3939"), false);
  assert.equal(sameOrigin("not a url", "127.0.0.1:3939"), false);
  assert.equal(sameOrigin("http://127.0.0.1:3939", undefined), false);
  // A lookalike host must not pass on a prefix/suffix match.
  assert.equal(sameOrigin("https://eve.tail1234.ts.net.evil.example", "eve.tail1234.ts.net"), false);
});

// Matching Origin against Host answers "do these agree?", which is the wrong
// question when one attacker supplies both. A page on evil.com whose DNS flips
// to 127.0.0.1 sends Origin: http://evil.com AND Host: evil.com — they agree
// perfectly and name nowhere EVE is served. Every line here was accepted until
// the check also required the host to be a name she answers to.
test("sameOrigin: DNS rebinding cannot satisfy the check by agreeing with itself", () => {
  assert.equal(sameOrigin("http://evil.example", "evil.example:3939"), false);
  assert.equal(sameOrigin("http://evil.example:3939", "evil.example:3939"), false);
  assert.equal(sameOrigin("https://evil.example", "evil.example"), false);
  // The same trick carried on the proxy header instead.
  assert.equal(sameOrigin("http://evil.example", "127.0.0.1:3939", "evil.example"), false);
  assert.equal(sameOrigin("http://evil.example", "evil.example:3939", "evil.example:3939"), false);
  // Hosts that merely end in the right letters are not the tailnet, and a
  // subdomain of the word localhost is not this machine.
  assert.equal(sameOrigin("https://evilts.net", "evilts.net"), false);
  assert.equal(sameOrigin("https://ts.net.evil.example", "ts.net.evil.example"), false);
  assert.equal(sameOrigin("http://localhost.evil.example", "localhost.evil.example"), false);
});

test("isAllowedHost: only this machine and the tailnet are names she answers to", () => {
  for (const h of ["localhost", "127.0.0.1", "::1", "[::1]", "eve.tail1234.ts.net"]) {
    assert.equal(isAllowedHost(h), true, h);
  }
  for (const h of ["evil.example", "localhost.evil.example", "evilts.net", "ts.net.evil.example", ""]) {
    assert.equal(isAllowedHost(h), false, JSON.stringify(h));
  }
  assert.equal(isAllowedHost(null), false);
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
