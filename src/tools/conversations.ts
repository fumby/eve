// Looking things up in what was actually said. Long-term memory answers "what
// do I know about X"; this answers "what was that error string", "which shop
// did he name", "did we already decide this" — questions where the answer is
// an exact token in a transcript that was never distilled into a memory, and
// where a semantic index is precisely the wrong instrument.
//
// Read-only, so neither tool is gated. Both are withheld from Factory-spawned
// agents: a transcript is Umberto's whole conversation, including the parts a
// research specialist has no business holding in context.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { searchConversations, conversationWindow } from "../core/conversations.js";
import { localMinute } from "../core/time.js";

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "undated" : localMinute(d).replace("T", " ");
};

export const conversationTools: EveTool[] = [
  {
    name: "search_conversations",
    description:
      "Search everything you and Umberto have actually said to each other, across past sessions, by keyword. This is exact text search, not semantic recall — reach for it when the thing you want is a specific string: a name, a number, an error message, a link, a decision you half-remember making. Use recall_memories instead when you want what you KNOW about a subject rather than what was said about it. Returns the matching turns with a little context and the conversation they came from; read_conversation opens more of one.",
    schema: z.object({
      query: z
        .string()
        .min(2)
        .describe("The words to look for, as they were probably written"),
      limit: z.number().int().min(1).max(15).optional().describe("How many turns to return (default 5)"),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const query = String(input.query);
      const hits = searchConversations(query, typeof input.limit === "number" ? input.limit : 5);
      if (hits.length === 0) {
        return (
          `Nothing in the stored conversations matches "${query}". They only go back so far ` +
          `(the oldest sessions age out), so this means "not in what I still have", not "never said".`
        );
      }
      return hits
        .map(
          (h) =>
            `[${h.conversationId}#${h.index}] ${when(h.at)} · ${h.source} · "${h.title}"\n` +
            `${h.role === "user" ? "Umberto" : "you"}: ${h.excerpt}`,
        )
        .join("\n\n");
    },
  },
  {
    name: "read_conversation",
    description:
      "Read a stretch of one stored conversation — the turns either side of a point in it. Use it after search_conversations to see what surrounded a hit (the id and turn number are in the result, as [id#turn]). Without a turn number you get the end of that conversation. Long turns are truncated and very large windows drop their tail turns (with a note) so the result always stays small — narrow the radius or centre on the exact turn if you need more.",
    schema: z.object({
      conversation: z.string().min(1).describe("The conversation id from a search result"),
      around: z.number().int().min(0).optional().describe("Turn number to centre on; omit for the end"),
      radius: z.number().int().min(1).max(12).optional().describe("Turns either side (default 4)"),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const id = String(input.conversation);
      const w = conversationWindow(
        id,
        typeof input.around === "number" ? input.around : undefined,
        typeof input.radius === "number" ? input.radius : 4,
      );
      if (!w) throw new Error(`no stored conversation with id "${id}" — check a search result for the id`);
      // ── the two caps ──────────────────────────────────────────────────
      // Both born the same evening: a read of a conversation holding dragged
      // page dumps came back 200k+ chars, pushed the next model round past
      // the 200K context ceiling, and the turn died on a provider 400 —
      // while the face kept saying "in progress". fetch_url caps itself at
      // ~10k for the same reason; this reader never did.
      const TURN_CAP = 4_000; // one turn, cut with a marker that says where the rest lives
      const WINDOW_CAP = 12_000; // the whole rendered window, hard ceiling
      const line = (t: { role: string; text: string }, index: number): string => {
        const who = t.role === "user" ? "Umberto" : "you";
        const num = w.from + index;
        if (t.text.length <= TURN_CAP) return `${num}. ${who}: ${t.text}`;
        // A monster turn (a dragged page dump, a pasted log) is cut with a
        // pointer, not rendered whole: the exact strings still live in the
        // store, reachable by search_conversations.
        return (
          `${num}. ${who}: ${t.text.slice(0, TURN_CAP)}\n` +
          `[…turn truncated — ${t.text.length} chars total. search_conversations reaches inside this turn for exact strings.]`
        );
      };
      const rendered: string[] = [];
      let leftOut = 0;
      for (let i = 0; i < w.turns.length; i++) {
        const piece = line(w.turns[i]!, i);
        // The header + what is already rendered + this turn: if the whole
        // window would bust the cap, this and every later turn is left out
        // and COUNTED — a missing turn the model knows about beats a
        // conversation that dies.
        if (rendered.join("\n\n").length + piece.length > WINDOW_CAP - 300) {
          leftOut = w.turns.length - i;
          break;
        }
        rendered.push(piece);
      }
      const header =
        `Conversation ${w.conv.id} (${w.conv.source}, started ${when(w.conv.startedAt)}, ` +
        `${w.conv.turns.length} turns) — showing ${w.from}–${w.from + rendered.length - 1}`;
      return (
        header + ":\n\n" +
        rendered.join("\n\n") +
        (leftOut > 0 ? `\n\n[${leftOut} turn${leftOut > 1 ? "s" : ""} left out to keep this window small — narrow the radius or centre on the turn you need.]` : "")
      );
    },
  },
];
