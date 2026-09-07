// The report window — how a finished piece of research REACHES Umberto.
//
// The failure this file guards against is the one the food options window
// already documented: a tool that claims a surface it cannot reach. A report
// that exists only as chat text is lost the moment the conversation scrolls;
// the /report window is where deep research lands so he can actually read it
// — on the Mac (opened), on the phone (link he taps). These tests pin:
//
//   1. the tool is NOT gated — showing Umberto his own report is not an
//      outward action; the gate is for things that reach OTHER people,
//      and an over-gated report means EVE stops to ask permission to show
//      him something he asked for.
//   2. the payload round-trips through data/report-window.json — the file
//      /api/report reads live. A schema drift between tool and page is a
//      silently blank report, which is worse than no report.
//   3. a report with neither picks nor sections is refused at the schema —
//      an empty window is a bug the model can't see from the tool's return.
//   4. the return text tells the truth about surfaces: Mac = opened, phone =
//      give the /report link yourself. (food.ts learned this live.)
//   5. the deep-research prompt actually carries the "find the best X"
//      method, and its delivery hint names open_report_window — the model
//      only delivers reports it's told to deliver.
//   6. the wiring exists in BOTH registries and the face serves the page —
//      the review caught a tool registered in the terminal but not the face;
//      these file-level assertions are the cheap guard that it stays true.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// This suite writes state (the report payload) — a directory of its own,
// before config.js snapshots the env. Same pattern as notes.test.ts.
process.env.EVE_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "eve-report-state-"));
const { readJson } = await import("../src/core/store.js");
const { reportTools, loadReportWindow } = await import("../src/tools/report.js");
import type { ReportWindow } from "../src/tools/report.js";
const { RESEARCH_PROMPT, DELIVERY_HINT } = await import("../src/tools/research.js");
const { capabilitiesSection } = await import("../src/brain/capabilities.js");

const openReport = reportTools.find((t) => t.name === "open_report_window");
assert.ok(openReport, "open_report_window must exist in reportTools");

// A well-formed payload the page can render — the same shape the model is
// asked to produce after deep_research.
const SAMPLE = {
  title: "Best dermatologist for surgery in Paris",
  question: "Find the best dermatologist for surgery in Paris",
  verdict:
    "No single official ranking exists, so the answer is a ranked shortlist judged on register data, hospital affiliation and documented surgical practice. Dr Exemple leads it.",
  method:
    "Best = board-certified in dermatology with documented surgical activity, hospital/clinic affiliation, verifiable on the Ordre des médecins register, reachable from Paris.",
  picks: [
    {
      rank: 1,
      title: "Dr Exemple",
      subtitle: "Dermatologue-chirurgien · Clinique Saint-Exemple, Paris 8e",
      why: "Registered dermatologist with declared surgical specialty, attached to a surgical clinic, published on skin-cancer excision.",
      evidence: [
        "Ordre des médecins registration RPPS-checkable, speciality dermatologie",
        "Operates at Clinique Saint-Exemple (skin cancer, Mohs)",
      ],
      caveats: "Waiting list length could not be verified — call to ask.",
      url: "https://exemple.example/booking",
      meta: ["Paris 8e", "Books via Doctolib", "FR/EN"],
    },
  ],
  sections: [
    { heading: "How this was judged", body: "Criteria were fixed before ranking, then each finalist was checked against the register and their own practice page." },
  ],
  sources: [{ label: "Ordre des médecins — annuaire", url: "https://www.conseil-national.medecin.fr/" }],
  caveats: "French review platforms were treated as leads, not evidence.",
};

test("open_report_window is not gated — showing Umberto his own report is not an outward action", () => {
  assert.equal(openReport?.needsConfirmation, false);
  assert.equal(openReport?.factoryAllowed, false);
});

test("a full report round-trips through data/report-window.json", async () => {
  const ret = await openReport!.run(SAMPLE);
  assert.ok(typeof ret === "string" && ret.length > 0, "tool must return text");
  const saved = readJson<ReportWindow | null>("report-window.json", null);
  assert.ok(saved, "payload must be on disk where /api/report reads it");
  assert.equal(saved!.title, SAMPLE.title);
  assert.equal(saved!.question, SAMPLE.question);
  assert.equal(saved!.picks.length, 1);
  assert.equal(saved!.picks[0]?.title, "Dr Exemple");
  assert.equal(saved!.picks[0]?.evidence.length, 2);
  assert.equal(saved!.sources[0]?.url, "https://www.conseil-national.medecin.fr/");
  assert.equal(saved!.caveats, SAMPLE.caveats);
  // loadReportWindow sees the same thing the server will serve.
  const live = loadReportWindow();
  assert.equal(live?.title, SAMPLE.title);
});

test("a report with neither picks nor sections is refused at the schema", () => {
  const parsed = openReport!.schema.safeParse({ ...SAMPLE, picks: [], sections: [] });
  assert.equal(parsed.success, false, "empty report must not open a blank window");
});

test("the return text tells the truth about surfaces — Mac opened, phone gets the link", async () => {
  const ret = await openReport!.run(SAMPLE);
  assert.match(ret, /\/report/);
  assert.match(ret, /ts\.net\/report/);
  assert.match(ret, /Mac/i);
  assert.match(ret, /tell him|give him|say/i, "the model must be told to SAY the link, not assume the phone opened");
});

test("deep research carries the best-of method — criteria, independence, verification, gaps", () => {
  assert.match(RESEARCH_PROMPT, /best X/);
  assert.match(RESEARCH_PROMPT, /criteria/i);
  assert.match(RESEARCH_PROMPT, /independent/i);
  assert.match(RESEARCH_PROMPT, /official register|primary source/i);
  assert.match(RESEARCH_PROMPT, /conflict of interest|marketing|SEO/i);
  assert.match(RESEARCH_PROMPT, /could not establish|remains uncertain/i);
});

test("deep research's delivery hint names open_report_window and the email offer", () => {
  assert.match(DELIVERY_HINT, /open_report_window/);
  assert.match(DELIVERY_HINT, /email/i);
});

test("wired in BOTH registries and served by the face", () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const cli = fs.readFileSync(path.join(root, "src/cli.ts"), "utf8");
  const server = fs.readFileSync(path.join(root, "src/face/server.ts"), "utf8");
  assert.match(cli, /reportTools/, "cli.ts must register the report tools");
  assert.match(server, /reportTools/, "face server must register the report tools");
  assert.match(server, /\/report/, "the face must serve the /report page");
  assert.match(server, /\/api\/report/, "the face must serve /api/report");
  assert.ok(fs.existsSync(path.join(root, "face/report.html")), "the report page must exist");
});

test("capabilities tell EVE to deliver research this way", () => {
  const block = capabilitiesSection([]);
  assert.match(block, /open_report_window/);
  assert.match(block, /\/report/);
  assert.match(block, /deep_research/);
});
