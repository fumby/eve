// Waiting-for tracking — the executive assistant capability the review flagged
// as the "largest product gap." A reminder says "do this." A commitment says
// "do this, by then, because of that, and here's who owes you a reply."
//
// Each commitment has: a description, an owner (who's responsible — could be
// Umberto or someone else), a deadline, a status (pending / waiting / done /
// blocked), a source (where it came from — a conversation, a meeting, a
// reminder), and a next follow-up date. The heartbeat can surface "you're
// waiting on X, it's been 3 days, want me to follow up?"
//
// State lives in data/commitments.json — plain JSON, human-readable, the
// same "no database" principle as everything else.
import { z } from "zod";
import { readJson, writeJson } from "../core/store.js";
import { addNotice } from "../core/notices.js";
import { audit } from "../core/audit.js";
import type { EveTool } from "../core/registry.js";

interface Commitment {
  id: string;
  text: string; // what the commitment is
  owner: string; // who's responsible — "me", "Marco", "the bank"
  status: "pending" | "waiting" | "done" | "blocked";
  due: string | null; // ISO date, or null if no deadline
  followUp: string | null; // ISO date — when to check back
  source: string; // where it came from
  createdAt: string;
  updatedAt: string;
}

const FILE = "commitments.json";

function loadCommitments(): Commitment[] {
  return readJson<Commitment[]>(FILE, []);
}

function saveCommitments(list: Commitment[]): void {
  writeJson(FILE, list);
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// The heartbeat's waiting-for review reads this: not-done commitments that are
// past due or past their follow-up date. Exported so the selection logic is
// testable without a Heartbeat instance, and so the heartbeat doesn't reach
// into the tool's private file shape.
export function openCommitmentsDue(today: string): Commitment[] {
  return loadCommitments().filter(
    (c) =>
      c.status !== "done" &&
      ((c.due !== null && c.due <= today) || (c.followUp !== null && c.followUp <= today)),
  );
}

// All not-done commitments, newest first — for the board brief and any
// caller that wants the full open set, not just the overdue slice.
export function openCommitments(): Commitment[] {
  return loadCommitments()
    .filter((c) => c.status !== "done")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const commitmentTools: EveTool[] = [
  {
    name: "track_commitment",
    description:
      "Record a commitment — something Umberto owes, or something someone owes HIM. Use it when he says 'I need to send X by Friday', 'Marco owes me a reply about Y', 'I'm waiting on the bank for Z'. Unlike a reminder, a commitment tracks WHO is responsible, a STATUS (pending/waiting/done/blocked), a DEADLINE, and a FOLLOW-UP date. EVE can later surface 'you're waiting on Marco and it's been 3 days' and prepare a follow-up. This is the executive assistant's core job: making sure nothing falls through the cracks.",
    schema: z.object({
      text: z.string().min(3).max(300).describe("What the commitment is, e.g. 'Send the proposal to Marco' or 'Bank reply about the mortgage'"),
      owner: z.string().min(1).max(100).describe("Who's responsible: 'me' if it's Umberto's, or the person/org that owes it"),
      status: z.enum(["pending", "waiting", "done", "blocked"]).default("pending").describe("pending = not started; waiting = sent, awaiting reply; done = complete; blocked = stuck on a dependency"),
      due: z.string().optional().describe("Deadline, ISO date 'YYYY-MM-DD'. Omit if no specific deadline."),
      followUp: z.string().optional().describe("When to check back, ISO date 'YYYY-MM-DD'. Omit and EVE will pick a reasonable default (3 days if waiting, 7 if pending)."),
      source: z.string().optional().describe("Where the commitment came from, e.g. 'conversation with Marco' or 'board meeting'. Defaults to 'tracked by EVE'."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const list = loadCommitments();
      const now = new Date().toISOString();
      const due = input.due ? String(input.due) : null;
      // Default follow-up: 3 days if waiting, 7 days if pending, none if done.
      const followUp = input.followUp
        ? String(input.followUp)
        : input.status === "waiting"
          ? new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
          : input.status === "pending"
            ? new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)
            : null;
      const c: Commitment = {
        id: newId(),
        text: String(input.text),
        owner: String(input.owner),
        status: String(input.status ?? "pending") as Commitment["status"],
        due,
        followUp,
        source: input.source ? String(input.source) : "tracked by EVE",
        createdAt: now,
        updatedAt: now,
      };
      list.push(c);
      saveCommitments(list);
      audit("commitment_tracked", { id: c.id, owner: c.owner, status: c.status });
      return `Tracked: "${c.text}" — owner: ${c.owner}, status: ${c.status}${c.due ? `, due ${c.due}` : ""}${c.followUp ? `, follow-up ${c.followUp}` : ""}. ID ${c.id}.`;
    },
  },
  {
    name: "list_commitments",
    description:
      "List Umberto's tracked commitments — what's pending, what he's waiting on, what's due soon. Use it for 'what am I waiting on?', 'what's pending?', 'is there anything I owe someone?'. Filters by status (default: not done) and optionally by owner.",
    schema: z.object({
      status: z.enum(["pending", "waiting", "done", "blocked", "all"]).default("all").describe("Filter by status. 'all' (default) shows everything. Use 'waiting' for 'what am I waiting on?'."),
      owner: z.string().optional().describe("Filter by owner, e.g. 'me' or 'Marco'. Omit for all."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      let list = loadCommitments();
      const status = String(input.status ?? "all");
      if (status !== "all") list = list.filter((c) => c.status === status);
      if (input.owner) {
        const owner = String(input.owner).toLowerCase();
        list = list.filter((c) => c.owner.toLowerCase().includes(owner));
      }
      // Exclude done unless explicitly asked
      if (status === "all") list = list.filter((c) => c.status !== "done");
      if (list.length === 0) return "No commitments tracked. Use track_commitment to add one.";
      // Sort: due soonest first, then by follow-up
      list.sort((a, b) => {
        const aDate = a.due ?? a.followUp ?? "9999";
        const bDate = b.due ?? b.followUp ?? "9999";
        return aDate.localeCompare(bDate);
      });
      const lines = list.map((c) => {
        const dueTag = c.due ? ` (due ${c.due})` : "";
        const followTag = c.followUp ? ` — follow up ${c.followUp}` : "";
        const statusTag = c.status === "waiting" ? " ⏳" : c.status === "blocked" ? " 🚫" : c.status === "done" ? " ✓" : "";
        // FULL id: the 6-char truncation made two same-second commitments
        // display identically, and the model updated the wrong one.
        return `  • [${c.id}] ${c.text} — owner: ${c.owner}, status: ${c.status}${statusTag}${dueTag}${followTag}`;
      });
      return `Commitments (${list.length}):\n${lines.join("\n")}`;
    },
  },
  {
    name: "update_commitment",
    description:
      "Update a commitment's status — mark it done, change it to waiting, extend a deadline, or add a follow-up note. Use it when Umberto says 'Marco replied' (mark done), 'still waiting on the bank' (keep waiting), or 'I need more time' (extend the deadline). Needs the commitment ID from list_commitments.",
    schema: z.object({
      id: z.string().min(1).describe("The commitment ID (or first 6 chars) from list_commitments"),
      status: z.enum(["pending", "waiting", "done", "blocked"]).optional().describe("New status, if changing it"),
      due: z.string().optional().describe("New deadline, ISO date. Pass an empty string to clear it."),
      followUp: z.string().optional().describe("New follow-up date, ISO date. Pass an empty string to clear it."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const list = loadCommitments();
      const id = String(input.id);
      // Unambiguous resolution: exact match wins; a PREFIX is accepted only
      // when exactly ONE record matches it. The review reproduced two
      // commitments created in the same second whose 6-char display IDs were
      // identical — a prefix match picked the first and updated the WRONG
      // commitment (marked done the wrong item). Ambiguity now refuses
      // loudly instead of guessing.
      const exact = list.find((c) => c.id === id);
      let c: Commitment | undefined = exact;
      if (!c) {
        const prefixMatches = list.filter((x) => x.id.startsWith(id));
        if (prefixMatches.length === 1) c = prefixMatches[0];
        else if (prefixMatches.length > 1)
          throw new Error(
            `"${id}" matches ${prefixMatches.length} commitments — the prefix is ambiguous. ` +
              `Use the FULL id: ${prefixMatches.slice(0, 3).map((m) => `${m.id} ("${m.text.slice(0, 40)}")`).join(", ")}`,
          );
      }
      if (!c) throw new Error(`no commitment with ID "${id}" — use list_commitments to see them`);
      if (input.status) c.status = String(input.status) as Commitment["status"];
      if (input.due !== undefined) c.due = input.due === "" ? null : String(input.due);
      if (input.followUp !== undefined) c.followUp = input.followUp === "" ? null : String(input.followUp);
      c.updatedAt = new Date().toISOString();
      saveCommitments(list);
      audit("commitment_updated", { id: c.id, status: c.status });
      return `Updated: "${c.text}" — now ${c.status}${c.due ? `, due ${c.due}` : ""}.`;
    },
  },
];
