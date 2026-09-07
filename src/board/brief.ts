// The briefs. Built from EVE's real loaders at meeting time — never from a
// number written down in a file. There is no business data yet, and the brief
// says so plainly instead of pretending.
import { memoriesAsFacts } from "../memory/store.js";
import { coreKnowledge } from "../brain/prompt.js";
import { loadReminders } from "../tools/reminders.js";
import { loadConversations, conversationTitle } from "../core/conversations.js";
import { usageToday } from "../core/audit.js";

// What every seat sees: enough context to be specific, none of the detail.
// Only the chair reads everything — it is the one who reconciles.
// The situation is read from the same core knowledge EVE reads every turn —
// never hardcoded in code. The review flagged the old version for embedding
// fixed assumptions ("a business administration student in Naples") that
// could go stale; core knowledge is Umberto's to edit, and it is always current.
export function shortBrief(): string {
  const facts = memoriesAsFacts();
  const open = loadReminders().filter((r) => !r.done);
  return [
    "The person asking: Umberto.",
    coreKnowledge() || "(no core knowledge on file — his situation is unknown to EVE)",
    facts.length ? `Known about him: ${facts.map((f) => f.text).join(" ")}` : "",
    open.length ? `Open commitments: ${open.map((r) => r.text).join("; ")}.` : "",
    `Today is ${new Date().toDateString()}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// What only the chair sees: the full live picture, read fresh.
export async function fullBrief(): Promise<string> {
  const facts = memoriesAsFacts();
  const open = loadReminders().filter((r) => !r.done);
  const convs = loadConversations().slice(0, 6);
  const usage = await usageToday();
  // The review's finding: the brief was context, not evidence. Open
  // commitments and decisions ARE his situation — the board cannot advise on
  // a trade-off it can't see. Read dynamically so the brief never hardcodes
  // assumptions (the earlier fixed-assumption bug lives in this file's
  // history as the reminder).
  let commitmentsLines: string[] = [];
  let decisionLines: string[] = [];
  try {
    const { openCommitmentsDue, openCommitments } = await import("../tools/commitments.js");
    const today = new Date().toISOString().slice(0, 10);
    const waiting = openCommitmentsDue(today);
    const waitingIds = new Set(waiting.map((c) => c.id));
    if (waiting.length > 0) {
      commitmentsLines.push("Commitments past due or awaiting others (the live pressure):");
      commitmentsLines.push(...waiting.map((c) => `  - ${c.text} (owner: ${c.owner}, status: ${c.status})`));
    }
    const other = openCommitments().filter((c) => !waitingIds.has(c.id)).slice(0, 6);
    if (other.length > 0) {
      commitmentsLines.push("Other open commitments:");
      commitmentsLines.push(...other.map((c) => `  - ${c.text} (owner: ${c.owner}, due: ${c.due ?? "none"})`));
    }
  } catch {
    // no commitments store = honestly none
  }
  try {
    const { openDecisions } = await import("../tools/decisions.js");
    const openD = openDecisions().slice(0, 5);
    if (openD.length > 0) {
      // These are EVE's RECOMMENDATIONS, not Umberto's rulings — record_decision
      // writes a recommendation with its uncertainty, and "open" means he has
      // not answered it yet. The old header ("decisions he has already taken")
      // told the model to treat its own proposal as his settled position and
      // not to re-open it, which is how a suggestion becomes a fact.
      decisionLines.push("Open recommendations (proposed, not yet his decision):");
      decisionLines.push(...openD.map((d) => `  - ${d.title}: recommended ${d.recommendation}; next step: ${d.nextStep}`));
    }
  } catch {
    // no decision store = honestly none
  }
  return [
    `Live situation for Umberto as of ${new Date().toString()}:`,
    "",
    coreKnowledge() || "(no core knowledge on file)",
    "",
    facts.length ? "Long-term memory hooks:" : "Long-term memory: empty.",
    ...facts.map((f) => `  - ${f.text}`),
    "",
    ...(open.length ? ["Open commitments:", ...open.map((r) => `  - ${r.text}${r.due ? ` (due ${r.due})` : ""}`)] : ["Open commitments: none."]),
    "",
    ...(commitmentsLines.length ? commitmentsLines : ["Tracked commitments: none."]),
    "",
    ...(decisionLines.length ? decisionLines : ["Decision ledger: nothing open."]),
    "",
    ...(convs.length ? ["Recent conversations:", ...convs.map((c) => `  - ${conversationTitle(c)} (${c.turns.length} turns, ${c.updatedAt.slice(0, 10)})`)] : []),
    "",
    `EVE's own running cost today: $${usage.cost.toFixed(2)} over ${usage.turns} model turns.`,
    "",
    "Honest data note: anything the seats or you assert about business numbers",
    "is reasoning from the situation above, not measurement — verify with the",
    "ledger tool before stating a number as fact.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
