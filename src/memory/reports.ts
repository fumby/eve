// The reports archive: every research report deep_research produces, kept.
//
// The window at data/report-window.json is a SINGLE SLOT — it exists so
// /report always shows the newest report, and that is all it can ever show.
// Before this module, that slot was also the only copy: every
// open_report_window call overwrote the previous report, so everything deep
// research ever found was gone by the next run. Research that costs real
// money per run was the one category of knowledge with no persistence.
//
// The archive lives in memory/reports/ — one human-readable markdown file
// per report, the same "files are the memory" doctrine as memory/store/.
// It sits inside the memory tree the hourly backup (scripts/backup-memory.sh)
// snapshots, so a report is never one disk hiccup from extinction. Every
// index built here is derived and disposable.
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "../core/config.js";
import { writeFileAtomic } from "../core/atomic.js";
import type { ReportWindow } from "../tools/report.js";

const REPORTS_DIR = path.join(STATE_ROOT, "memory", "reports");

export interface ReportMeta {
  name: string; // filename slug — read_report takes this
  title: string;
  question: string;
  openedAt: string; // ISO — the sort key, newest first
  picks: number;
  sources: number;
}

export function reportsDir(): string {
  return REPORTS_DIR;
}

// Front-matter parsing tolerant of hand edits, same doctrine as the memory
// store: a malformed file is skipped, never a crash. The body is the report
// itself, rendered markdown — the same bytes /report shows, minus nothing.
function parseReportFile(file: string): (ReportMeta & { body: string }) | null {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(REPORTS_DIR, file), "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  if (!meta.title || !meta.openedAt) return null;
  return {
    name: meta.name ?? file.replace(/\.md$/, ""),
    title: meta.title,
    question: meta.question ?? "",
    openedAt: meta.openedAt,
    picks: Number(meta.picks ?? 0) || 0,
    sources: Number(meta.sources ?? 0) || 0,
    body: m[2]!.trim(),
  };
}

// The bytes of an archived report, in one place.
function renderReportFile(r: ReportWindow, name: string): string {
  const meta = [
    `name: ${name}`,
    `title: ${r.title}`,
    `question: ${r.question}`,
    `openedAt: ${r.openedAt}`,
    `picks: ${r.picks.length}`,
    `sources: ${r.sources.length}`,
  ];
  const picks = r.picks
    .map(
      (p) =>
        `### ${p.rank}. ${p.title}${p.subtitle ? ` — ${p.subtitle}` : ""}\n` +
        (p.why ? `${p.why}\n` : "") +
        (p.evidence.length > 0 ? `${p.evidence.map((e) => `- ${e}`).join("\n")}\n` : "") +
        (p.caveats ? `**Caveats:** ${p.caveats}\n` : "") +
        (p.url ? `Link: ${p.url}\n` : "") +
        (p.meta.length > 0 ? `${p.meta.join(" · ")}\n` : ""),
    )
    .join("\n");
  const sections = r.sections.map((s) => `## ${s.heading}\n\n${s.body}`).join("\n\n");
  const sources = r.sources.map((s) => `- [${s.label}](${s.url})`).join("\n");
  return [
    `---\n${meta.join("\n")}\n---\n`,
    `# ${r.title}\n`,
    `**Question:** ${r.question}\n`,
    `**Verdict:** ${r.verdict}\n`,
    `## Method\n${r.method}\n`,
    picks ? `## Ranked picks\n${picks}` : "",
    sections,
    sources ? `## Sources\n${sources}` : "",
    r.caveats ? `## Caveats\n${r.caveats}` : "",
    `*Archived ${r.openedAt}.*\n`,
  ]
    .filter(Boolean)
    .join("\n");
}

function slugifyTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "report"
  );
}

// Writes one report to the archive. Two reports on the same topic the same
// day are two files (-2 suffix), never a clobber — the window is a slot, the
// archive is not. Returns the name read_report accepts.
export function saveReportArchive(r: ReportWindow): ReportMeta {
  const day = r.openedAt.slice(0, 10);
  let name = `${day}-${slugifyTitle(r.title)}`;
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(REPORTS_DIR, `${candidate}.md`)) && i < 100; i++) {
    candidate = `${name}-${i}`;
  }
  name = candidate;
  writeFileAtomic(path.join(REPORTS_DIR, `${name}.md`), renderReportFile(r, name));
  return { name, title: r.title, question: r.question, openedAt: r.openedAt, picks: r.picks.length, sources: r.sources.length };
}

export function listReports(): ReportMeta[] {
  let files: string[];
  try {
    files = fs.readdirSync(REPORTS_DIR);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(".md"))
    .map(parseReportFile)
    .filter((x): x is ReportMeta & { body: string } => x !== null)
    .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
    .map(({ body, ...meta }) => {
      void body;
      return meta;
    });
}

// Full archived report by name — the read_report tool's back end.
export function readReport(name: string): string | null {
  const f = path.join(REPORTS_DIR, `${name}.md`);
  if (!fs.existsSync(f)) return null;
  return fs.readFileSync(f, "utf8");
}

// ── search ─────────────────────────────────────────────────────────────────
// Same doctrine as searchConversations: reports are found by keyword, not
// embeddings — the thing being looked for ("which dermatologist did you find")
// is a token match, and the store is bounded (one file per finished report).
// Index-front-matter + body, single pass, no index file to keep honest.

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export interface ReportHit {
  report: ReportMeta;
  score: number;
}

export function searchReports(query: string, limit = 5): ReportHit[] {
  const terms = [...new Set(normalize(query).split(" ").filter((t) => t.length >= 2))];
  if (terms.length === 0) return [];
  let files: string[];
  try {
    files = fs.readdirSync(REPORTS_DIR);
  } catch {
    return [];
  }
  const hits: ReportHit[] = [];
  for (const f of files.filter((x) => x.endsWith(".md"))) {
    const parsed = parseReportFile(f);
    if (!parsed) continue;
    const norm = normalize(`${parsed.title}\n${parsed.question}\n${parsed.body}`);
    const matched = terms.filter((t) => norm.includes(t));
    if (matched.length === 0) continue;
    const coverage = matched.length / terms.length;
    if (coverage < 0.5 && terms.length > 1) continue; // same floor as conversations
    hits.push({
      report: { name: parsed.name, title: parsed.title, question: parsed.question, openedAt: parsed.openedAt, picks: parsed.picks, sources: parsed.sources },
      score: coverage,
    });
  }
  return hits.sort((a, b) => b.score - a.score || b.report.openedAt.localeCompare(a.report.openedAt)).slice(0, Math.max(1, limit));
}
