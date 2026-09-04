// Tier 1 of the Factory: the research subagent, driven by a scripted provider
// — no network, no model, no residue in data/.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import {
  EMIT_TOOL,
  buildResearchPrompt,
  emitSkillsReportTool,
  filterToolsAvailable,
  runResearchLoop,
  type StreamFn,
} from "../src/factory/research.js";
import { SkillsReportSchema } from "../src/factory/types.js";
import { cachedResearch, normalizeQuery, saveResearch } from "../src/factory/store.js";
import { DATA_DIR } from "../src/core/store.js";
import type { ProviderEvent } from "../src/core/provider.js";

const CATALOG = ["web_search", "read_file", "set_reminder"];

const VALID_REPORT = {
  domain: "invoice reconciliation",
  competencies: [
    "match supplier invoices to purchase orders",
    "flag duplicate or out-of-tolerance invoices",
    "summarise open exceptions for a human reviewer",
  ],
  // An invented name and a duplicate: the loop must clean both up.
  tools_available: ["web_search", "erp_magic", "read_file", "web_search"],
  tools_wishlist: [
    { name: "erp_lookup", purpose: "read invoices from the ERP", external_dependency: "SAP OData API" },
  ],
  design_patterns: ["three-way match", "exception queue with human sign-off"],
  sources: [
    { url: "https://example.com/three-way-match", title: "Three-way matching", excerpt: "PO, receipt, invoice." },
    { url: "https://example.com/ap-automation", title: "AP automation patterns" },
  ],
};

// ---------------------------------------------------------------- scripted provider
const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const done = (content: unknown[], stopReason: string): ProviderEvent => ({
  type: "done",
  stopReason,
  assistantContent: content as Anthropic.ContentBlock[],
  usage,
});
const emitCall = (id: string, input: unknown): ProviderEvent[] => [
  { type: "toolUse", id, name: EMIT_TOOL, input },
  done([{ type: "tool_use", id, name: EMIT_TOOL, input }], "tool_use"),
];
type StreamOpts = Parameters<StreamFn>[0];

function scripted(turns: ProviderEvent[][]): { fn: StreamFn; calls: StreamOpts[] } {
  const calls: StreamOpts[] = [];
  const fn: StreamFn = async function* (opts) {
    // The loop keeps appending to the same messages array; snapshot what
    // this request actually saw, the way the wire would.
    calls.push({ ...opts, messages: [...opts.messages] });
    const turn = turns[calls.length - 1];
    if (!turn) throw new Error("scripted provider ran out of turns");
    for (const ev of turn) yield ev;
  };
  return { fn, calls };
}

// ---------------------------------------------------------------- pure helpers
test("buildResearchPrompt names the domain, every catalog tool and the emit tool", () => {
  const p = buildResearchPrompt("invoice reconciliation", CATALOG);
  assert.match(p, /invoice reconciliation/);
  for (const name of CATALOG) assert.ok(p.includes(name), `catalog name ${name} missing`);
  assert.ok(p.includes(EMIT_TOOL));
  assert.match(buildResearchPrompt("x", []), /catalog is empty/);
});

test("filterToolsAvailable drops unknown names, dedupes, keeps order", () => {
  assert.deepEqual(
    filterToolsAvailable(["read_file", "erp_magic", "web_search", "read_file", "web_search"], CATALOG),
    ["read_file", "web_search"],
  );
  assert.deepEqual(filterToolsAvailable(["web_search"], []), []);
  assert.deepEqual(filterToolsAvailable([], CATALOG), []);
});

test("emitSkillsReportTool: schema derived from the zod contract, no $schema key", () => {
  const tool = emitSkillsReportTool() as { name: string; input_schema: Record<string, unknown> };
  assert.equal(tool.name, EMIT_TOOL);
  assert.equal("$schema" in tool.input_schema, false);
  assert.equal(tool.input_schema.type, "object");
  const required = tool.input_schema.required as string[];
  for (const key of ["domain", "competencies", "tools_available", "tools_wishlist", "design_patterns", "sources"]) {
    assert.ok(required.includes(key), `${key} should be required`);
  }
});

test("SkillsReportSchema rejects two competencies and accepts the fixture (excerpt defaults)", () => {
  const bad = SkillsReportSchema.safeParse({ ...VALID_REPORT, competencies: ["one", "two"] });
  assert.equal(bad.success, false);
  const good = SkillsReportSchema.safeParse(VALID_REPORT);
  assert.ok(good.success);
  assert.equal(good.data.sources[1]!.excerpt, "");
  assert.equal(SkillsReportSchema.safeParse({ ...VALID_REPORT, sources: [{ url: "not a url", title: "t" }] }).success, false);
});

// ---------------------------------------------------------------- the loop
test("loop: invalid report gets the zod issues back as a tool_result error, retry succeeds, tools filtered", async () => {
  const { fn, calls } = scripted([
    [
      { type: "serverTool", name: "web_search", query: "" },
      { type: "serverTool", name: "web_fetch", query: "" },
      { type: "serverTool", name: "web_search", query: "" },
      ...emitCall("tu1", { ...VALID_REPORT, competencies: ["only", "two"] }),
    ],
    emitCall("tu2", VALID_REPORT),
  ]);
  const result = await runResearchLoop("invoice reconciliation", CATALOG, 8, fn);

  assert.deepEqual(result.report.tools_available, ["web_search", "read_file"]);
  assert.equal(result.report.domain, "invoice reconciliation");
  assert.equal(result.searches, 2); // web_fetch is not a search
  assert.equal(result.forced, false);
  assert.equal(result.iterations, 2);

  // First request: the fixed research shape, no forcing yet.
  const first = calls[0]!;
  assert.deepEqual(first.web, { maxSearches: 6, fetchPages: true });
  assert.equal(first.effort, "medium");
  assert.equal(first.forceTool, undefined);
  assert.equal((first.tools?.[0] as { name: string }).name, EMIT_TOOL);
  assert.match(String(first.system), /invoice reconciliation/);

  // Second request: assistant tool_use, then ONE user message of tool_results.
  const second = calls[1]!;
  assert.equal(second.messages.length, 3);
  assert.equal(second.messages[1]!.role, "assistant");
  const feedback = second.messages[2]!;
  assert.equal(feedback.role, "user");
  const blocks = feedback.content as Anthropic.ToolResultBlockParam[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, "tool_result");
  assert.equal(blocks[0]!.tool_use_id, "tu1");
  assert.equal(blocks[0]!.is_error, true);
  assert.match(String(blocks[0]!.content), /competencies/);
});

test("loop: a model that only talks is nudged, then forced on the final iteration", async () => {
  const { fn, calls } = scripted([
    [{ type: "text", delta: "Let me think..." }, done([{ type: "text", text: "Let me think..." }], "end_turn")],
    [done([{ type: "text", text: "Still thinking." }], "end_turn")],
    emitCall("tu3", VALID_REPORT),
  ]);
  const result = await runResearchLoop("invoice reconciliation", CATALOG, 3, fn);
  assert.equal(result.forced, true);
  assert.equal(result.iterations, 3);
  assert.equal(calls[0]!.forceTool, undefined);
  assert.equal(calls[1]!.forceTool, undefined);
  assert.equal(calls[2]!.forceTool, EMIT_TOOL);
  // The nudge rides as a plain user message after the assistant's prose.
  const nudge = calls[1]!.messages.at(-1)!;
  assert.equal(nudge.role, "user");
  assert.match(String(nudge.content), new RegExp(EMIT_TOOL));
});

test("loop: pause_turn re-sends the conversation as-is (no extra user message)", async () => {
  const paused = [{ type: "server_tool_use", id: "st1", name: "web_search", input: { query: "q" } }];
  const { fn, calls } = scripted([
    [{ type: "serverTool", name: "web_search", query: "" }, done(paused, "pause_turn")],
    emitCall("tu4", VALID_REPORT),
  ]);
  const result = await runResearchLoop("invoice reconciliation", CATALOG, 8, fn);
  assert.equal(result.iterations, 2);
  assert.equal(calls[1]!.messages.length, 2);
  assert.equal(calls[1]!.messages.at(-1)!.role, "assistant");
});

test("loop: an unknown client tool gets an error result and the loop carries on", async () => {
  const { fn, calls } = scripted([
    [
      { type: "toolUse", id: "x1", name: "not_a_tool", input: {} },
      done([{ type: "tool_use", id: "x1", name: "not_a_tool", input: {} }], "tool_use"),
    ],
    emitCall("tu5", VALID_REPORT),
  ]);
  await runResearchLoop("invoice reconciliation", CATALOG, 8, fn);
  const blocks = calls[1]!.messages.at(-1)!.content as Anthropic.ToolResultBlockParam[];
  assert.equal(blocks[0]!.tool_use_id, "x1");
  assert.equal(blocks[0]!.is_error, true);
});

test("loop: every iteration invalid → the clear error, and never more calls than iterations", async () => {
  const { fn, calls } = scripted([
    emitCall("b1", { domain: "x" }),
    emitCall("b2", { ...VALID_REPORT, competencies: [] }),
  ]);
  await assert.rejects(
    () => runResearchLoop("invoice reconciliation", CATALOG, 2, fn),
    /research produced no valid report/,
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.forceTool, EMIT_TOOL);
});

test("loop: a refusal stops the spend immediately", async () => {
  const { fn, calls } = scripted([[done([], "refusal")], emitCall("never", VALID_REPORT)]);
  await assert.rejects(
    () => runResearchLoop("invoice reconciliation", CATALOG, 8, fn),
    /research produced no valid report/,
  );
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- store round trip
test("store: saveResearch → cachedResearch round trip on the normalized query, leaving no residue", () => {
  const dir = path.join(DATA_DIR, "factory");
  const file = path.join(dir, "research.json");
  const hadDir = fs.existsSync(dir);
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  try {
    const parsed = SkillsReportSchema.parse(VALID_REPORT);
    const query = `  Test-Only/Research Probe — ${Date.now()}!! `;
    const saved = saveResearch(query, parsed, { searches: 3, forced: false });
    assert.equal(saved.query, normalizeQuery(query));
    assert.equal(normalizeQuery("  Invoice/Reconciliation — Agent!! "), "invoice reconciliation agent");

    // Different casing and punctuation, same normalized key → same row.
    const hit = cachedResearch(query.toUpperCase().replace("/", " - "));
    assert.ok(hit);
    assert.equal(hit.id, saved.id);
    assert.equal(hit.searches, 3);
    assert.equal(hit.forced, false);
    assert.deepEqual(hit.report, parsed);
    assert.equal(cachedResearch("nothing like this was ever researched"), null);
  } finally {
    if (before === null) {
      fs.rmSync(file, { force: true });
      if (!hadDir) {
        try {
          fs.rmdirSync(dir); // only if we created it and it is still empty
        } catch {
          /* someone else is using it now — leave it */
        }
      }
    } else {
      fs.writeFileSync(file, before);
    }
  }
});
