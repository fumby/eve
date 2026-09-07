// The automatic extractor: a cheap model reads the stored transcript and
// proposes the genuinely durable things in it — facts for long-term memory,
// and procedures for the skill store. Deliberate saves catch the important
// thing in the moment; this catches what everyone forgot to save. Three guards
// stand between a proposal and the store: the model is shown what's already
// known (and told to skip it), a code-side similarity check rejects
// near-duplicates anyway, and a sensitive-content filter refuses secrets
// outright.
//
// It runs at two moments. At the END of a session (or at startup, for a
// session that ended without a clean close) — and PERIODICALLY, every N
// exchanges, while the conversation is still going. The periodic pass exists
// because a long session used to bank nothing until it was over: a correction
// made at turn 3 was only ever written down if the process lived long enough
// to be shut down properly, which for the face is not the usual fate.
//
// Everything the periodic pass can do, the end-of-session pass could already
// do. That is deliberate: one prompt, one parser, one set of guards. A second
// half-guarded write path is how the credential filter got a hole in it the
// first time.
import { streamTurn } from "../core/provider.js";
import { loadConfig } from "../core/config.js";
import { audit } from "../core/audit.js";
import { markDistilled, undistilled, type Conversation } from "../core/conversations.js";
import {
  MEMORY_TYPES,
  listMemories,
  saveMemory,
  renderIndex,
  isSensitive,
  SensitiveContentError,
  type MemoryType,
  type StoredMemory,
} from "./store.js";
import { recallMemories } from "./recall.js";
import { coreKnowledge } from "../brain/prompt.js";
import {
  listSkills,
  saveSkill,
  renderSkillIndex,
  MAX_BODY_CHARS,
  type StoredSkill,
} from "../skills/store.js";
import { bagOfWords, lexicalCosine } from "../mind/embed.js";
import { addNotice } from "../core/notices.js";
import { getConversation } from "../core/conversations.js";

const MAX_PROPOSALS = 5;
// Fewer, because a skill is a page and a wrong one is followed rather than
// merely believed. Two per pass is enough for a session that genuinely taught
// something and too few to bury the store in near-duplicates.
const MAX_SKILL_PROPOSALS = 2;
const MAX_TRANSCRIPT_CHARS = 24_000;
// Above these similarity scores a proposal is "already covered".
const DUP_SEMANTIC = 0.85;
const DUP_LEXICAL = 0.5;
// Skills have no vector index, so the trigger lines are compared lexically —
// the same bag-of-words cosine the mind map uses. Deliberately lower than a
// semantic bar would be: two triggers phrased differently for the same job
// still share most of their nouns.
const DUP_SKILL_LEXICAL = 0.45;

export interface ExtractionResult {
  saved: StoredMemory[];
  // Memories this pass retired, as [outgoing, replacement] name pairs.
  retired: { name: string; by: string }[];
  skills: StoredSkill[];
  skipped: { hook: string; reason: string }[];
  note: string; // one line for logs: what happened and why
}

const SYSTEM = `You are the memory extractor for EVE, Umberto's personal assistant. You read a conversation transcript and decide what deserves to outlive it. Two different things can:

MEMORIES are small durable FACTS, carried in context every turn.
Worth keeping: things Umberto taught EVE, corrections he made, decisions about his studies or ventures, lasting preferences, people who matter, meaningful personal-life facts.
Not worth keeping: transient task state, chit-chat, questions and answers that changed nothing, anything already in the "already known" list, tests or debugging chatter. Never propose secrets, API keys, passwords, or other people's private confidences.
THREE over-promotion traps, each seen live — refuse each:
- A MOMENT is not a PATTERN. One cinema companion arriving late once is an incident, not "someone close to him is habitually late". Propose a pattern only after repeated, separate occasions in the transcript.
- A SUGGESTION is not a PREFERENCE. Options EVE offered (bowl places, chicken, kebab) are her words, not his tastes. Only what UMBERTO said he wants, likes, or rejects counts.
- A STATE is not a FACT. "I'm hungry today" is transient; "I don't eat fish" is durable. Hunger, mood, tiredness, weather, and where he is RIGHT NOW are not memories unless they recur or he marks them as lasting.

If a new fact makes one of the STORED memories out of date — the fact CHANGED, it was not merely wrong — set "supersedes" to that memory's exact name from the index. The old one is kept on disk but retired from the index and from recall. Use it sparingly and never on a guess: if you are not sure the two are about the same thing, leave it out and let both stand. Past events (a trip taken, a deadline passed) are HISTORY, not out-of-date facts — do not supersede them; leave them for the weekly hygiene review.

SKILLS are PROCEDURES, loaded only when relevant, so they can be a page long.
Propose one when the transcript shows a multi-step workflow worth repeating, an error or dead end where the working path was eventually found, an approach Umberto corrected, or a non-obvious way of doing something that turned out to be right.
A skill is written for the NEXT time, not about this time: numbered steps in the order that worked, then the pitfalls and how to tell it worked. No narration, no dates, no quoted chat, nothing about "the user asked". If the only content would be "we discussed X", there is no skill here.
"when" is one concrete trigger line — the only part EVE carries in context.

Reply with ONLY a JSON object, no prose:
{"memories":[{"type":"me|style|project|personal|reference","hook":"one plain searchable line","body":"the fact, why it matters, how to apply it","supersedes":"optional-existing-memory-name"}],"skills":[{"title":"short name","when":"one line: when this applies","body":"## Procedure\\n1. …\\n## Pitfalls\\n- …"}]}
Empty lists ({"memories":[],"skills":[]}) are a perfectly good answer — most conversations contain nothing durable.`;

function transcriptOf(conv: Conversation): string {
  const text = conv.turns
    .map((t) => `${t.role === "user" ? "Umberto" : "EVE"}: ${t.text}`)
    .join("\n");
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

// One conversation through the extractor. Never throws — end-of-session
// bookkeeping must not take anything down with it.
export async function extractConversation(conv: Conversation | null): Promise<ExtractionResult> {
  const none = (note: string): ExtractionResult => ({
    saved: [],
    retired: [],
    skills: [],
    skipped: [],
    note,
  });
  if (!conv) return none("no conversation");
  if (conv.distilledAt && conv.distilledAt >= conv.updatedAt)
    return none("already distilled, nothing new");
  if (conv.turns.length < 4) return none("too short to bother");
  if (transcriptOf(conv).length < 300) return none("too little said");

  try {
    const cfg = loadConfig();
    let raw = "";
    for await (const ev of streamTurn({
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            // BOTH knowledge layers, not just the store: when the store is
            // young or empty, core knowledge is what stops the extractor from
            // re-deriving his whole life out of old transcripts. (Learned the
            // hard way: an empty store once let it mint "prefers Italian"
            // from bilingual chats, and she started answering English in
            // Italian one boot later.)
            `Already known — do NOT propose anything these cover:\n` +
            `${coreKnowledge() || "(no core knowledge)"}\n\nStored memory index:\n${renderIndex()}\n\n` +
            `Skills already written (do not propose one that overlaps):\n${renderSkillIndex()}\n\n` +
            `Transcript (via ${conv.source}, ${conv.turns.length} turns):\n${transcriptOf(conv)}`,
        },
      ],
      model: cfg.memory.extractorModel,
      effort: null,
      maxTokens: 1200,
    })) {
      if (ev.type === "text") raw += ev.delta;
      else if (ev.type === "done") audit("model_turn", { source: "extractor", ...ev.usage });
    }

    const { saved, retired, skills, skipped } = await applyProposals(parseProposals(raw), conv.id);
    markDistilled(conv.id);
    const note =
      `extractor: ${saved.length} saved, ${retired.length} retired, ` +
      `${skills.length} skills, ${skipped.length} skipped (${conv.id})`;
    audit("memory_extract", {
      conversation: conv.id,
      saved: saved.map((m) => m.name),
      retired,
      skills: skills.map((sk) => sk.name),
      skipped,
    });
    return { saved, retired, skills, skipped, note };
  } catch (err) {
    return none(`extractor failed quietly: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Everything that happens to a proposal AFTER the model has spoken: the
// credential refusal, the near-duplicate check, the supersedes link and its
// fallback, the skill overlap check. Pulled out of extractConversation so the
// guards can be exercised directly, with synthetic proposals and no model
// call — they are the part with the failure modes, and they used to be
// reachable only by paying for a real extraction and hoping it proposed the
// shape you wanted to test.
export async function applyProposals(parsed: Proposals, convOrigin = ""): Promise<{
  saved: StoredMemory[];
  retired: { name: string; by: string }[];
  skills: StoredSkill[];
  skipped: { hook: string; reason: string }[];
}> {
    const saved: StoredMemory[] = [];
  const retired: { name: string; by: string }[] = [];
  const skills: StoredSkill[] = [];
  const skipped: { hook: string; reason: string }[] = [];

  for (const p of parsed.memories.slice(0, MAX_PROPOSALS)) {
    // Checked here as well as at the store, and the ORDER is load-bearing:
    // the duplicate check below calls recallMemories(), which embeds the hook
    // through the Voyage API. Refusing first is what keeps a credential from
    // leaving the machine at all. The store's throw is the backstop, caught
    // below — nobody on this path can answer a confirmation anyway.
    if (isSensitive(`${p.hook}\n${p.body}`)) {
      skipped.push({ hook: p.hook, reason: "sensitive content refused" });
      continue;
    }
    // A superseding proposal SKIPS the duplicate check on purpose. The
    // correction of a fact is, by definition, about the same thing as the
    // fact it corrects — near-identical wording is exactly what a changed
    // fact looks like. Before this, "he moved to Cergy" was discarded as
    // "already covered by [lives in Naples]" and the contradiction stayed,
    // because dedup ran before the supersession had a chance to retire the
    // old entry (found by the 2026-09-06 memory audit, item 6).
    if (!p.supersedes && listMemories().length > 0) {
      const { hits, how } = await recallMemories(p.hook, 1);
      const top = hits[0];
      const bar = how === "semantic" ? DUP_SEMANTIC : DUP_LEXICAL;
      if (top && top.score >= bar) {
        skipped.push({ hook: p.hook, reason: `already covered by [${top.memory.name}]` });
        continue;
      }
    }
    const fields = { type: p.type, hook: p.hook, body: p.body, source: "extractor" as const, confirmed: false, origin: convOrigin };
    try {
      const mem = saveMemory({ ...fields, ...(p.supersedes ? { supersedes: p.supersedes } : {}) });
      saved.push(mem);
      if (mem.supersedes) retired.push({ name: mem.supersedes, by: mem.name });
    } catch (err) {
      // The store has the final say. Here that is just one more skip, worded
      // exactly as before; anything else is a real failure and must surface.
      if (err instanceof SensitiveContentError) {
        skipped.push({ hook: p.hook, reason: "sensitive content refused" });
        continue;
      }
      // A bad supersedes link must not cost us the FACT. The store validates
      // the link before writing anything, so the whole proposal was thrown
      // away over the one field the model was least sure about — save it
      // again standing on its own, and let the contradiction be visible
      // rather than silently dropping what the session actually learned.
      if (!p.supersedes) throw err;
      try {
        saved.push(saveMemory(fields));
        skipped.push({
          hook: p.hook,
          reason: `saved, but not superseding [${p.supersedes}] — ${err instanceof Error ? err.message : String(err)}`,
        });
      } catch (retryErr) {
        if (!(retryErr instanceof SensitiveContentError)) throw retryErr;
        skipped.push({ hook: p.hook, reason: "sensitive content refused" });
      }
    }
  }

  // Skills, same shape of guard: refused outright if it reads like a
  // credential, skipped if one already covers the same trigger. The overlap
  // check is lexical against the trigger lines — a skill has no vectors, and
  // the trigger is the part that decides whether two skills compete.
  for (const p of parsed.skills.slice(0, MAX_SKILL_PROPOSALS)) {
    const rival = listSkills()
      .map((sk) => ({ sk, score: lexicalCosine(bagOfWords(p.when), bagOfWords(sk.when)) }))
      .sort((a, b) => b.score - a.score)[0];
    if (rival && rival.score >= DUP_SKILL_LEXICAL) {
      skipped.push({ hook: p.title, reason: `skill already covered by [${rival.sk.name}]` });
      continue;
    }
    try {
      skills.push(saveSkill({ title: p.title, when: p.when, body: p.body }));
    } catch (err) {
      // Both refusals the skill store can raise — a credential, or a body
      // that is a transcript rather than a procedure — are skips here.
      // Nobody on this path can answer a confirmation.
      skipped.push({
        hook: p.title,
        reason: err instanceof Error ? err.message.slice(0, 120) : "skill refused",
      });
    }
  }

  return { saved, retired, skills, skipped };
}

export interface Proposals {
  memories: { type: MemoryType; hook: string; body: string; supersedes?: string }[];
  skills: { title: string; when: string; body: string }[];
}

export function parseProposals(raw: string): Proposals {
  const empty: Proposals = { memories: [], skills: [] };
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return empty;
  try {
    const j = JSON.parse(m[0]) as { memories?: unknown; skills?: unknown };
    return { memories: parseMemories(j.memories), skills: parseSkills(j.skills) };
  } catch {
    return empty;
  }
}

function parseMemories(value: unknown): Proposals["memories"] {
  {
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (x): x is { type: string; hook: string; body: string } =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as { hook?: unknown }).hook === "string" &&
          typeof (x as { body?: unknown }).body === "string",
      )
      .map((x) => {
        // Read off a widened view: the narrowing filter above only proves the
        // three required fields, and `supersedes` is optional by design.
        const link = (x as { supersedes?: unknown }).supersedes;
        const supersedes = typeof link === "string" ? link.trim() : "";
        return {
          type: (MEMORY_TYPES as readonly string[]).includes(x.type)
            ? (x.type as MemoryType)
            : "reference",
          hook: x.hook.replace(/\s+/g, " ").trim().slice(0, 160),
          body: x.body.trim(),
          ...(supersedes ? { supersedes } : {}),
        };
      })
      .filter((x) => x.hook.length >= 8 && x.body.length >= 10);
  }
}

// Length bounds mirror the skill tool's schema rather than trusting the model
// to have read them: this path has no Zod in front of it, so an over-long body
// would reach the store and be refused there — a wasted proposal instead of a
// clipped one.
function parseSkills(value: unknown): Proposals["skills"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (x): x is { title: string; when: string; body: string } =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as { title?: unknown }).title === "string" &&
        typeof (x as { when?: unknown }).when === "string" &&
        typeof (x as { body?: unknown }).body === "string",
    )
    .map((x) => ({
      title: x.title.replace(/\s+/g, " ").trim().slice(0, 80),
      when: x.when.replace(/\s+/g, " ").trim().slice(0, 200),
      body: x.body.trim().slice(0, MAX_BODY_CHARS),
    }))
    .filter((x) => x.title.length >= 4 && x.when.length >= 8 && x.body.length >= 30);
}

// ── the periodic pass ──────────────────────────────────────────────────────
// A conversation used to bank nothing until it ended. Now every N completed
// exchanges the same extractor runs over the transcript so far, while the
// session is still going.
//
// The counter is the Agent's own totalExchanges, which is HYDRATED from the
// stored conversation when a session resumes — so the cadence survives a fresh
// Agent instance (a restart, a reconnecting face) instead of starting over at
// zero every time, which on a machine that reconnects often would mean the
// review effectively never fires.
const reviewsInFlight = new Set<string>();

export function reviewDue(exchanges: number): boolean {
  const every = loadConfig().memory.reviewEveryExchanges;
  return every > 0 && exchanges > 0 && exchanges % every === 0;
}

// Fire-and-forget by construction: it takes no callback, returns nothing, and
// swallows everything. A background review that can delay a spoken reply, or
// take the process down with it, is worse than no background review — this is
// bookkeeping, and Umberto is mid-conversation.
export function scheduleReview(conversationId: string, exchanges: number): void {
  if (!reviewDue(exchanges)) return;
  // A slow review still running when the next interval comes round would have
  // two passes reading the same transcript and proposing the same things; the
  // duplicate check would catch most of it and waste both calls doing so.
  if (reviewsInFlight.has(conversationId)) return;
  reviewsInFlight.add(conversationId);
  // setImmediate, not an inline await: the turn's text reaches Umberto first,
  // and the review starts on the next tick of the loop.
  setImmediate(() => {
    void (async () => {
      try {
        const conv = getConversation(conversationId);
        const r = await extractConversation(conv);
        audit("memory_review", { conversation: conversationId, exchanges, note: r.note });
        announceReview(r);
      } catch {
        // Never surfaces. The next interval tries again.
      } finally {
        reviewsInFlight.delete(conversationId);
      }
    })();
  });
}

// Nothing an automatic writer does to memory happens invisibly. Quiet, so it
// waits in the inbox rather than interrupting, and hooks/names only — notices
// persist to data/notices.json, and those already ride in INDEX.md.
function announceReview(r: ExtractionResult): void {
  const parts: string[] = [];
  if (r.saved.length > 0) parts.push(`remembered ${r.saved.map((m) => `[${m.name}]`).join(", ")}`);
  if (r.skills.length > 0) parts.push(`wrote the skill ${r.skills.map((s) => `[${s.name}]`).join(", ")}`);
  for (const t of r.retired) parts.push(`retired [${t.name}] in favour of [${t.by}]`);
  if (parts.length === 0) return; // a review that found nothing is not news
  addNotice("memory", `While we were talking I ${parts.join("; ")}.`, "quiet");
}

// Startup catch-up: settle the debt for sessions that ended without a clean
// close (the face's usual fate). Serial on purpose — this is background work.
export async function catchUpExtractions(): Promise<number> {
  const settled = undistilled(loadConfig().memory.resumeWindowMinutes);
  let savedTotal = 0;
  for (const conv of settled) {
    const r = await extractConversation(conv);
    savedTotal += r.saved.length;
  }
  return savedTotal;
}
