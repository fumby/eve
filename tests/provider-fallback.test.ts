// The fallback chain. A 429 or a 529 used to end the turn: in a terminal that
// is an annoyance you retype, but mid-sentence in a spoken conversation it is
// EVE stopping dead, and a voice UI has no "try again" button.
//
// What is worth protecting is all failure behaviour, so these tests drive the
// walk with an injected attempt that throws on cue rather than waiting on a
// real rate limit — which is also the only way to test the case that matters
// most: that a failure AFTER partial output is never retried.
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { runChain, worthFallingBack, chain, ProviderError, type Attempt, type ProviderEvent } from "../src/core/provider.js";
import { loadConfig } from "../src/core/config.js";

const CHAIN: Attempt[] = [{ model: "primary" }, { model: "backup" }, { model: "last-resort" }];

const text = (delta: string): ProviderEvent => ({ type: "text", delta });

// A fake attempt: `script` maps a model name to what it should do.
function attempts(script: Record<string, "ok" | Error>) {
  const tried: string[] = [];
  const attempt = async function* (entry: Attempt): AsyncGenerator<ProviderEvent> {
    tried.push(entry.model);
    const outcome = script[entry.model] ?? "ok";
    if (outcome !== "ok") throw outcome;
    yield text(`hello from ${entry.model}`);
  };
  return { attempt, tried };
}

const drain = async (gen: AsyncGenerator<ProviderEvent>): Promise<string> => {
  let out = "";
  for await (const ev of gen) if (ev.type === "text") out += ev.delta;
  return out;
};

const rateLimited = (): Error =>
  new Anthropic.RateLimitError(429, undefined, "rate_limit", undefined);
const overloaded = (): Error => new Anthropic.APIError(529, undefined, "overloaded", undefined);
const badKey = (): Error =>
  new Anthropic.AuthenticationError(401, undefined, "invalid x-api-key", undefined);

// ── which failures are worth another model ─────────────────────────────────

test("busy, missing and unreachable move on; a rejected key does not", () => {
  assert.equal(worthFallingBack(rateLimited()), true, "a 429 no longer falls back — this is the case it was built for");
  assert.equal(worthFallingBack(overloaded()), true, "529 overloaded no longer falls back");
  assert.equal(worthFallingBack(new Anthropic.APIConnectionError({})), true);
  assert.equal(worthFallingBack(new Anthropic.NotFoundError(404, undefined, "no such model", undefined)), true);
  // Falling past a rejected key would hide the one error whose message already
  // says exactly what to fix, and run the whole session somewhere he did not
  // choose.
  assert.equal(worthFallingBack(badKey()), false, "a bad API key now silently falls through to another model");
  assert.equal(worthFallingBack(new Error("something local")), false);
});

// ── the walk ───────────────────────────────────────────────────────────────

test("a busy model hands off to the next one and the turn survives", async () => {
  const { attempt, tried } = attempts({ primary: rateLimited() });
  let won = -1;
  const out = await drain(runChain(CHAIN, attempt, 0, (i) => (won = i)));
  assert.equal(out, "hello from backup");
  assert.deepEqual(tried, ["primary", "backup"]);
  assert.equal(won, 1, "the winning entry was not reported — the swap can never become sticky");
});

test("a failure AFTER text has been spoken is never retried", async () => {
  // The rule that keeps EVE from saying the first half of a sentence twice.
  const tried: string[] = [];
  const attempt = async function* (entry: Attempt): AsyncGenerator<ProviderEvent> {
    tried.push(entry.model);
    yield text("I was just saying");
    throw rateLimited();
  };
  await assert.rejects(() => drain(runChain(CHAIN, attempt, 0, () => {})), ProviderError);
  assert.deepEqual(tried, ["primary"], "a mid-stream failure retried — the listener hears the same words twice");
});

test("a rejected key stops the walk where it happened", async () => {
  const { attempt, tried } = attempts({ primary: badKey() });
  await assert.rejects(() => drain(runChain(CHAIN, attempt, 0, () => {})), /API key was rejected/);
  assert.deepEqual(tried, ["primary"]);
});

test("when every entry is busy, the error is the real one, not a chain error", async () => {
  const { attempt, tried } = attempts({
    primary: rateLimited(),
    backup: overloaded(),
    "last-resort": rateLimited(),
  });
  await assert.rejects(() => drain(runChain(CHAIN, attempt, 0, () => {})), /rate-limited/);
  assert.deepEqual(tried, ["primary", "backup", "last-resort"], "the walk stopped before the end of the chain");
});

test("a session already on the backup starts there, and never walks backwards", async () => {
  const { attempt, tried } = attempts({});
  const out = await drain(runChain(CHAIN, attempt, 1, () => {}));
  assert.equal(out, "hello from backup");
  assert.deepEqual(tried, ["backup"], "a sticky swap re-tried the model that had just refused");
});

test("an empty chain says which setting is wrong", async () => {
  await assert.rejects(() => drain(runChain([], async function* () {}, 0, () => {})), /check `model` in config.json/);
});

// ── configuration ──────────────────────────────────────────────────────────

test("the configured model is entry 0 and the fallbacks follow it in order", () => {
  const cfg = loadConfig();
  const entries = chain(cfg);
  assert.equal(entries[0]!.model, cfg.model, "the configured model is no longer tried first");
  assert.equal(entries.length, cfg.fallbacks.length + 1);
  for (let i = 0; i < cfg.fallbacks.length; i++) {
    assert.equal(entries[i + 1]!.model, cfg.fallbacks[i]!.model, "the fallbacks were reordered");
  }
});

test("a config with no fallbacks key is the old behaviour, not a crash", () => {
  const cfg = loadConfig();
  assert.ok(Array.isArray(cfg.fallbacks), "fallbacks is not an array — every turn would throw on an older config.json");
  const entries = chain({ ...cfg, fallbacks: [] });
  assert.deepEqual(entries, [{ model: cfg.model }]);
});
