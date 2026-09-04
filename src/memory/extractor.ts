// The automatic memory extractor: when a session ends (or a settled one is
// found at startup), a cheap model reads the stored transcript and proposes
// the genuinely durable facts. Deliberate saves catch the important thing in
// the moment; this catches what everyone forgot to save. Three guards stand
// between a proposal and the store: the model is shown what's already known
// (and told to skip it), a code-side similarity check rejects near-duplicates
// anyway, and a sensitive-content filter refuses secrets outright.
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

const MAX_PROPOSALS = 5;
const MAX_TRANSCRIPT_CHARS = 24_000;
// Above these similarity scores a proposal is "already covered".
const DUP_SEMANTIC = 0.85;
const DUP_LEXICAL = 0.5;

export interface ExtractionResult {
  saved: StoredMemory[];
  skipped: { hook: string; reason: string }[];
  note: string; // one line for logs: what happened and why
}

const SYSTEM = `You are the memory extractor for EVE, Umberto's personal assistant. You read a finished conversation transcript and decide what deserves LONG-TERM memory.

Worth keeping: things Umberto taught EVE, corrections he made, decisions about his studies or ventures, lasting preferences, people who matter, meaningful personal-life facts.
Not worth keeping: transient task state, chit-chat, questions and answers that changed nothing, anything already in the "already known" list, tests or debugging chatter. Never propose secrets, API keys, passwords, or other people's private confidences.

Reply with ONLY a JSON object, no prose:
{"memories":[{"type":"me|style|project|personal|reference","hook":"one plain searchable line","body":"the fact, why it matters, how to apply it"}]}
An empty list ({"memories":[]}) is a perfectly good answer — most conversations contain nothing durable.`;

function transcriptOf(conv: Conversation): string {
  const text = conv.turns
    .map((t) => `${t.role === "user" ? "Umberto" : "EVE"}: ${t.text}`)
    .join("\n");
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(-MAX_TRANSCRIPT_CHARS) : text;
}

// One conversation through the extractor. Never throws — end-of-session
// bookkeeping must not take anything down with it.
export async function extractConversation(conv: Conversation | null): Promise<ExtractionResult> {
  const none = (note: string): ExtractionResult => ({ saved: [], skipped: [], note });
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

    const parsed = parseProposals(raw);
    const saved: StoredMemory[] = [];
    const skipped: { hook: string; reason: string }[] = [];

    for (const p of parsed.slice(0, MAX_PROPOSALS)) {
      // Checked here as well as at the store, and the ORDER is load-bearing:
      // the duplicate check below calls recallMemories(), which embeds the hook
      // through the Voyage API. Refusing first is what keeps a credential from
      // leaving the machine at all. The store's throw is the backstop, caught
      // below — nobody on this path can answer a confirmation anyway.
      if (isSensitive(`${p.hook}\n${p.body}`)) {
        skipped.push({ hook: p.hook, reason: "sensitive content refused" });
        continue;
      }
      // Near-duplicate check against what's actually stored, not just what
      // the model was shown — models skim.
      if (listMemories().length > 0) {
        const { hits, how } = await recallMemories(p.hook, 1);
        const top = hits[0];
        const bar = how === "semantic" ? DUP_SEMANTIC : DUP_LEXICAL;
        if (top && top.score >= bar) {
          skipped.push({ hook: p.hook, reason: `already covered by [${top.memory.name}]` });
          continue;
        }
      }
      try {
        saved.push(saveMemory({ type: p.type, hook: p.hook, body: p.body }));
      } catch (err) {
        // The store has the final say. Here that is just one more skip, worded
        // exactly as before; anything else is a real failure and must surface.
        if (!(err instanceof SensitiveContentError)) throw err;
        skipped.push({ hook: p.hook, reason: "sensitive content refused" });
      }
    }

    markDistilled(conv.id);
    const note = `extractor: ${saved.length} saved, ${skipped.length} skipped (${conv.id})`;
    audit("memory_extract", {
      conversation: conv.id,
      saved: saved.map((m) => m.name),
      skipped,
    });
    return { saved, skipped, note };
  } catch (err) {
    return none(`extractor failed quietly: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseProposals(raw: string): { type: MemoryType; hook: string; body: string }[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]) as { memories?: unknown };
    if (!Array.isArray(j.memories)) return [];
    return j.memories
      .filter(
        (x): x is { type: string; hook: string; body: string } =>
          typeof x === "object" &&
          x !== null &&
          typeof (x as { hook?: unknown }).hook === "string" &&
          typeof (x as { body?: unknown }).body === "string",
      )
      .map((x) => ({
        type: (MEMORY_TYPES as readonly string[]).includes(x.type)
          ? (x.type as MemoryType)
          : "reference",
        hook: x.hook.replace(/\s+/g, " ").trim().slice(0, 160),
        body: x.body.trim(),
      }))
      .filter((x) => x.hook.length >= 8 && x.body.length >= 10);
  } catch {
    return [];
  }
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
