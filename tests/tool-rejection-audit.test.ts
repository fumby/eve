// A refused tool call must leave an audit line.
//
// The evening of 2026-09-06, the "ho fame" turn requested open_options_window
// (the face showed the step), the arguments failed schema validation, and
// Registry.execute returned the validation error to the model WITHOUT
// writing anything to the audit trail. The round after died on the context
// ceiling, the turn_error went to a dead socket — and the audit log said
// the turn simply stopped existing: no tool_ran, no rejection, nothing
// between the last usage line and silence. The same hole exists for a
// tool name that isn't registered at all. Both refusals are real events in
// the trail: they explain a step the user SAW (the face had already
// announced it) but the log never mentioned.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-reject-"));

const { Registry } = await import("../src/core/registry.js");
const { STATE_ROOT } = await import("../src/core/config.js");

type AuditLine = { event?: string; tool?: string; reason?: string };
const auditLines = (): AuditLine[] => {
  const log = path.join(STATE_ROOT, "logs", "audit.jsonl");
  try {
    return fs
      .readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as AuditLine);
  } catch {
    return []; // no log yet — no events, which is exactly the red state
  }
};

const registry = new Registry();
registry.register({
  name: "echo_probe",
  description: "test-only tool",
  schema: z.object({ text: z.string().min(2) }),
  needsConfirmation: false,
  run: async () => "ok",
});

test("a schema-validation refusal is audited, not silent", async () => {
  const res = await registry.execute("echo_probe", { text: "" }); // min(2) violated
  assert.equal(res.isError, true, "the refusal is an error result, as before");
  const lines = auditLines().filter((l) => l.event === "tool_rejected");
  assert.equal(lines.length, 1, "exactly one tool_rejected line");
  assert.equal(lines[0]!.tool, "echo_probe");
  assert.match(lines[0]!.reason ?? "", /text/, "the reason names what failed");
});

test("an unregistered tool name is audited too", async () => {
  const res = await registry.execute("no_such_tool", {});
  assert.equal(res.isError, true);
  const lines = auditLines().filter((l) => l.event === "tool_rejected" && l.tool === "no_such_tool");
  assert.equal(lines.length, 1, "the unknown tool call is in the trail");
});

test("a successful run still audits exactly one tool_ran, no tool_rejected", async () => {
  const before = auditLines().length;
  const res = await registry.execute("echo_probe", { text: "hello" });
  assert.equal(res.isError, false);
  const since = auditLines().slice(before);
  assert.ok(since.some((l) => l.event === "tool_ran" && l.tool === "echo_probe"), "tool_ran as always");
  assert.ok(!since.some((l) => l.event === "tool_rejected"), "no phantom rejection");
});
