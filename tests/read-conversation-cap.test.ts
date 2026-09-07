// read_conversation must never return an unbounded window.
//
// The evening of 2026-09-06 this tool killed the "ho fame" turn: the model
// asked to re-read a conversation whose turns embedded whole dragged-page
// dumps (the Uber Eats saga), the tool rendered every turn of a 25-turn
// window verbatim — no cap anywhere — and the result pushed the next
// model round to 204K tokens, past the 200K context ceiling. The turn
// died on a provider 400 and the face showed "in progress" for two hours.
// fetch_url learned this lesson long ago (~10k chars, its own description
// says so); the transcript reader never got the same treatment.
//
// The caps: a single turn is cut at 4000 chars (with a marker saying it
// was cut and where exact strings can still be found), and the whole
// window stops at 12000 chars with a count of what was left out. The
// model can then narrow the radius or centre on the turn it needs — the
// tool's own parameters — instead of the conversation dying.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-readcap-"));

const { recordExchange } = await import("../src/core/conversations.js");
const { conversationTools } = await import("../src/tools/conversations.js");

const read = conversationTools.find((t) => t.name === "read_conversation")!;

// A conversation shaped like the one that killed the turn: normal-looking
// turns around monster turns that embed page dumps.
const MONSTER = "BANGERS Cergy — burger grillé. ".repeat(900); // ~27k chars
recordExchange("fatconv", "face", "ordinary first message", "ordinary first reply");
for (let i = 0; i < 4; i++) {
  recordExchange("fatconv", "face", `${MONSTER} #${i}`, `page dump ${i}: ${MONSTER}`);
}

test("a window of monster turns comes back bounded, and says what it did", async () => {
  // From the top: the ordinary first turn must survive, the monster turns
  // must be cut with markers, and the whole thing must stay small.
  const res = await read.run({ conversation: "fatconv", around: 0, radius: 12 });
  assert.ok(res.length <= 13_000, `the result is ${res.length} chars — the window is still unbounded`);
  assert.match(res, /turn truncated/, "a cut turn says it was cut");
  assert.match(res, /search_conversations/, "the marker says where exact strings still live");
  // The bounded window must still be USEFUL: the ordinary turns and the
  // turn numbering survive.
  assert.match(res, /ordinary first message/);
});

test("a normal conversation comes back whole — no marker, no loss", async () => {
  recordExchange("slimconv", "face", "hi there", "hello!");
  const res = await read.run({ conversation: "slimconv" });
  assert.ok(res.length < 500);
  assert.doesNotMatch(res, /truncated|left out/, "nothing was cut that did not need cutting");
});

test("a window larger than the cap leaves whole turns out, and counts them", async () => {
  // Centre on the monster turns with a wide radius: the reader must prefer
  // leaving whole turns out (with a count) over any silent mid-cut, and
  // what it does render stays bounded.
  const res = await read.run({ conversation: "fatconv", around: 9, radius: 8 });
  assert.ok(res.length <= 13_000, `still bounded at ${res.length}`);
  assert.match(res, /left out/, "the dropped turns are counted, not hidden");
});
