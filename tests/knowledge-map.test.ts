// The knowledge map — EVE knowing WHERE her knowledge lives.
//
// The failure this file guards against: seven shelves of knowledge (memory,
// transcripts, reports, ESSEC, skills, commitments/decisions, study notes)
// and NOTHING in the system prompt said which shelf holds what or which tool
// reaches it. Finding context depended on the model remembering tool
// descriptions — which is exactly what rots. "She always knows what she's
// talking about" starts with her knowing where to look.
//
// The fix under test: a derived knowledgeMapSection() rendered into the
// stable block, built from what actually exists on disk (counts, newest
// entry ages), naming each shelf, its tool, and when to reach for it. It is
// derived, so it can never drift from reality the way hand-written prose
// rots.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-kmap-"));

const { knowledgeMapSection } = await import("../src/memory/kmap.js");
const { saveMemory } = await import("../src/memory/store.js");
const { recordExchange } = await import("../src/core/conversations.js");

test("the map names every shelf and the tool that reaches it", () => {
  const map = knowledgeMapSection();
  assert.match(map, /recall_memories/, "the long-term memory shelf must be mapped");
  assert.match(map, /search_conversations/, "the transcripts shelf must be mapped");
  assert.match(map, /search_reports/, "the reports shelf must be mapped");
  assert.match(map, /essec_knowledge/, "the ESSEC shelf must be mapped");
  assert.match(map, /view_skill/, "the skills shelf must be mapped");
  assert.match(map, /list_commitments/, "commitments must be mapped");
  assert.match(map, /list_decisions/, "decisions must be mapped");
  assert.match(map, /search_notes/, "study notes must be mapped");
});

test("the map is a WHEN-to-use map, not a tool list — it says what each shelf answers", () => {
  const map = knowledgeMapSection();
  // Each shelf line must carry its distinguishing question, so a model under
  // load reaches for the right shelf by topic, not by memory of tool names.
  assert.match(map, /what you KNOW/i, "memory shelf: what you know");
  assert.match(map, /what was SAID/i, "transcripts shelf: what was said");
  assert.match(map, /what you FOUND/i, "reports shelf: what you found");
  assert.match(map, /HOW to do/i, "skills shelf: how to do");
  assert.match(map, /what you OWE|who owes/i, "commitments shelf");
  assert.match(map, /decided together|you decided/i, "decisions shelf");
});

test("the map carries LIVE counts and ages, derived from disk", () => {
  saveMemory({
    type: "me",
    hook: "ZKMAP fixture: he prefers terse reports",
    body: "A fixture memory to give the store a nonzero count.",
  });
  recordExchange("zkmap1", "typed", "zkmap fixture turn", "zkmap fixture reply");
  const map = knowledgeMapSection();
  assert.match(map, /— \d+ memor/, "the memory count must be shown (found nothing — counts not derived)");
  assert.match(map, /— \d+ conversation/, "the conversation count must be shown");
  assert.match(map, /no reports yet/, "an empty shelf must say so in plain words");
});

test("the map fits the stable block — bounded, no bodies", () => {
  const m = knowledgeMapSection();
  assert.ok(m.length > 200 && m.length < 3000, `the map must stay prompt-sized (got ${m.length} chars)`);
  assert.ok(!m.includes("zkmap fixture"), "the map carries indexes/counts only, never content");
});

test("the map rides in the stable block, after the long-term memory section", async () => {
  const { buildStableBlock } = await import("../src/brain/prompt.js");
  const block = buildStableBlock();
  assert.match(block, /Where your knowledge lives/i, "the knowledge map must be part of the stable block");
  assert.ok(
    block.indexOf("# Long-term memory") < block.indexOf("Where your knowledge lives"),
    "the map belongs with the memory plumbing, after the memory index",
  );
});
