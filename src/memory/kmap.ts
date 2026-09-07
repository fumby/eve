// The knowledge map: one derived paragraph that tells EVE WHERE every kind
// of knowledge lives and which tool reaches it — the missing layer of her
// memory structure. Before this, seven shelves existed (long-term memory,
// transcripts, research reports, ESSEC knowledge, skills, commitments,
// decisions, study notes) and nothing in the prompt said which shelf holds
// what; finding context depended on the model remembering tool descriptions,
// which is exactly what rots.
//
// Every line is DERIVED from what actually exists on disk (counts, newest
// entry ages), so the map can never claim a shelf that isn't there — the
// same doctrine as capabilitiesSection: if it isn't derivable, EVE doesn't
// claim it. It rides in the stable block, prompt-cached like the rest.
import { listMemories } from "./store.js";
import { listSkills } from "../skills/store.js";
import { loadConversations, loadArchived } from "../core/conversations.js";
import { listReports } from "./reports.js";
import { readJson } from "../core/store.js";
import { loadConfig } from "../core/config.js";
import fs from "node:fs";
import path from "node:path";

// How old the newest entry of a shelf is, in whole days — "7d" / "3mo" / "".
function ageOf(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const days = Math.floor((now.getTime() - t) / 86_400_000);
  if (days < 1) return "today";
  if (days < 31) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${Math.round(days / 365)}y`;
}

// A count with its newest-entry age, or "empty" — never a silent zero that
// reads as "never used" next to a shelf that is simply young.

export function knowledgeMapSection(now: Date = new Date()): string {
  const memories = listMemories();
  const convs = loadConversations();
  const archived = loadArchived();
  const reports = listReports();
  const skills = listSkills();

  // The tool-read JSON shelves, counted without loading their modules: read
  // the files directly through the same readJson the tools use. A missing
  // file is an empty shelf, stated as such.
  const commitments = readJson<{ status?: string; createdAt?: string }[]>("commitments.json", []);
  const decisions = readJson<{ status?: string; createdAt?: string }[]>("decisions.json", []);

  const line = (label: string, value: string): string => `- ${label}: ${value}`;

  // Count + noun + newest age, so the line reads "3 memories (newest 2d)"
  // — the number sits next to the noun it counts, not buried in a paren
  // after the shelf's description.
  const count = (n: number, noun: string, newestIso: string): string => {
    if (n === 0) return `no ${noun}s yet`;
    const age = ageOf(newestIso, now);
    return `${n} ${noun}${n === 1 ? "" : "s"}${age ? ` (newest ${age})` : ""}`;
  };

  const items = [
    line(
      `What you KNOW about him and your work together — ${count(memories.length, "memory", newest(memories.map((m) => m.created)))} in long-term memory`,
      `recall_memories searches it; the full index is above.`,
    ),
    line(
      `What was SAID — ${count(convs.length, "conversation", newest(convs.map((c) => c.updatedAt)))}` +
        `${archived.length > 0 ? ` in the live store, ${archived.length} archived` : " in the live store"}`,
      `search_conversations / read_conversation find the exact words, names, errors and links of past sessions.`,
    ),
    line(
      `What you FOUND — ${count(reports.length, "report", newest(reports.map((r) => r.openedAt)))} in the deep-research archive`,
      `search_reports / read_report return finished investigations with their sources and caveats.`,
    ),
    line(
      `HOW to do things — ${count(skills.length, "skill", newest(skills.map((s) => s.updated)))}`,
      `view_skill reads the steps; the triggers are listed above.`,
    ),
    line(
      `What you OWE and who owes him — ${count(commitments.length, "commitment", newest(commitments.map((c) => c.createdAt ?? "")))}`,
      `list_commitments; open items also surface on their own.`,
    ),
    line(
      `What you DECIDED together — ${count(decisions.length, "decision", newest(decisions.map((d) => d.createdAt ?? "")))} in the decision ledger`,
      `list_decisions; consult it before re-deriving a decision.`,
    ),
    line(`His SCHOOL — ESSEC knowledge`, `essec_knowledge (read/search) before answering anything about his studies; every entry carries its source URL and date.`),
    line(
      `His NOTES — the study workspace (${studiesStat()})`,
      `search_notes / read_note search his actual course files — the workspace is his, not yours: it holds what he wrote, never what you produced.`,
    ),
  ];

  return `# Where your knowledge lives
Each shelf below answers a different question — reach for the shelf by the
QUESTION you are answering, not by remembering tool names. Counts and ages
are live, derived from disk this turn.

${items.join("\n")}

When a question spans shelves, search the shelf that matches the QUESTION
first ("which shop did I name" → transcripts; "what did you conclude about X"
→ reports or decisions; "how do I usually do X" → skills), then the next.
An "empty" shelf is the truth — say so rather than guessing content into it.`;
}

// The study workspace, counted from disk when it's configured. A note on
// cost: this is the one shelf that lives OUTSIDE STATE_ROOT (it's his real
// ~/ESSEC folder), so the count is a shallow walk, bounded and re-read per
// call — cheap enough at course-folder sizes, and honest about "empty" vs
// "not configured" rather than guessing.
function studiesStat(): string {
  let dir: string | undefined;
  try {
    dir = loadConfig().studiesDir || undefined;
  } catch {
    dir = undefined;
  }
  if (!dir) return "not configured";
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."));
    const fileCount = entries.reduce(
      (n, e) => {
        try {
          return n + fs.readdirSync(path.join(dir!, e.name)).filter((f) => /\.(md|txt|csv)$/i.test(f)).length;
        } catch {
          return n;
        }
      },
      0,
    );
    return fileCount === 0 ? "no notes found" : `${fileCount} note files`;
  } catch {
    return "unreadable";
  }
}

function newest(isos: string[]): string {
  const valid = isos.filter((i) => i && !Number.isNaN(Date.parse(i)));
  if (valid.length === 0) return "";
  return valid.reduce((a, b) => (a > b ? a : b));
}
