// The reports archive — what deep research FOUND must outlive the window.
//
// The failure this file guards against: data/report-window.json is a single
// slot. Every open_report_window call overwrote the previous report, so
// everything deep research ever found was gone by the next run — the
// dermatologist report replaced whatever came before it, and whatever came
// next replaced the dermatologist. Research that costs real money per run
// was the one category of knowledge with NO persistence at all. These tests
// pin:
//
//   1. every opened report lands in memory/reports/ as a markdown file —
//      nothing is overwritten, two reports = two files
//   2. the archive is SEARCHABLE — the exact scenario that was lost: after a
//      newer report on a different topic, the older one still comes back
//   3. read_report returns the full archived report — verdict, picks, sources
//   4. the tools are ungated reads, withheld from Factory agents (same
//      policy as recall_memories and search_conversations), and ride in the
//      SAME reportTools array both registries already spread
//   5. a same-day same-title report gets a suffix, never a clobber
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A directory of our own BEFORE any config-dependent import, so this file
// can also run standalone (npx tsx --test) without touching real state.
// Same pattern as report.test.ts.
process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-reports-archive-"));

const { reportTools } = await import("../src/tools/report.js");
const {
  saveReportArchive,
  listReports,
  searchReports,
  readReport,
  reportsDir,
} = await import("../src/memory/reports.js");
const { STATE_ROOT } = await import("../src/core/config.js");

const openReport = reportTools.find((t) => t.name === "open_report_window")!;
assert.ok(openReport, "open_report_window must exist in reportTools");

// A first report about one topic…
const SKIN = {
  title: "Best dermatologist for surgery in Paris",
  question: "Find me the best dermatologist in surgery, Paris",
  verdict:
    "No single official ranking exists, so the answer is a ranked shortlist judged on register data and hospital affiliation. Dr Exemple leads it.",
  method: "Best = board-certified dermatologist with documented surgical activity, verifiable on the Ordre des médecins register.",
  picks: [
    {
      rank: 1,
      title: "Dr Exemple",
      subtitle: "Dermatologue-chirurgien · Paris 8e",
      why: "Registered dermatologist with declared surgical specialty.",
      evidence: ["Ordre des médecins registration, speciality dermatologie"],
      caveats: "Waiting list length could not be verified.",
      url: "https://exemple.example/booking",
      meta: ["Paris 8e", "FR/EN"],
    },
  ],
  sections: [],
  sources: [{ label: "Ordre des médecins — annuaire", url: "https://www.conseil-national.medecin.fr/" }],
  caveats: "Review platforms were treated as leads, not evidence.",
};

// …and a second one about a completely different topic.
const FLIGHTS = {
  title: "Cheapest Cergy–Naples flights for Christmas",
  question: "When should I book Cergy–Naples flights for Christmas?",
  verdict: "Book by late October: prices climb steeply from mid-November onward.",
  method: "Compared historical price curves across the major carriers and aggregators.",
  picks: [
    {
      rank: 1,
      title: "IT Airways direct CDG–NAP",
      subtitle: "Book 8–10 weeks out",
      why: "Historically the cheapest direct option in the Christmas window.",
      evidence: ["Price curve data from the last three Christmas seasons"],
      caveats: "Past curves are an indication, not a promise.",
      url: "https://exemple.example/flights",
      meta: ["Direct", "CDG–NAP"],
    },
  ],
  sections: [],
  sources: [{ label: "Carrier price pages", url: "https://exemple.example/" }],
  caveats: "No aggregator discount codes were verifiable.",
};

test("opening a report lands a markdown copy in memory/reports/", async () => {
  const ret = await openReport.run(SKIN);
  assert.ok(typeof ret === "string" && ret.length > 0);
  const files = fs.readdirSync(reportsDir()).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 1, "exactly one archived report after one open");
  const raw = fs.readFileSync(path.join(reportsDir(), files[0]!), "utf8");
  assert.match(raw, /Best dermatologist for surgery in Paris/, "the file is human-readable markdown carrying the title");
  assert.match(raw, /Dr Exemple/);
  assert.match(raw, /conseil-national\.medecin\.fr/, "sources are preserved in the archive");
});

test("a second report NEVER overwrites the first — the window is a slot, the archive is not", async () => {
  await openReport.run(FLIGHTS);
  const files = fs.readdirSync(reportsDir()).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 2, "two reports must be two files");
  const all = files.map((f) => fs.readFileSync(path.join(reportsDir(), f), "utf8")).join("\n");
  assert.match(all, /Best dermatologist for surgery in Paris/);
  assert.match(all, /Cheapest Cergy–Naples flights/);
});

test("search_reports finds the OLD report after a newer one on a different topic", () => {
  // This is the exact scenario that was lost: the dermatologist research was
  // the only thing on disk, and would have been gone after the flights run.
  const hits = searchReports("dermatologist surgery Paris");
  assert.ok(hits.length > 0, "the superseded-window report must still be findable");
  assert.match(hits[0]!.report.title, /dermatologist/i);
  const flightHits = searchReports("Naples flights Christmas");
  assert.ok(flightHits.length > 0, "the newer report is findable too");
  assert.match(flightHits[0]!.report.title, /Naples/);
});

test("read_report returns the full archived report — verdict and sources included", () => {
  const hits = searchReports("dermatologist");
  assert.ok(hits.length > 0);
  const full = readReport(hits[0]!.report.name);
  assert.ok(full, "the archived file must be readable by name");
  assert.match(full!, /ranked shortlist judged on register data/);
  assert.match(full!, /conseil-national\.medecin\.fr/);
});

test("listReports is newest-first with the question carried", () => {
  const list = listReports();
  assert.equal(list.length, 2);
  assert.match(list[0]!.title, /Naples/, "newest first — flights was opened last");
  assert.match(list[1]!.title, /dermatologist/i);
  assert.ok(list[0]!.question.length > 0);
});

test("search with nothing in common returns nothing, not everything", () => {
  assert.deepEqual(searchReports("kangaroo helicopter marmalade"), []);
});

test("the archive tools are ungated reads, Factory-withheld, in the shared reportTools array", () => {
  const search = reportTools.find((t) => t.name === "search_reports");
  const read = reportTools.find((t) => t.name === "read_report");
  assert.ok(search, "search_reports must exist");
  assert.ok(read, "read_report must exist");
  assert.equal(search!.needsConfirmation, false, "reading his own archive is not an outward action");
  assert.equal(read!.needsConfirmation, false);
  assert.equal(search!.factoryAllowed, false, "same policy as recall_memories — closed to spawned agents");
  assert.equal(read!.factoryAllowed, false);
});

test("a same-day same-title archive write gets a suffix, never a clobber", () => {
  const first = saveReportArchive({ ...SKIN, openedAt: new Date("2026-09-06T10:00:00Z").toISOString() });
  const second = saveReportArchive({ ...SKIN, openedAt: new Date("2026-09-06T11:00:00Z").toISOString() });
  assert.notEqual(first.name, second.name, "same title same day must not reuse the filename");
  assert.ok(fs.existsSync(path.join(reportsDir(), `${first.name}.md`)));
  assert.ok(fs.existsSync(path.join(reportsDir(), `${second.name}.md`)));
});

test("the archive lives under STATE_ROOT/memory — sandboxed in tests, snapshotted in production", () => {
  assert.ok(
    reportsDir().startsWith(path.join(STATE_ROOT, "memory", "reports")),
    "the archive must live inside the memory tree the hourly backup snapshots",
  );
});
