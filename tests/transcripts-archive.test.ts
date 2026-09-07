// The transcripts archive — what was actually SAID must outlive the live window.
//
// The failure this file guards against, in two halves:
//
//   1. data/conversations.json is capped at 60 conversations; recordExchange
//      silently DROPPED everything older. A year of talking, and the only
//      thing left was the last 60 threads — "what was that error string"
//      became unanswerable, forever.
//   2. memory/archive/conversations.pre-isolation.json holds 41 real
//      conversations (the Cergy move, professor Bianchi, the July budget
//      question) as the ONLY copy, read by NO code — invisible to
//      search_conversations and to EVE.
//
// The fix under test: evicted conversations are ARCHIVED to
// memory/transcripts/ (one markdown file per conversation, searchable,
// snapshotted hourly by backup-memory.sh) instead of dropped, and the
// archive is searched by the SAME searchConversations call that searches
// the live store — one query, both shelves.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-transcripts-"));

const {
  recordExchange,
  searchConversations,
  archiveConversation,
  loadArchived,
  loadConversations,
} = await import("../src/core/conversations.js");
const { STATE_ROOT } = await import("../src/core/config.js");

const TRANS = path.join(STATE_ROOT, "memory", "transcripts");

// One conversation whose turns carry a distinctive token, then evicted.
const OLD = "ztxold";
recordExchange(OLD, "typed", "the relatore Bianchi said ztxbudget was over by 200", "Noted — I'll track it.");
recordExchange(OLD, "typed", "and the ztxcergy move is confirmed for the 24th", "I'll remind you before the train.");

// A live conversation that stays in the store.
const LIVE = "ztxlive";
recordExchange(LIVE, "face", "what was that ztxerror string again?", "It was ztxENOENT on the config path.");

test("an evicted conversation is archived, not dropped", () => {
  // Evict it the way recordExchange will: archive + remove from the live file.
  archiveConversation(OLD);
  assert.ok(fs.existsSync(TRANS), "memory/transcripts/ must exist after an archive");
  const files = fs.readdirSync(TRANS).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1);
  const raw = fs.readFileSync(path.join(TRANS, files[0]!), "utf8");
  assert.match(raw, /relatore Bianchi/, "the transcript itself is in the file");
  assert.match(raw, /ztxcergy move/);
});

test("the live store no longer holds the archived conversation — the archive does", () => {
  const archivedIds = loadArchived();
  assert.ok(archivedIds.some((n) => n === OLD), "archived = a file in memory/transcripts/");
  assert.ok(!loadConversations().some((c) => c.id === OLD), "still live as well — double shelf");
});

test("searchConversations finds turns in the ARCHIVE as well as the live store", () => {
  // The whole point: one query, both shelves. Before, the archived token was
  // unfindable forever.
  const hits = searchConversations("ztxbudget relatore");
  assert.ok(hits.length > 0, "an archived turn is invisible to search — this is the pre-isolation failure mode");
  assert.match(hits[0]!.excerpt, /ztxbudget/);
  // And the live store still answers.
  const liveHits = searchConversations("ztxerror string");
  assert.ok(liveHits.length > 0, "the live store search regressed");
  assert.equal(liveHits[0]!.conversationId, LIVE);
});

test("search results say which shelf a hit came from", () => {
  const hits = searchConversations("ztxcergy move");
  assert.ok(hits.length > 0);
  assert.match(hits[0]!.source, /archive/, "an archived hit must be labelled, or read_conversation can't follow up");
});

test("archiving is idempotent — a second archive of the same id changes nothing", () => {
  archiveConversation(OLD);
  const files = fs.readdirSync(TRANS).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1, "archiving twice must not create a duplicate file");
});

test("recordExchange itself evicts to the archive when the live store overflows", () => {
  // The real wiring: overflow past MAX_CONVERSATIONS must archive, not drop.
  // Fill the store past the cap with distinctive conversations, oldest first.
  for (let i = 0; i < 65; i++) {
    recordExchange(`ztxfill-${i}`, "typed", `filler turn ztxfill-${i} about porcupines`, `ok ${i}`);
  }
  // The oldest fillers must now be in the archive, not gone.
  const hits = searchConversations("ztxfill-0 porcupines");
  assert.ok(hits.length > 0, "the conversation evicted by the cap was DROPPED, not archived");
  const live = JSON.parse(fs.readFileSync(path.join(STATE_ROOT, "data", "conversations.json"), "utf8"));
  assert.ok(live.length <= 60, "the live store exceeded its cap");
});

test("an archived transcript names the original conversation id", () => {
  const files = fs.readdirSync(TRANS).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(TRANS, f), "utf8");
    if (raw.includes("ztxcergy")) {
      assert.match(raw, /ztxold/, "the file must carry the original conversation id for read-back");
      return;
    }
  }
  assert.fail("no archived file contains the fixture conversation");
});
