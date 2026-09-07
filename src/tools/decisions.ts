// Decision records — the repeatable format for consequential decisions, from
// the executive-assistant review: a decision worth tracking gets options with
// the strongest argument for and against, a recommendation with explicit
// uncertainty, what would change it, a bounded next step with an owner, and a
// review date. The eventual outcome is recorded against it, so past advice can
// be inspected against reality instead of just remembered fondly.
//
// Plain JSON in data/decisions.json, same doctrine as everything else: one
// file, human-readable, hand-editable. Task state stays out of long-term
// memory — this is the review's "keep task state out of generic memories"
// rule, applied to decisions.
import { z } from "zod";
import { readJson, writeJson } from "../core/store.js";
import { audit } from "../core/audit.js";
import type { EveTool } from "../core/registry.js";

interface DecisionOption {
  name: string;
  pro: string; // the strongest argument FOR
  con: string; // the strongest argument AGAINST
}

interface Decision {
  id: string;
  title: string;
  context: string; // deadline, objective, constraints
  facts: string; // known facts, with sources and dates
  unknowns: string; // assumptions and missing evidence, named as such
  options: DecisionOption[];
  recommendation: string;
  uncertainty: string;
  wouldChangeMind: string;
  nextStep: string;
  owner: string;
  reviewBy: string | null; // ISO date — when to revisit
  status: "open" | "closed";
  outcome: string | null; // what actually happened
  lesson: string | null; // what EVE should learn from it
  createdAt: string;
  closedAt: string | null;
}

const FILE = "decisions.json";

function loadDecisions(): Decision[] {
  return readJson<Decision[]>(FILE, []);
}

function saveDecisions(list: Decision[]): void {
  writeJson(FILE, list);
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// The heartbeat's follow-up check reads this: decisions still open whose
// review date has arrived. Exported so the collection logic is testable
// without a Heartbeat instance.
export function decisionsDueForReview(today: string): Decision[] {
  return loadDecisions().filter(
    (d) => d.status === "open" && d.reviewBy !== null && d.reviewBy <= today,
  );
}

export function openDecisions(): Decision[] {
  return loadDecisions().filter((d) => d.status === "open");
}

function fmt(d: Decision): string {
  const opt = d.options.map((o) => `${o.name} (+ ${o.pro} / − ${o.con})`).join("; ");
  return [
    `[${d.id}] ${d.title} — ${d.status}${d.reviewBy ? `, review by ${d.reviewBy}` : ""}`,
    `  context: ${d.context}`,
    // The evidence, not just the conclusion. The listing used to print the
    // recommendation with the facts it rests on, the unknowns it was hedged
    // against, and what would overturn it all stripped off — so a stale
    // recommendation read exactly like a fresh one, and got re-trusted
    // without being re-checked. Each line appears only when it has content.
    d.facts ? `  facts: ${d.facts}` : "",
    d.unknowns ? `  unknowns: ${d.unknowns}` : "",
    `  options: ${opt || "(none recorded)"}`,
    `  recommendation: ${d.recommendation}${d.uncertainty ? ` (uncertainty: ${d.uncertainty})` : ""}`,
    d.wouldChangeMind ? `  would change my mind: ${d.wouldChangeMind}` : "",
    `  next step: ${d.nextStep} (owner: ${d.owner})`,
    d.outcome ? `  outcome: ${d.outcome}${d.lesson ? ` — lesson: ${d.lesson}` : ""}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export const decisionTools: EveTool[] = [
  {
    name: "record_decision",
    description:
      "Record a consequential decision in EVE's decision ledger — the structured format for decisions that matter: the context (deadline, objective, constraints), the known facts WITH sources, the assumptions and missing evidence named honestly, two or three realistic options each with the strongest argument for and against (include 'do nothing' when it's a real option), a recommendation with its uncertainty stated, what evidence would change your mind, the smallest useful next step with an owner, and a review date. Use it when Umberto makes (or asks for) a real decision — a venture choice, a money commitment, a study/career trade-off. The review date is what makes this valuable: EVE will surface it when it arrives, and the outcome gets recorded against the recommendation so future advice learns from it. NOT for casual preferences — those are memories.",
    schema: z.object({
      title: z.string().min(4).max(160).describe("The decision, one line, e.g. 'Whether to take the Barcelona internship'"),
      context: z.string().min(10).max(2000).describe("Deadline, objective, and the constraints that bound the choice"),
      facts: z.string().max(2000).describe("Known facts relevant to the decision, each with its source and date where possible"),
      unknowns: z.string().max(1000).describe("Assumptions being made and evidence that is missing — named as unknowns, not folded into the facts"),
      options: z
        .array(
          z.object({
            name: z.string().min(2).max(80).describe("The option, short name"),
            pro: z.string().min(3).max(400).describe("The strongest argument FOR this option"),
            con: z.string().min(3).max(400).describe("The strongest argument AGAINST this option"),
          }),
        )
        .min(1)
        .max(4)
        .describe("Two or three realistic options. Include 'do nothing' when it's genuinely on the table."),
      recommendation: z.string().min(3).max(800).describe("Which option you recommend, and in a word, why"),
      uncertainty: z.string().max(600).describe("What you're least sure about in this recommendation"),
      wouldChangeMind: z.string().max(600).describe("What evidence, if it arrived, would change the recommendation"),
      nextStep: z.string().min(3).max(300).describe("The smallest useful next step — an experiment, a call, a draft — not the whole plan"),
      owner: z.string().min(1).max(80).describe("Who owns the next step: 'me' if Umberto, or the person who does it"),
      reviewBy: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD")
        .optional()
        .describe("When to revisit this decision, ISO date. Omit only for decisions that close themselves."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const now = new Date().toISOString();
      const d: Decision = {
        id: newId(),
        title: String(input.title),
        context: String(input.context),
        facts: String(input.facts ?? ""),
        unknowns: String(input.unknowns ?? ""),
        options: (input.options as DecisionOption[]) ?? [],
        recommendation: String(input.recommendation),
        uncertainty: String(input.uncertainty ?? ""),
        wouldChangeMind: String(input.wouldChangeMind ?? ""),
        nextStep: String(input.nextStep),
        owner: String(input.owner),
        reviewBy: input.reviewBy ? String(input.reviewBy) : null,
        status: "open",
        outcome: null,
        lesson: null,
        createdAt: now,
        closedAt: null,
      };
      const all = loadDecisions();
      all.push(d);
      saveDecisions(all);
      audit("decision_recorded", { id: d.id, title: d.title.slice(0, 80), reviewBy: d.reviewBy });
      const review = d.reviewBy ? ` I'll surface it for review on ${d.reviewBy}.` : "";
      return `Decision [${d.id}] recorded: ${d.title}.${review} When the outcome arrives, tell me and I'll close it with what we learned — that's what makes the next recommendation better.`;
    },
  },
  {
    name: "list_decisions",
    description:
      "List EVE's decision ledger — open decisions with their recommendations, uncertainties, next steps and review dates; optionally closed ones with their outcomes and lessons. Use it when Umberto asks 'what did we decide', 'what's pending', or before a related decision, so past advice is consulted rather than re-derived.",
    schema: z.object({
      includeClosed: z.boolean().optional().describe("Also show closed decisions with outcomes and lessons. Default false."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const all = loadDecisions();
      const shown = input.includeClosed === true ? all : all.filter((d) => d.status === "open");
      if (shown.length === 0)
        return input.includeClosed === true
          ? "The decision ledger is empty."
          : "No open decisions. (Pass includeClosed to see the whole ledger.)";
      return `Decision ledger (${shown.length}):\n\n${shown.map(fmt).join("\n\n")}`;
    },
  },
  {
    name: "close_decision",
    description:
      "Close a decision by recording what actually happened — the outcome is written against the recommendation that was made, plus the lesson EVE should carry forward. Use it when a decision resolves ('I took the internship', 'we passed on it'). This is the step that turns advice into learning: an open loop of recommend → review → outcome, so past recommendations can be inspected against reality.",
    schema: z.object({
      id: z.string().min(1).describe("The decision id from list_decisions. A leading fragment works only when it matches exactly one decision — if it matches more, EVE will refuse and ask for the full id."),
      outcome: z.string().min(5).max(1200).describe("What actually happened — the real result, not the expected one"),
      lesson: z.string().max(600).optional().describe("What to carry forward — what the recommendation got right or wrong, and why"),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const all = loadDecisions();
      const id = String(input.id);
      // Unambiguous resolution, the same rule as update_commitment: an exact
      // id always wins, a PREFIX is honoured only when exactly ONE decision
      // matches it. The old `find(x => x.id === id || x.id.startsWith(id))`
      // took the first prefix match silently — reproduced with two decisions
      // recorded in the same millisecond, it wrote the outcome against the
      // WRONG recommendation. That is worse than a wrong to-do: the ledger is
      // what future advice gets checked against, so it stays quietly wrong.
      const exact = all.find((x) => x.id === id);
      let d: Decision | undefined = exact;
      if (!d) {
        const prefixMatches = all.filter((x) => x.id.startsWith(id));
        if (prefixMatches.length === 1) d = prefixMatches[0];
        else if (prefixMatches.length > 1)
          throw new Error(
            `"${id}" matches ${prefixMatches.length} decisions — the prefix is ambiguous. ` +
              `Use the FULL id: ${prefixMatches.slice(0, 3).map((m) => `${m.id} ("${m.title.slice(0, 40)}")`).join(", ")}`,
          );
      }
      if (!d) throw new Error(`no decision with id "${id}" — use list_decisions to see them`);
      if (d.status === "closed") throw new Error(`[${d.id}] is already closed: ${d.outcome ?? ""}`);
      d.status = "closed";
      d.outcome = String(input.outcome);
      d.lesson = input.lesson ? String(input.lesson) : null;
      d.closedAt = new Date().toISOString();
      saveDecisions(all);
      audit("decision_closed", { id: d.id, title: d.title.slice(0, 80) });
      return `Closed [${d.id}] "${d.title}" — outcome recorded${d.lesson ? ` with lesson: ${d.lesson}` : ""}.`;
    },
  },
];
