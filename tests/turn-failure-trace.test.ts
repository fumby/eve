// A failed turn must leave a trace — in the audit trail and in Umberto's
// notice inbox.
//
// The evening of 2026-09-06, the "ho fame" turn died between the model's
// last call and the options window: a provider 400 (the conversation had
// grown to the 200K context ceiling) threw into textTurn's catch, which
// sent turn_error to whoever was on the socket and… nothing else. No audit
// line, no notice. The phone had already missed the turn_error (dead
// socket), so on reconnect the face kept rendering the stale "working"
// panel — "preparing options for you, in progress" — for two hours, with
// nothing on disk to say the turn had ever failed. The only evidence the
// turn existed was a usage line. This pins the two traces every failed
// turn must leave:
//   1. an audit line (turn_error), so the trail explains the gap;
//   2. a quiet notice, so the inbox — which survives reconnects — says
//      what went wrong even if every socket missed it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-turnfail-"));

const { FaceTurns } = await import("../src/face/turns.js");
const { Registry } = await import("../src/core/registry.js");
const { STATE_ROOT } = await import("../src/core/config.js");
const { listNotices } = await import("../src/core/notices.js");
type AuditLine = { event?: string; message?: string };
const auditLines = (): AuditLine[] =>
  fs
    .readFileSync(path.join(STATE_ROOT, "logs", "audit.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditLine);

// A stream that throws the way the provider did that evening: mid-turn,
// after nothing has been yielded (the failing round was the empty recovery
// round after the tool result could not be sent).
const explodingStream = async function* () {
  throw new Error("The model provider returned an error: prompt is too long: 204104 tokens > 200000 maximum");
};

function harness() {
  const sent: { type: string; message?: string }[] = [];
  const turns = new FaceTurns(new Registry(), (m) => sent.push(m as { type: string }), explodingStream);
  return { turns, sent };
}

test("a failed turn leaves an audit line and a notice, not just a socket message", async () => {
  const { turns, sent } = harness();
  await turns.textTurn("ho fame", { speak: false });

  // What he sees on a healthy socket is unchanged…
  assert.ok(sent.some((m) => m.type === "turn_error" && /prompt is too long/.test(m.message ?? "")), "the live socket still gets the error");

  // …but the turn can no longer vanish without a trace on disk:
  const audited = auditLines().filter((l) => l.event === "turn_error");
  assert.equal(audited.length, 1, "exactly one turn_error audit line");
  assert.match(audited[0]!.message ?? "", /prompt is too long/, "the audit line carries the real error, not a vague one");

  const notices = listNotices().filter((n) => n.check === "turn-error");
  assert.equal(notices.length, 1, "one notice in the inbox");
  assert.match(notices[0]!.text, /prompt is too long/, "the notice says what actually went wrong");
  assert.equal(notices[0]!.loudness, "quiet", "quiet: it's in the inbox, not an interruption");

  // And the state machine still lands where it must:
  assert.equal(turns.state, "idle", "the turn ended — no eternal 'processing'");
});
