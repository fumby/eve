// Searching what was actually said. Semantic recall over the memory store is
// the wrong instrument for an exact token — an error string, a shop name, a
// number — and those are rarely distilled into a memory in the first place, so
// before this they were simply unreachable once the live window rolled past.
//
// Every fixture below uses a nonsense token of its own, because the suite
// shares one sandbox: asserting on counts, or searching for a common word,
// would make these tests depend on what other files happen to be writing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordExchange, searchConversations, conversationWindow } from "../src/core/conversations.js";
import { conversationTools } from "../src/tools/conversations.js";
import { isFactoryAllowed } from "../src/core/registry.js";

const tool = (name: string) => conversationTools.find((t) => t.name === name)!;

// Two fixture conversations with distinctive contents.
const CONV = "zqx1test";
const OTHER = "zqx2test";
recordExchange(
  CONV,
  "typed",
  "the build died with ENOENT zqxfixture/config.json and I cannot see why",
  "That path does not exist yet — create it before the first run.",
);
recordExchange(CONV, "typed", "and zqxperché il timeout era così basso?", "Because the default is five seconds.");
recordExchange(OTHER, "voice", "remind me which printer we used for the zqxbooklet", "The one on via Zqx, they do stapled folding.");

test("an exact string comes back, spelled the way it was written", () => {
  const hits = searchConversations("ENOENT zqxfixture/config.json");
  assert.ok(hits.length > 0, "an exact error string was not found — this is the whole point of the tool");
  assert.equal(hits[0]!.conversationId, CONV);
  assert.equal(hits[0]!.role, "user");
  assert.match(hits[0]!.excerpt, /ENOENT zqxfixture\/config\.json/, "the excerpt came back normalized instead of verbatim");
});

test("accents and case do not hide a match", () => {
  // He writes Italian as often as English; "perché" typed without the accent
  // has to find the turn that has it. ONE term, and a term that exists nowhere
  // else: with a multi-word query the coverage floor lets the hit through on
  // the strength of the other words, and this passes whatever the accent
  // handling does.
  const hits = searchConversations("zqxperche");
  assert.ok(hits.length > 0, "an unaccented query missed the accented turn");
  assert.match(hits[0]!.excerpt, /zqxperché il timeout/);
});

test("a phrase match outranks turns that merely share some words", () => {
  const hits = searchConversations("zqxbooklet printer");
  assert.equal(hits[0]!.conversationId, OTHER);
  assert.ok(hits[0]!.score > 0, "scoring produced nothing to sort on");
});

test("a multi-word query does not return turns that match one common word", () => {
  // Only "zqxfixture" is in the store; the other three words are not. Below the
  // coverage floor, this must come back empty rather than returning every turn
  // that happens to contain one term.
  const hits = searchConversations("zqxfixture kangaroo helicopter marmalade");
  assert.deepEqual(hits, [], "the coverage floor is gone — a stray shared word now returns the whole store");
});

test("a query with nothing searchable in it returns nothing, not everything", () => {
  assert.deepEqual(searchConversations("a"), []);
  assert.deepEqual(searchConversations("   "), []);
});

test("the turn number in a hit is the one read_conversation scrolls to", async () => {
  const hits = searchConversations("ENOENT zqxfixture/config.json");
  const hit = hits[0]!;
  const w = conversationWindow(hit.conversationId, hit.index, 1)!;
  assert.ok(w, "the window for a hit's own turn number came back empty");
  assert.ok(
    w.turns.some((t) => t.text.includes("ENOENT zqxfixture/config.json")),
    "scrolling to the hit's turn number does not show the hit — the index is off",
  );

  const out = await tool("read_conversation").run({ conversation: hit.conversationId, around: hit.index, radius: 1 });
  assert.match(out, /ENOENT zqxfixture/);
  assert.match(out, /^Conversation zqx1test/, "the window does not say which conversation it came from");
});

test("the window is bounded in both directions however it is asked for", () => {
  // A long conversation, so an unclamped radius would genuinely return far
  // more than the cap. With a 4-turn fixture this test passed no matter what
  // the code did.
  const LONG = "zqx3test";
  for (let i = 0; i < 20; i++) recordExchange(LONG, "typed", `turn ${i} zqxlong`, `reply ${i}`);
  const long = conversationWindow(LONG, 20, 999)!;
  assert.ok(
    long.turns.length <= 25,
    `a window of ${long.turns.length} turns came back — the radius cap is gone, and a single ` +
      `read_conversation can now pull a whole transcript into context`,
  );

  // A centre past the end, and a radius past the cap, must both clamp.
  const w = conversationWindow(CONV, 999, 999)!;
  assert.ok(w.turns.length <= 25, `a window of ${w.turns.length} turns came back`);
  assert.equal(w.from + w.turns.length, w.conv.turns.length, "a centre past the end did not clamp to the end");
  assert.equal(conversationWindow("no-such-conversation"), null);
});

test("an unknown conversation id fails with something you can act on", async () => {
  await assert.rejects(
    () => tool("read_conversation").run({ conversation: "nope" }),
    /no stored conversation with id "nope"/,
  );
});

test("an empty search says 'not in what I still have', not 'never said'", async () => {
  const out = await tool("search_conversations").run({ query: "zqxnothingmatchesthis" });
  assert.match(out, /oldest sessions age out/, "an empty result reads as proof it was never said");
});

test("neither conversation tool is handed to a Factory-spawned agent", () => {
  for (const t of conversationTools) {
    assert.equal(
      isFactoryAllowed(t),
      false,
      `${t.name} is offered to spawned agents — a research specialist can now read every transcript`,
    );
  }
});
