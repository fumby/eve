// The report window — where finished research LANDS. A report that exists
// only as chat text dies with the scrollback; deep research earns a page.
//
// The pattern is the one /options proved: the model fills a real schema, the
// payload lands in data/report-window.json, the face serves /report and
// /api/report reads it live. Mac: the window opens (a real `open`). Phone:
// the browser there is unreachable from here — the tool return says so and
// hands the model the tappable link, the lesson food.ts learned live
// ("non mi ha aperto nessuna pagina"). Email is an explicit offer, never
// automatic: send_email exists, is gated, and EVE decides to propose it.
import { z } from "zod";
import { STATE_ROOT } from "../core/config.js";
import { readJson, writeJson } from "../core/store.js";
import { audit } from "../core/audit.js";
import { emitUiWindow } from "../core/ui-bus.js";
import type { EveTool } from "../core/registry.js";
import { saveReportArchive, searchReports, listReports, readReport } from "../memory/reports.js";

// The tailnet URL — the phone's door to the face. Same hostname the food
// options window hands out; ONE constant for both, so a tailnet rename
// (or a move to a different serve URL) is a one-line fix, not a hunt.
export const TAILNET_BASE = "https://eve.tail1234.ts.net";

// under a sandboxed EVE_STATE_DIR (tests, check scripts, the exam arena)
// `open` would pop a browser tab on Umberto's screen for a fake report — seen
// live while writing this file's tests. The guard used to be a private copy
// here; it moved to config.ts when src/tools/food.ts turned out never to have
// got one.

// ── the payload ───────────────────────────────────────────────────────────
export interface ReportPick {
  rank: number;
  title: string;
  subtitle: string;
  why: string;
  evidence: string[];
  caveats: string;
  url: string | null;
  meta: string[];
}

export interface ReportSource {
  label: string;
  url: string;
}

export interface ReportWindow {
  openedAt: string;
  title: string;
  question: string;
  verdict: string;
  method: string;
  picks: ReportPick[];
  sections: { heading: string; body: string }[];
  sources: ReportSource[];
  caveats: string;
}

const REPORT_FILE = "report-window.json";

export function loadReportWindow(): ReportWindow | null {
  return readJson<ReportWindow | null>(REPORT_FILE, null);
}

function saveReportWindow(w: ReportWindow): void {
  writeJson(REPORT_FILE, w);
}

// The evidence entries the model may send arrive as a JSON string or an
// array, depending on how the provider coerces the schema. Accept both:
// a rejected evidence list is a silently empty report card, which is worse.
function asEvidence(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch {
      // not JSON — treat the whole string as one evidence line
    }
    return [v.trim()];
  }
  return [];
}

export const reportTools: EveTool[] = [
  {
    name: "open_report_window",
    description:
      "Open the REPORT WINDOW — a dedicated readable page for a finished piece of research, served at /report (Mac and phone). Use it whenever a deep_research run concludes: it takes the verdict, the ranked picks, the evidence for each pick, and the sources, and turns them into a page Umberto can read, keep, and act on. Not for quick facts — those stay in chat. This is how research is DELIVERED, not just done.",
    schema: z.object({
      title: z.string().min(3).max(120).describe("Report title, e.g. 'Best dermatologist for surgery in Paris'."),
      question: z.string().min(8).max(300).describe("The original question, as Umberto asked it."),
      verdict: z.string().min(10).max(1200).describe("The direct answer in 2-4 sentences — what he should take away."),
      method: z.string().min(10).max(1500).describe("How 'best' was defined and judged — criteria fixed before ranking, sources used."),
      picks: z
        .array(
          z.object({
            rank: z.number().int().min(1).max(20),
            title: z.string().min(2).max(120),
            subtitle: z.string().max(200),
            why: z.string().max(400).describe("Why it ranks here — its strengths against the criteria."),
            evidence: z.array(z.string().max(300)).max(10).default([]).describe("Verifiable facts supporting this pick, each with a source in sources[]."),
            caveats: z.string().max(400).default("").describe("What is uncertain or unverified about this pick."),
            url: z.string().url().nullable().optional().describe("A real link — booking page, register entry, practice page. Null if none."),
            meta: z.array(z.string().max(40)).max(8).default([]).describe("Short facts: arrondissement, languages, booking platform."),
          }),
        )
        .min(1)
        .max(10),
      sections: z
        .array(
          z.object({
            heading: z.string().min(2).max(120),
            body: z.string().min(1).max(3000),
          }),
        )
        .max(8)
        .default([]),
      sources: z
        .array(
          z.object({
            label: z.string().min(2).max(120),
            url: z.string().url(),
          }),
        )
        .min(1)
        .max(30),
      caveats: z.string().max(1000).default("").describe("What this report could NOT establish — stated, not hidden."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const sources: ReportSource[] = (input.sources as Array<Record<string, unknown>>).map((s) => ({
        label: String(s.label),
        url: String(s.url),
      }));
      const picks: ReportPick[] = (input.picks as Array<Record<string, unknown>>).map((p) => ({
        rank: Number(p.rank),
        title: String(p.title),
        subtitle: String(p.subtitle ?? ""),
        why: String(p.why ?? ""),
        evidence: asEvidence(p.evidence),
        caveats: String(p.caveats ?? ""),
        url: p.url ? String(p.url) : null,
        meta: Array.isArray(p.meta) ? (p.meta as string[]).map(String) : [],
      }));
      const w: ReportWindow = {
        openedAt: new Date().toISOString(),
        title: String(input.title),
        question: String(input.question),
        verdict: String(input.verdict),
        method: String(input.method),
        picks,
        sections: Array.isArray(input.sections)
          ? (input.sections as Array<{ heading: string; body: string }>).map((s) => ({
              heading: String(s.heading),
              body: String(s.body),
            }))
          : [],
        sources,
        caveats: String(input.caveats ?? ""),
      };
      saveReportWindow(w);
      // The window is a single slot; the ARCHIVE is forever. Every report
      // deep research produces lands in memory/reports/ (human-readable
      // markdown, hourly-snapshotted) — before this, each new report
      // overwrote the last and everything she had ever found was gone.
      const archived = saveReportArchive(w);
      audit("report_window_opened", { title: w.title, picks: picks.length, sources: sources.length, archivedAs: archived.name });
      // ONE delivery path, decided by the SERVER: emit the UI-window event
      // and let the face server deliver it exactly once (a Mac `open` for a
      // Mac turn, `open_url` navigation for the phone). The old "open here +
      // event" double-fired on the Mac: a browser tab AND the face's own
      // window navigating to /report, which inside EVE.app has no way back.
      emitUiWindow({ path: "/report", kind: "report_window" });
      return (
        `The report window "${w.title}" is live with ${picks.length} ranked picks and ${sources.length} sources — it just opened in his browser on the Mac. ` +
        `On the PHONE you cannot open a page for him: TELL HIM the link in your reply, in his language, like ` +
        `"te l'ho aperta sul Mac — sul telefono aprila qui: ${TAILNET_BASE}/report" — one clear line, the full URL. ` +
        `Offer to also email him the report (send_email) if he says he wants it in his inbox. Then summarise the verdict and the top pick aloud. ` +
        `(Archived as ${archived.name} — searchable forever with search_reports.)`
      );
    },
  },
  {
    name: "search_reports",
    description:
      "Search the ARCHIVE of past deep-research reports — everything you ever found for Umberto, kept with sources and caveats. Use it when a question touches something you already researched ('which dermatologist did we find', 'what did you conclude about flights'), BEFORE running a new deep_research (which costs money and repeats work). Returns matching reports with dates; read_report opens one in full.",
    schema: z.object({
      query: z.string().min(2).describe("Words that would appear in the report — the topic, a pick's name, a place"),
      limit: z.number().int().min(1).max(10).optional().describe("How many reports back (default 5)"),
    }),
    needsConfirmation: false,
    // Same policy as recall_memories and search_conversations: reading his own
    // archive is not an outward action, but a research specialist spawned by
    // the Factory has no business holding Umberto's history in context.
    factoryAllowed: false,
    run: async (input) => {
      const hits = searchReports(String(input.query), typeof input.limit === "number" ? input.limit : 5);
      if (hits.length === 0) {
        return (
          `No archived report matches "${input.query}". This means no past deep_research covered it ` +
          `(the archive starts 6 September 2026) — not that the answer doesn't exist. ` +
          `If it matters, a fresh deep_research is the way; if it's quick, perplexity_search may be enough.`
        );
      }
      return hits
        .map(
          (h) =>
            `[${h.report.name}] ${h.report.title} (${h.report.openedAt.slice(0, 10)}, ` +
            `${h.report.picks} picks, ${h.report.sources} sources)\n` +
            `Question: ${h.report.question}`,
        )
        .join("\n\n") + "\n\nread_report <name> opens one in full.";
    },
  },
  {
    name: "read_report",
    description:
      "Read one archived research report in full — verdict, method, ranked picks with evidence, sources, caveats. Takes the name from search_reports. For the NEWEST report only, the /report window is nicer; this is for everything else.",
    schema: z.object({ name: z.string().min(1).describe("The report name from a search_reports result") }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const full = readReport(String(input.name));
      if (!full) {
        const names = listReports().slice(0, 10).map((r) => r.name).join(", ");
        return `No archived report named "${input.name}". Available: ${names || "(archive empty)"}.`;
      }
      return full;
    },
  },
];
