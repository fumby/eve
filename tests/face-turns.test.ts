// The face's turn loop, at the one rule that changed on 2026-09-06: a message
// that arrives while she is SPEAKING cuts her off. Umberto's words: "if I send
// her another message or I talk to her, she has to stop saying what she was
// saying and listen to what I'm telling her and answer to what I'm telling
// her." Before this, every message during a live turn was queued as a
// follow-up — his earlier ask, made while a quick second message was silently
// killing the first answer. The two asks are reconciled by the state: while
// she is THINKING (processing, no words yet) a message still queues, because
// nothing is being said that could be stopped; while she is TALKING it
// interrupts. The Agent's stream seam makes this testable without a paid call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FaceTurns } from "../src/face/turns.js";
import { Registry } from "../src/core/registry.js";
import type { StreamFn } from "../src/core/agent.js";
import type { ServerMsg } from "../src/face/protocol.js";

const okStream: StreamFn = async function* () {
  yield { type: "text", delta: "ok" };
  yield {
    type: "done",
    stopReason: "end_turn",
    assistantContent: [{ type: "text", text: "ok", citations: null }],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
};

function harness() {
  const sent: ServerMsg[] = [];
  const turns = new FaceTurns(new Registry(), (m) => sent.push(m), okStream);
  const types = () => sent.map((m) => m.type);
  return { turns, sent, types };
}

test("a message while she is speaking interrupts her and runs at once", async () => {
  const { turns, types } = harness();
  turns.state = "speaking"; // mid-reply: segments are playing
  await turns.textTurn("no wait, what about tomorrow?", { speak: false });
  assert.ok(!types().includes("chat_queued"), "nothing is queued behind a reply he cut off");
  assert.ok(types().includes("chat_turn"), "the new message became a turn immediately");
  assert.equal(turns.state, "idle", "and the turn ran to completion");
});

test("a message while she is still thinking queues, as before", async () => {
  const { turns, types } = harness();
  turns.state = "processing"; // no words yet — nothing to cut off
  await turns.textTurn("and also this", { speak: false });
  assert.ok(types().includes("chat_queued"), "queued, to be answered in order");
  assert.ok(!types().includes("chat_turn"), "not run over the live turn");
});
