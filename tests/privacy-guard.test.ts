// The privacy guard — Umberto's personal data never leaves the machine through
// an ungated pipe.
//
// The failure this file guards against: EVE can recall personal memories
// (address, health, relationships, finances) and compose them into a research
// query, a delegated task, or a fetched URL — all UNGATED, all sent to third
// parties (Perplexity, OpenAI, arbitrary web servers) with nobody watching.
// "Best dermatologist near 1 Rue Exemple" is a leak wearing the clothes
// of a search. The email and message paths are gated and show Umberto the full
// text; these pipes had nothing.
//
// Two layers, deliberately different kinds of thing:
//   1. The RAIL (brain/prompt.ts, code-owned): the judgment half — health,
//      relationships, finances never go into external queries even when no
//      exact string matches. A model rule, because "is this too personal" is
//      a judgment call.
//   2. The GUARD (this module): the mechanical half — exact high-signal
//      identifiers (the street address, his email addresses, phone shapes,
//      credential shapes) checked at the pipe. Precise on purpose: a false
//      positive that blocks a legitimate query teaches the model to route
//      around the guard, and then it protects nothing.
//
// What is deliberately NOT blocked: his city ("Cergy") — local queries are
// functional, and a city carries no identity; his first name — the same.
// The guard protects the strings that identify HIM, not the strings that
// describe where he generally is.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-privacy-"));

const { personalDataIn, guardOutbound } = await import("../src/memory/privacy.js");
const { ROOT } = await import("../src/core/config.js");

// ── the scanner ────────────────────────────────────────────────────────────

test("the configured street address never leaves in an outbound query", () => {
  const hit = personalDataIn("best gluten-free pizza near 1 Rue Exemple");
  assert.ok(hit, "the exact address must be caught");
  assert.match(hit!.kind, /address/i);
});

test("his email addresses are caught — both of them", () => {
  assert.ok(personalDataIn("can you check if you@example.com is on the list"));
  assert.ok(personalDataIn("forward the results to eve@example.com please"));
});

test("phone-number shapes are caught even unformatted", () => {
  assert.ok(personalDataIn("the number to call is +39 340 123 4567"));
  assert.ok(personalDataIn("call 00333401234567 for the reservation"));
});

test("credentials still blocked — the existing filter is inherited", () => {
  assert.ok(personalDataIn("query with api_key sk-abc123def456ghi789"));
  assert.ok(personalDataIn("his IBAN is IT60X0542811101000000123456"));
});

test("ordinary queries pass — the guard must not teach route-around", () => {
  assert.equal(personalDataIn("best dermatologist for surgery in Paris"), null);
  assert.equal(personalDataIn("train times Cergy to central Paris tomorrow morning"), null);
  assert.equal(personalDataIn("healthy dinner options no fish no tofu"), null);
  // His city and first name are deliberately allowed: local queries are
  // functional and carry no identity.
  assert.equal(personalDataIn("weather in Cergy today"), null);
  assert.equal(personalDataIn("what books should Umberto read about accounting"), null);
});

// ── the guard at the pipes ─────────────────────────────────────────────────

test("guardOutbound refuses with a message that teaches generalising", () => {
  const err = guardOutbound("restaurants near 1 Rue Exemple open now");
  assert.ok(err, "a query carrying the address must be refused");
  assert.match(err!, /generalis|rephrase|without/i, "the refusal must say what to do instead");
  // And names the category, never the secret itself — refusal text reaches
  // tool results and logs, echoing the data would leak it at the very moment
  // of refusing.
  assert.ok(!err!.includes("36 Boulevard"), "the refusal must not echo the address");
});

test("guardOutbound passes the legitimate queries untouched", () => {
  assert.equal(guardOutbound("how does French student health insurance work"), null);
});

// ── the pipes are actually wired ───────────────────────────────────────────

test("deep_research, perplexity_search, delegate_to_ai and fetch_url all call the guard", async () => {
  const root = ROOT;
  const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8");
  for (const [file, name] of [
    ["src/tools/research.ts", "deep_research"],
    ["src/tools/perplexity.ts", "perplexity_search"],
    ["src/tools/delegate.ts", "delegate_to_ai"],
    ["src/tools/web.ts", "fetch_url"],
  ] as const) {
    const src = read(file);
    assert.ok(
      src.includes("guardOutbound"),
      `${file} must call guardOutbound — ${name} is an ungated pipe to a third party`,
    );
  }
});

test("the rail is in the code-owned ground rules, not the editable personality", async () => {
  const src = fs.readFileSync(path.join(ROOT, "src/brain/prompt.ts"), "utf8");
  assert.match(src, /never leaves the machine/i, "the privacy rail must exist");
  assert.match(src, /RAILS/, "…and it must live in the RAILS block, which identity.md cannot edit");
});
