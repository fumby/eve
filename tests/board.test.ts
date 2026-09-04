import test from "node:test";
import assert from "node:assert/strict";
import {
  parseDossier,
  gateCitations,
  entryHash,
  asBool,
  asText,
  asConfidence,
} from "../src/board/dossier.js";

const VALID = `---
id: testadvisor
name: Test Advisor
seat: Testing
domains: pricing, offers
status: active
---

# Doctrine

### D1 — Charge more
Source: Test Book, ch. 2 (2020)
Price is a positioning decision, not a cost calculation.

### D2 — Ship weekly
Source: Test Talk (2021)
Cadence beats intensity.

# Characteristic objection
Pushes back on discounting. Opens with: what would you charge if you were twice as confident?

# Blind spots
- No doctrine on regulated industries.

# Voice
Blunt, numeric, informal.
`;

test("parser accepts a valid dossier and exposes shown ids", () => {
  const r = parseDossier(VALID);
  assert.ok("seat" in r);
  const seat = r.seat;
  assert.equal(seat.id, "testadvisor");
  assert.deepEqual(seat.shownIds, ["D1", "D2"]);
  assert.equal(seat.doctrine[0].source, "Test Book, ch. 2 (2020)");
  assert.match(seat.objection, /discounting/);
  assert.match(seat.blindSpots, /regulated/);
});

test("parser rejects duplicate doctrine ids — ambiguous citations fail closed", () => {
  const dup = VALID.replace("### D2 — Ship weekly", "### D1 — Ship weekly");
  const r = parseDossier(dup, "dup.md");
  assert.ok("error" in r);
  assert.match(r.error.reason, /duplicate doctrine id D1/);
});

test("parser rejects a dossier with no domains", () => {
  const noDomains = VALID.replace("domains: pricing, offers", "domains: ");
  const r = parseDossier(noDomains, "nodomains.md");
  assert.ok("error" in r);
  assert.match(r.error.reason, /no domains/);
});

test("parser rejects a dossier with no live doctrine", () => {
  const noDoctrine = `---
id: x
name: X
domains: a
---

# Doctrine

# Voice
Terse.
`;
  const r = parseDossier(noDoctrine, "empty.md");
  assert.ok("error" in r);
  assert.match(r.error.reason, /nothing to cite/);
});

test("retired entries keep their id reserved but leave the shown set", () => {
  const retired = VALID.replace(
    "Source: Test Talk (2021)",
    "Source: Test Talk (2021)\nStatus: retired",
  );
  const r = parseDossier(retired);
  assert.ok("seat" in r);
  assert.deepEqual(r.seat.shownIds, ["D1"]); // D2 not shown to live seats
  assert.equal(r.seat.doctrine.length, 2); // …but its id is still spoken for
  assert.equal(r.seat.doctrine[1].retired, true);
});

test("citation gate strips fabrications, normalises case, dedupes, keeps order", () => {
  const gated = gateCitations(["d2", "D9", "D1", "D2", 42, { id: "D1" }, "D1"], ["D1", "D2"]);
  assert.deepEqual(gated, ["D2", "D1"]); // D9 fabricated, dupes dropped, junk dropped
});

test("citation gate validates against what the seat was SHOWN, not the whole file", () => {
  // D3 exists in the file but was retired — citing it must be stripped.
  assert.deepEqual(gateCitations(["D3", "D1"], ["D1", "D2"]), ["D1"]);
});

test("citation gate returns nothing for structurally hostile input", () => {
  assert.deepEqual(gateCitations("D1", ["D1"]), []);
  assert.deepEqual(gateCitations({ citations: ["D1"] }, ["D1"]), []);
  assert.deepEqual(gateCitations(null, ["D1"]), []);
});

test("entry hash changes when substance changes — the degradation trigger", () => {
  const a = entryHash({ source: "S", body: "original text" });
  const b = entryHash({ source: "S", body: "edited text" });
  const c = entryHash({ source: "S2", body: "original text" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, entryHash({ source: "S", body: "original text" }));
});

test('hostile booleans: the string "false" must never read as an abstention', () => {
  assert.equal(asBool(true), true);
  assert.equal(asBool("true"), true);
  assert.equal(asBool("false"), false); // truthy string, but NOT an abstention
  assert.equal(asBool(1), false);
  assert.equal(asBool({}), false);
});

test("scalar coercion drops structure where a sentence belonged", () => {
  assert.equal(asText("  a position  "), "a position");
  assert.equal(asText({ nested: "junk" }), "");
  assert.equal(asText(["array"]), "");
  assert.equal(asConfidence(0.7), 0.7);
  assert.equal(asConfidence("0.4"), 0.4);
  assert.equal(asConfidence(3), 1); // clamped
  assert.equal(asConfidence("high"), null);
});
