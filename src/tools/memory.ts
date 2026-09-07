// EVE's hands on her long-term memory: save, update, recall, forget. The store
// itself lives in src/memory/store.ts (one markdown file per memory,
// human-editable); these tools are just her way of reaching it.
//
// Saving and UPDATING are two tools on purpose. saveMemory() replaces a file
// wholesale when handed an existing name, and memory/store/ is git-ignored with
// no remote and no backup — so an overwrite is final. Rather than guard that
// with a flag, save_memory has no `name` field at all: the overwrite is not
// expressible from the frictionless path. It lives in update_memory, which is
// gated. Forgetting deletes data, so it stays gated too.
//
// Neither writer is offered to Factory-spawned agents. Memories are data, never
// instructions.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import {
  MEMORY_TYPES,
  saveMemory,
  deleteMemory,
  getMemory,
  sensitiveForSave,
  type MemoryType,
} from "../memory/store.js";
import { recallMemories } from "../memory/recall.js";
import { loadConfig } from "../core/config.js";
import { addNotice } from "../core/notices.js";

// One shape, built once: the gate predicate, the confirmation text and the
// actual save all read the same fields, so the gate can never open on a
// different string than the one the store will judge.
function saveFields(input: Record<string, unknown>): {
  name?: string;
  type: MemoryType;
  hook: string;
  body: string;
  supersedes?: string;
} {
  return {
    name: input.name ? String(input.name) : undefined,
    type: input.type as MemoryType,
    hook: String(input.hook),
    body: String(input.body),
    supersedes: input.supersedes ? String(input.supersedes) : undefined,
  };
}

// A memory body can run long, and a confirmation card nobody reads to the end
// is not a confirmation. Enough to recognise what is being replaced.
function short(text: string, max = 400): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}… (${t.length - max} more chars)`;
}

export const memoryTools: EveTool[] = [
  {
    name: "save_memory",
    description:
      "Store one NEW durable memory so future sessions know it: something Umberto taught you, a correction he made, a decision on his studies or ventures, a lasting preference, a person who matters. NOT for transient task state, the current conversation, anything already in your core knowledge, or secrets/credentials/private confidences. The hook is one searchable line; the body is the fact plus why it matters and how to apply it. Types: me (facts about him), style (how he wants you to work), project (studies/ventures/active work), personal (his private life — save with care), reference (pointers to external things). This only ever creates. If the new fact makes an EXISTING memory out of date, name that memory in `supersedes` — it is kept on disk but retired from your index and your recall, so the two stop contradicting each other. To fix a memory that was wrong as written, use update_memory instead; to drop one that nothing replaces, forget_memory.",
    schema: z.object({
      type: z.enum(MEMORY_TYPES).describe("Which kind of memory this is"),
      hook: z
        .string()
        .min(8)
        .max(160)
        .describe("One plain line, e.g. 'Umberto's thesis defense is in November 2026'"),
      body: z
        .string()
        .min(10)
        .describe("The fact, why it matters, and how to apply it — a few sentences"),
      supersedes: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Optional: the exact name of the memory this one makes out of date, from your index (e.g. 'thesis-defense-november'). Only when the FACT changed.",
        ),
    }),
    // Withheld from Factory-spawned agents, explicitly rather than by
    // derivation: deciding what deserves durable memory about Umberto is EVE's
    // judgement, not a research specialist's, and a spawned agent runs on a
    // model-written system prompt nobody has read line by line.
    factoryAllowed: false,
    // Saving is meant to be frictionless, so this is normally ungated. The one
    // exception is content that reads like a credential: the store refuses that
    // outright for every other caller, but here there is a human on the other
    // end, so the decision is his rather than the regex's. He sees the text and
    // says yes or no; a "no" (or nobody there) means it is simply not saved.
    // Two conditions, and they are NOT the same kind of thing. The credential
    // check is permanent and code-owned. Retiring a memory is gated only if
    // Umberto asks for it in config (memory.confirmSupersede), because it
    // destroys nothing — the retired file stays on disk — and a gate here
    // would be an auto-deny on every path with no human attached, which is
    // exactly where contradictions accumulate today.
    needsConfirmation: (input) =>
      sensitiveForSave(saveFields(input)) ||
      (Boolean(input.supersedes) && loadConfig().memory.confirmSupersede),
    confirmIntent: (input) => {
      const fields = saveFields(input);
      // Order matters: a save that is BOTH sensitive and superseding must ask
      // the credential question, which is the one with a wrong answer.
      if (sensitiveForSave(fields)) {
        return {
          // What Umberto reads: enough to judge, on his own screen.
          human:
            `This memory looks like it contains a secret (a key, token, password, ` +
            `card number, IBAN or codice fiscale). Save it anyway?\n\n` +
            `  hook: ${fields.hook}\n  body: ${fields.body}`,
          // What gets written to logs/audit.jsonl and the notices inbox: the fact
          // that it was asked, never the thing that was asked about.
          log: "save_memory (content withheld — flagged as possibly containing a secret)",
        };
      }
      const old = fields.supersedes ? getMemory(fields.supersedes) : null;
      return {
        human: old
          ? `Save this and retire [${old.name}]?\n\n` +
            `RETIRING\n  hook: ${short(old.hook)}\n  body: ${short(old.body)}\n\n` +
            `REPLACING IT WITH\n  hook: ${short(fields.hook)}\n  body: ${short(fields.body)}\n\n` +
            `(the retired one stays in memory/store/, out of the index and out of recall)`
          : `Save this memory and retire [${fields.supersedes}]? There is no memory by ` +
            `that name — this will fail.`,
        log: `save_memory superseding ${fields.supersedes} (content withheld)`,
      };
    },
    run: async (input) => {
      // Reaching run() with sensitive content means the gate ran and Umberto
      // said yes — the predicate here is the same one that opened the gate.
      const fields = saveFields(input);
      // "Confirmed" means Umberto SAW the exact content and approved it. That
      // is true when the gate asked (sensitive or confirmed-supersede) and
      // he answered. A frictionless save he never reviewed is still genuinely
      // his (source: user — it came from the conversation), but stamping it
      // "confirmed" would overstate the evidence: the review's point was that
      // an explicitly-confirmed fact must be distinguishable from a save the
      // model chose to make. So: gated → confirmed, ungated → unmarked.
      const wasGated =
        sensitiveForSave(fields) ||
        (Boolean(input.supersedes) && loadConfig().memory.confirmSupersede);
      const mem = saveMemory(
        {
          ...fields,
          source: "user",
          ...(wasGated
            ? { confirmed: true, verified: new Date().toISOString().slice(0, 10) }
            : {}),
        },
        { confirmedByHuman: sensitiveForSave(fields) },
      );
      if (!mem.supersedes) return `Saved [${mem.name}] (${mem.type}): ${mem.hook}`;
      // A retirement that nobody approved still has to be VISIBLE. Hooks only:
      // notices persist to data/notices.json, and hooks already ride in
      // INDEX.md, so this adds no content that wasn't already on disk in clear.
      addNotice(
        "memory",
        `I retired the memory [${mem.supersedes}] and replaced it with [${mem.name}]: ${mem.hook}. ` +
          `The old one is still in memory/store/ — delete its supersededBy line to bring it back.`,
        "quiet",
      );
      return (
        `Saved [${mem.name}] (${mem.type}): ${mem.hook} — and retired [${mem.supersedes}], ` +
        `which is now out of your index and out of recall.`
      );
    },
  },
  {
    name: "update_memory",
    description:
      "Replace an existing memory with a new version, when what you remembered has changed or turned out to be wrong. Needs the memory's name from your index. This REPLACES the entry wholesale — the old hook and body are gone from the index — so it always asks Umberto first and shows him what is being replaced. If the fact is new rather than changed, use save_memory instead; if it is simply no longer true and nothing replaces it, use forget_memory.",
    schema: z.object({
      name: z.string().min(1).describe("The memory name to replace, e.g. 'thesis-defense-november'"),
      type: z.enum(MEMORY_TYPES).describe("Which kind of memory this is"),
      hook: z.string().min(8).max(160).describe("The new one-line hook"),
      body: z.string().min(10).describe("The new fact, why it matters, and how to apply it"),
    }),
    // Always. Replacing a memory is destructive and irreversible in substance:
    // memory/store/ is git-ignored, has no remote and no backup, so the only
    // copy of the old version is the one .trash keeps.
    needsConfirmation: true,
    factoryAllowed: false,
    confirmIntent: (input) => {
      const name = String(input.name);
      const old = getMemory(name);
      // The diff is the whole point of asking: replacing a memory is only
      // judgeable against what it replaces.
      const human = old
        ? `Replace the memory [${name}]?\n\n` +
          `BEFORE\n  hook: ${short(old.hook)}\n  body: ${short(old.body)}\n\n` +
          `AFTER\n  hook: ${short(String(input.hook))}\n  body: ${short(String(input.body))}`
        : `Replace the memory [${name}]? There is no memory by that name — this will fail.`;
      return {
        human,
        // Names already ride in INDEX.md inside the system prompt every turn,
        // so naming one here adds nothing; the bodies must not be persisted.
        log: `update_memory ${name} (content withheld)`,
      };
    },
    run: async (input) => {
      const fields = saveFields(input);
      const name = String(input.name);
      const old = getMemory(name);
      if (!old) throw new Error(`no stored memory named "${name}" — use save_memory to create one`);
      // Provenance carries FORWARD, not from the model's call: source,
      // confirmed, verified, expires and any supersession the old memory
      // participated in are facts about the MEMORY'S HISTORY, and a wholesale
      // replace that drops them (the 2026-09-06 audit's item 9) makes a
      // human-confirmed fact read as an unchecked inference one edit later.
      // The gate already showed Umberto the exact new content; he is the one
      // making this edit, so the result stays as confirmed as it was.
      const mem = saveMemory(
        {
          ...fields,
          source: old.source,
          ...(old.confirmed ? { confirmed: old.confirmed } : {}),
          ...(old.verified ? { verified: old.verified } : {}),
          ...(old.expires ? { expires: old.expires } : {}),
        },
        { confirmedByHuman: sensitiveForSave(fields) },
      );
      return `Updated [${mem.name}] (${mem.type}): ${mem.hook} — the previous version is in memory/store/.trash/`;
    },
  },
  {
    name: "recall_memories",
    description:
      "Search long-term memory and get the full entries back (semantic search when available, keyword otherwise). Use it when the index shows a hook that might matter, or when Umberto refers to something you may have stored. A recalled memory reflects what was true when it was written — verify dates and specifics before acting on them. Retired memories (ones a newer memory superseded) are left out unless you ask for them with include_retired, which is for answering what you USED to believe, never for acting on.",
    schema: z.object({
      query: z.string().min(2).describe("What you're trying to remember, in plain words"),
      include_retired: z
        .boolean()
        .optional()
        .describe("Also search memories that have been superseded. Default false."),
    }),
    needsConfirmation: false,
    // Reading is withheld from spawned agents too. It is not destructive, but a
    // "personal" entry is Umberto's private life, and a research specialist has
    // no business holding it in context. Closed by default; if some future agent
    // genuinely needs it, that is one line and a deliberate decision.
    factoryAllowed: false,
    run: async (input) => {
      const includeRetired = input.include_retired === true;
      const { hits, how } = await recallMemories(String(input.query), undefined, {
        includeRetired,
      });
      if (hits.length === 0) return `No stored memories matched (${how} search).`;
      const lines = hits.map(
        (h) =>
          `[${h.memory.name}] (${h.memory.type}, ${h.memory.created || "undated"}, score ${h.score.toFixed(2)}` +
          `${h.memory.confirmed ? ", ✓ confirmed" : h.memory.source === "extractor" ? ", ~ inferred" : ""}` +
          `${h.memory.verified ? `, verified ${h.memory.verified}` : ""}` +
          `${h.memory.origin ? `, from conversation ${h.memory.origin}` : ""}` +
          // Marked inline rather than filtered out: when history was asked for,
          // the one thing that must not be lost is which of these EVE still
          // believes.
          `${h.memory.supersededBy ? `, RETIRED — replaced by [${h.memory.supersededBy}]` : ""})\n${h.memory.hook}\n${h.memory.body}`,
      );
      return `Found via ${how} search:\n\n${lines.join("\n\n")}`;
    },
  },
  {
    name: "forget_memory",
    description:
      "Permanently delete one memory from long-term storage. This deletes data, so it requires Umberto's explicit confirmation. Needs the memory's name from the index.",
    schema: z.object({
      name: z.string().min(1).describe("The memory name, e.g. 'thesis-defense-november'"),
    }),
    needsConfirmation: true,
    run: async (input) => {
      const name = String(input.name);
      if (!getMemory(name)) throw new Error(`no stored memory named "${name}"`);
      const gone = deleteMemory(name)!;
      return `Forgot [${gone.name}]: ${gone.hook}`;
    },
  },
];
