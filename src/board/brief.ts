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
export function shortBrief(): string {
  const facts = memoriesAsFacts();
  const open = loadReminders().filter((r) => !r.done);
  return [
    "The person asking: Umberto, a business administration student in Naples, Italy.",
    "He has no active venture yet — questions may concern starting one.",
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
  return [
    `Live situation for Umberto as of ${new Date().toString()}:`,
    "",
    coreKnowledge() || "(no core knowledge on file)",
    "",
    facts.length ? "Long-term memory hooks:" : "Long-term memory: empty.",
    ...facts.map((f) => `  - ${f.text}`),
    "",
    open.length ? "Open commitments:" : "Open commitments: none.",
    ...open.map((r) => `  - ${r.text}${r.due ? ` (due ${r.due})` : ""}`),
    "",
    convs.length ? "Recent conversations:" : "",
    ...convs.map((c) => `  - ${conversationTitle(c)} (${c.turns.length} turns, ${c.updatedAt.slice(0, 10)})`),
    "",
    `EVE's own running cost today: $${usage.cost.toFixed(2)} over ${usage.turns} model turns.`,
    "",
    "Honest data note: no venture exists yet, so there is no revenue, customer,",
    "or pipeline data. Anything the seats or you assert about business numbers",
    "is reasoning, not measurement.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
