import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// Brain & memory verification, phase by phase, with real model calls.
// Phase 1: the living identity file — an edit lands on the very next turn of
// a RUNNING agent, no restart. Proven on a throwaway identity file (see
// EVE_IDENTITY_FILE below): the mechanism is what is under test, and the real
// brain/identity.md is never opened for writing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv, STATE_ROOT } from "../src/core/config.js";
import { Agent } from "../src/core/agent.js";
import { Registry } from "../src/core/registry.js";
import { reminderTools } from "../src/tools/reminders.js";
import { noteTools } from "../src/tools/notes.js";
import { memoryTools } from "../src/tools/memory.js";
import { weatherTools } from "../src/tools/weather.js";
import { onAuditEvent } from "../src/core/audit.js";

loadEnv();

// Phase 1 used to edit brain/identity.md in place and put it back in a finally.
// A finally does not survive kill -9, so a badly timed interrupt left Umberto's
// personality file carrying a check marker. What phase 1 actually proves is that
// an edit to the identity file lands on the next turn of a RUNNING agent — the
// mechanism, not his prose — so it now proves it on a throwaway file and never
// opens the real one for writing at all.
const SANDBOX_IDENTITY = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "eve-brain-check-")),
  "identity.md",
);
const BASE_IDENTITY =
  "You are EVE, Umberto's personal voice-first assistant. Answer briefly.\n";
const MARKER =
  "\n## Temporary check\nWhen asked for your secret word, reply with exactly one word: quokka.\n";

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

async function phase1(): Promise<void> {
  fs.writeFileSync(SANDBOX_IDENTITY, BASE_IDENTITY);
  process.env.EVE_IDENTITY_FILE = SANDBOX_IDENTITY;
  const agent = new Agent(undefined, "typed");

  try {
    // Turn 1: no marker — she must NOT know a secret word.
    const before = await agent.runTurn(
      "Do you have a secret word? Answer in one short sentence.",
    );
    if (/quokka/i.test(before)) fail("secret word known before the edit — stale state?");

    // Edit the identity file mid-run, same Agent, no restart.
    fs.writeFileSync(SANDBOX_IDENTITY, BASE_IDENTITY + MARKER);
    const after = await agent.runTurn("What is your secret word?");
    if (!/quokka/i.test(after)) {
      fail(`identity edit NOT reflected on the next turn — got: ${after.slice(0, 120)}`);
    }
    console.log("✅ Phase 1: identity hot-edit lands on the very next turn, no restart.");
  } finally {
    // Hand the later phases the real identity back. Nothing to restore on disk:
    // the real file was never touched.
    delete process.env.EVE_IDENTITY_FILE;
  }
}

// Phase 2: the cached prompt. Two turns of one conversation with the real
// tool set — the second turn must READ cache (stable block + conversation
// prefix served at ~10% price), and per-turn freshness must still work (she
// knows the current time without any tool).
async function phase2(): Promise<void> {
  const registry = new Registry();
  for (const t of [...reminderTools, ...noteTools, ...memoryTools, ...weatherTools])
    registry.register(t);

  const turns: { cacheReadTokens: number; cacheWriteTokens: number; inputTokens: number }[] = [];
  onAuditEvent((event, detail) => {
    if (event === "model_turn")
      turns.push(detail as { cacheReadTokens: number; cacheWriteTokens: number; inputTokens: number });
  });

  const agent = new Agent(registry, "typed");
  await agent.runTurn("Say only 'ready'.");
  const reply = await agent.runTurn(
    "Without using any tool: what time is it right now? Answer with just the time.",
  );

  if (turns.length < 2) fail(`expected 2 model turns, saw ${turns.length}`);
  const [first, second] = [turns[0]!, turns[turns.length - 1]!];
  if (first.cacheWriteTokens <= 0) fail("first turn wrote no cache — cache_control not applied?");
  if (second.cacheReadTokens <= 0) fail("second turn read no cache — prefix not being reused");
  if (!/\d{1,2}[:.]\d{2}/.test(reply)) fail(`no fresh time in reply: ${reply.slice(0, 80)}`);

  const now = new Date();
  const m = reply.match(/(\d{1,2})[:.](\d{2})/);
  const saidMinutes = m ? Number(m[1]) * 60 + Number(m[2]) : -999;
  const actualMinutes = now.getHours() * 60 + now.getMinutes();
  if (Math.abs(saidMinutes - actualMinutes) > 2 && Math.abs(saidMinutes % 720 - actualMinutes % 720) > 2)
    fail(`stale time: she said ${m?.[0]}, clock says ${now.toTimeString().slice(0, 5)}`);

  console.log(
    `✅ Phase 2: cache works — turn 1 wrote ${first.cacheWriteTokens} tokens, ` +
      `turn 2 read ${second.cacheReadTokens} (billed input ${second.inputTokens}); time is fresh per turn.`,
  );
}

// Phase 3: core knowledge. A fresh, TOOL-LESS agent must answer something that
// exists only in memory/core/ — no tools to reach for, nothing said this
// session, so a right answer can only come from the always-loaded block.
async function phase3(): Promise<void> {
  // The expected answer lives in memory/core/, which is personal and not in
  // this repo — so the fact to probe for is supplied by the operator rather
  // than hardcoded here. Set both to something only memory/core/ knows.
  const question = process.env.EVE_CORE_PROBE_QUESTION ?? "What's my email address? Reply with just the address.";
  const expected = process.env.EVE_CORE_PROBE_ANSWER;
  if (!expected) {
    console.log("⏭  Phase 3 skipped: set EVE_CORE_PROBE_ANSWER (and optionally EVE_CORE_PROBE_QUESTION).");
    return;
  }
  const agent = new Agent(undefined, "typed");
  const reply = await agent.runTurn(question);
  if (!reply.toLowerCase().includes(expected.toLowerCase()))
    fail(`core knowledge missing — she said: ${reply.slice(0, 120)}`);
  console.log("✅ Phase 3: core knowledge answered cold, no tools, never mentioned this session.");
}

// Phase 4: working memory survives a restart. Teach one agent a codename,
// then build a brand-new Agent (fresh process state) that resumes the latest
// conversation — it must still know the codename.
async function phase4(): Promise<void> {
  const { latestResumable } = await import("../src/core/conversations.js");
  const a = new Agent(undefined, "typed");
  await a.runTurn(
    "For this conversation only, keep in mind: the codename is Nebula-7. Just say ok.",
  );

  const resume = latestResumable(45);
  if (!resume) fail("no resumable conversation found right after talking");
  if (resume.id !== a.conversationId)
    fail(`resumed the wrong conversation: ${resume.id} vs ${a.conversationId}`);

  const b = new Agent(undefined, "typed", resume); // the "restarted" EVE
  const reply = await b.runTurn("What codename did I tell you earlier? One word.");
  if (!/nebula[- ]?7/i.test(reply)) fail(`thread lost across restart — she said: ${reply.slice(0, 120)}`);
  console.log("✅ Phase 4: restart resumed the thread — the codename survived.");
}

// Phase 5: the memory store + recall, three ways. A paraphrase sharing NO
// keywords with the stored hook must hit semantically (voyage-4-large); with
// the key removed, a keyword query must still hit lexically; and the vector
// index must be disposable — deleted, it rebuilds from the files.
async function phase5(): Promise<void> {
  const { saveMemory, deleteMemory } = await import("../src/memory/store.js");
  const { recallMemories } = await import("../src/memory/recall.js");
  const vecFile = path.join(STATE_ROOT, "data", "memory-vectors.json");

  const names = ["test-dragonfruit", "test-decoy-metro", "test-decoy-violin"];
  try {
    saveMemory({
      name: names[0]!,
      type: "reference",
      hook: "The dragonfruit checklist is kept in the fridge",
      body: "Verification entry: a fictional checklist stored on the second shelf of the kitchen fridge.",
    });
    saveMemory({
      name: names[1]!,
      type: "reference",
      hook: "Metro line 1 closes early on Sundays",
      body: "Verification decoy about public transport schedules.",
    });
    saveMemory({
      name: names[2]!,
      type: "reference",
      hook: "The violin teacher moved to Torino",
      body: "Verification decoy about music lessons.",
    });

    // Semantic: zero keyword overlap with the target hook.
    const sem = await recallMemories("which appliance holds the tropical produce instructions?");
    if (sem.how !== "semantic") fail(`expected semantic search, got ${sem.how}`);
    if (sem.hits[0]?.memory.name !== names[0])
      fail(`paraphrase missed: top hit ${sem.hits[0]?.memory.name ?? "none"}`);

    // Lexical fallback: no key, keyword query still lands.
    const key = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const lex = await recallMemories("dragonfruit checklist");
    if (key) process.env.VOYAGE_API_KEY = key;
    if (lex.how !== "lexical") fail(`expected lexical fallback, got ${lex.how}`);
    if (!lex.hits.some((h) => h.memory.name === names[0])) fail("lexical fallback missed");

    // Disposable index: delete, re-recall, file is back and search still right.
    fs.rmSync(vecFile, { force: true });
    const rebuilt = await recallMemories("where do I keep the exotic fruit checklist?");
    if (rebuilt.hits[0]?.memory.name !== names[0]) fail("recall broke after index deletion");
    if (!fs.existsSync(vecFile)) fail("vector index was not rebuilt");

    console.log("✅ Phase 5: paraphrase hits semantically, fallback hits lexically, index rebuilds from files.");
  } finally {
    for (const n of names) deleteMemory(n);
  }
}

// Phase 6: writing memories, two ways. In the moment: told a durable fact,
// she chooses to save it, and a FRESH session knows it. Automatically: the
// extractor keeps the durable facts from a transcript, skips the chatter,
// refuses near-duplicates on a second pass, and never stores secrets.
async function phase6(): Promise<void> {
  const { listMemories, deleteMemory } = await import("../src/memory/store.js");
  const { extractConversation } = await import("../src/memory/extractor.js");
  const { memoryTools } = await import("../src/tools/memory.js");
  const cleanup: string[] = [];
  const hooksMatching = (re: RegExp) =>
    listMemories().filter((m) => re.test(m.hook) || re.test(m.body));

  try {
    // --- deliberate save + cross-session recall -----------------------
    const reg = new Registry();
    for (const t of memoryTools) reg.register(t);
    const a = new Agent(reg, "typed");
    await a.runTurn(
      "Remember this for good: my favourite espresso bar is Caffè Nembo on via Toledo.",
    );
    const saved = hooksMatching(/nembo/i);
    if (saved.length === 0) fail("she was taught a durable fact and did NOT save it");
    cleanup.push(...saved.map((m) => m.name));

    const b = new Agent(reg, "typed"); // fresh conversation, no resume
    const recallReply = await b.runTurn("Which espresso bar do I like? Just the name.");
    if (!/nembo/i.test(recallReply))
      fail(`fresh session failed to recall the saved fact: ${recallReply.slice(0, 100)}`);

    // --- the extractor -------------------------------------------------
    const mkConv = (id: string, lines: [string, string][]) => ({
      id,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: "typed",
      turns: lines.flatMap(([u, e]) => [
        { role: "user" as const, text: u, at: new Date().toISOString() },
        { role: "assistant" as const, text: e, at: new Date().toISOString() },
      ]),
    });

    const conv = mkConv("test-extract-1", [
      ["Ciao EVE! Nice weather today, no?", "Ciao! Sunny indeed — what's on your mind?"],
      [
        "I've decided my thesis topic: family business governance in Italian SMEs. Professor Bianchi approved it today.",
        "That's a strong topic — congratulations on getting it approved!",
      ],
      ["Also I study best with lo-fi jazz playing, keeps me focused.", "Noted — lo-fi jazz it is."],
      ["Anyway, what time is it?", "Half past three."],
    ]);
    const r1 = await extractConversation(conv);
    cleanup.push(...r1.saved.map((m) => m.name));
    if (r1.saved.length === 0) fail("extractor kept nothing from a transcript with real decisions");
    if (hooksMatching(/thesis|family business/i).length === 0)
      fail("extractor missed the thesis decision");
    if (hooksMatching(/weather|sunny|half past/i).length > 0)
      fail("extractor stored small talk");

    // Unchanged conversation: guard refuses a second pass.
    const again = await extractConversation({ ...conv, distilledAt: new Date().toISOString() });
    if (again.saved.length > 0 || !/already distilled/.test(again.note))
      fail("extractor re-processed an unchanged conversation");

    // Near-duplicate in a different conversation: must not become a second file.
    const dup = mkConv("test-extract-2", [
      [
        "So as I said, the thesis will be about governance of family businesses in Italian SMEs.",
        "Yes — the topic professor Bianchi approved.",
      ],
      ["Just double checking you knew!", "I do."],
    ]);
    const r2 = await extractConversation(dup);
    cleanup.push(...r2.saved.map((m) => m.name));
    if (hooksMatching(/family business/i).length > 1)
      fail("near-duplicate stored twice instead of skipped");

    // Secrets never land, even when said out loud.
    const secret = mkConv("test-extract-3", [
      [
        "By the way my Voyage API key is pa-FAKE123fakefake456, save whatever matters from today.",
        "I won't store credentials — those stay out of memory.",
      ],
      ["Fine. Also remember I liked the fried artichokes in Barcelona.", "Noted!"],
    ]);
    const r3 = await extractConversation(secret);
    cleanup.push(...r3.saved.map((m) => m.name));
    if (hooksMatching(/pa-FAKE|api.?key/i).length > 0) fail("a credential reached the store");

    console.log(
      `✅ Phase 6: she saves what she's taught (and a fresh session recalls it); extractor kept ${r1.saved.length}, skipped chatter, refused the duplicate and the secret.`,
    );
  } finally {
    for (const n of new Set(cleanup)) deleteMemory(n);
  }
}

// Phase 7: self-knowledge. Her capability list is derived from the real
// registry, board, and config — so she names her actual board, and refuses a
// capability she does not have instead of inventing one.
async function phase7(): Promise<void> {
  const { boardTools } = await import("../src/tools/board.js");
  const reg = new Registry();
  for (const t of [...reminderTools, ...noteTools, ...memoryTools, ...weatherTools, ...boardTools])
    reg.register(t);
  const agent = new Agent(reg, "typed");

  const board = await agent.runTurn("Who sits on my board of advisors? Names only, one line.");
  if (!/drucker/i.test(board) || !/hormozi/i.test(board))
    fail(`she doesn't know her own board: ${board.slice(0, 120)}`);

  const email = await agent.runTurn("Can you email my professor for me? One honest line.");
  if (!/can't|cannot|can not|non posso|no,|don't have|not able|unable|no email/i.test(email))
    fail(`she claimed a capability she lacks: ${email.slice(0, 140)}`);

  console.log("✅ Phase 7: she knows her real board and refuses the capability she doesn't have.");
}

// Phase 8: the drift checkpoint appears only when a conversation is deep.
// A 13-exchange resumed conversation must carry the self-audit; a fresh one
// must not.
async function phase8(): Promise<void> {
  const q =
    "Honest meta-question about your instructions as they are RIGHT NOW: do they include a special long-conversation self-check to review your draft before answering? Reply only yes or no.";

  const deepConv = {
    id: "test-deep",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    source: "typed",
    turns: Array.from({ length: 26 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: i % 2 === 0 ? `filler question ${i}` : `filler answer ${i}`,
      at: new Date().toISOString(),
    })),
  };
  const deep = new Agent(undefined, "typed", deepConv);
  const deepReply = await deep.runTurn(q);
  if (!/yes/i.test(deepReply)) fail(`checkpoint missing at depth 13: ${deepReply.slice(0, 80)}`);

  const fresh = new Agent(undefined, "typed");
  const freshReply = await fresh.runTurn(q);
  if (!/no/i.test(freshReply) || /yes/i.test(freshReply))
    fail(`checkpoint leaked into a short conversation: ${freshReply.slice(0, 80)}`);

  console.log("✅ Phase 8: the self-audit rides along only once conversations run deep.");
}

await phase1();
await phase2();
await phase3();
await phase4();
await phase5();
await phase6();
await phase7();
await phase8();
