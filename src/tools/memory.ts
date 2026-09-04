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

// One shape, built once: the gate predicate, the confirmation text and the
// actual save all read the same fields, so the gate can never open on a
// different string than the one the store will judge.
function saveFields(input: Record<string, unknown>): {
  name?: string;
  type: MemoryType;
  hook: string;
  body: string;
} {
  return {
    name: input.name ? String(input.name) : undefined,
    type: input.type as MemoryType,
    hook: String(input.hook),
    body: String(input.body),
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
      "Store one NEW durable memory so future sessions know it: something Umberto taught you, a correction he made, a decision on his studies or ventures, a lasting preference, a person who matters. NOT for transient task state, the current conversation, anything already in your core knowledge, or secrets/credentials/private confidences. The hook is one searchable line; the body is the fact plus why it matters and how to apply it. Types: me (facts about him), style (how he wants you to work), project (studies/ventures/active work), personal (his private life — save with care), reference (pointers to external things). This only ever creates; to change a memory that already exists, use update_memory.",
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
    needsConfirmation: (input) => sensitiveForSave(saveFields(input)),
    confirmIntent: (input) => ({
      // What Umberto reads: enough to judge, on his own screen.
      human:
        `This memory looks like it contains a secret (a key, token, password, ` +
        `card number, IBAN or codice fiscale). Save it anyway?\n\n` +
        `  hook: ${String(input.hook)}\n  body: ${String(input.body)}`,
      // What gets written to logs/audit.jsonl and the notices inbox: the fact
      // that it was asked, never the thing that was asked about.
      log: "save_memory (content withheld — flagged as possibly containing a secret)",
    }),
    run: async (input) => {
      // Reaching run() with sensitive content means the gate ran and Umberto
      // said yes — the predicate here is the same one that opened the gate.
      const fields = saveFields(input);
      const mem = saveMemory(fields, { confirmedByHuman: sensitiveForSave(fields) });
      return `Saved [${mem.name}] (${mem.type}): ${mem.hook}`;
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
      const mem = saveMemory(fields, { confirmedByHuman: sensitiveForSave(fields) });
      return `Updated [${mem.name}] (${mem.type}): ${mem.hook} — the previous version is in memory/store/.trash/`;
    },
  },
  {
    name: "recall_memories",
    description:
      "Search long-term memory and get the full entries back (semantic search when available, keyword otherwise). Use it when the index shows a hook that might matter, or when Umberto refers to something you may have stored. A recalled memory reflects what was true when it was written — verify dates and specifics before acting on them.",
    schema: z.object({
      query: z.string().min(2).describe("What you're trying to remember, in plain words"),
    }),
    needsConfirmation: false,
    // Reading is withheld from spawned agents too. It is not destructive, but a
    // "personal" entry is Umberto's private life, and a research specialist has
    // no business holding it in context. Closed by default; if some future agent
    // genuinely needs it, that is one line and a deliberate decision.
    factoryAllowed: false,
    run: async (input) => {
      const { hits, how } = await recallMemories(String(input.query));
      if (hits.length === 0) return `No stored memories matched (${how} search).`;
      const lines = hits.map(
        (h) =>
          `[${h.memory.name}] (${h.memory.type}, ${h.memory.created || "undated"}, score ${h.score.toFixed(2)})\n${h.memory.hook}\n${h.memory.body}`,
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
