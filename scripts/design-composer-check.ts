import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// LIVE check of the design composer — spawns real Claude Code twice through
// the Agent SDK with the real ANTHROPIC_API_KEY (costs a few cents). Not part
// of `npm test`. Two questions, answered ✅/❌ with the actual values:
//
//   1. does a sanitized, isolated query() actually do work? (writes hello.txt
//      in a scratch cwd; prints cost / turns / subtype and the event log)
//   2. does aborting mid-run leave NO orphaned processes? (Bash `sleep 40`,
//      abort after 6 s, then prove no node/npm/claude/sleep survivor is left
//      under this process)
//
//   npx tsx scripts/design-composer-check.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, loadEnv, requireKey } from "../src/core/config.js";
import {
  COMPOSER_ALLOWED_TOOLS,
  listDescendants,
  runComposer,
} from "../src/design/composer.js";
import type { DesignEvent } from "../src/design/types.js";

loadEnv();

let failures = 0;
function pass(msg: string): void {
  console.log(`✅ ${msg}`);
}
function fail(msg: string): void {
  failures++;
  console.error(`❌ ${msg}`);
}
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function printEvents(events: DesignEvent[]): void {
  for (const e of events) console.log(`   [${e.at.slice(11, 19)}] ${e.kind.padEnd(9)} ${e.text}`);
}

function scratchDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `eve-composer-${label}-`));
}

async function main(): Promise<void> {
  requireKey("ANTHROPIC_API_KEY");
  const model = loadConfig().design.composerModel;
  console.log(`model: ${model}`);

  // 1. Happy path ───────────────────────────────────────────────────────────
  {
    const cwd = scratchDir("hello");
    const events: DesignEvent[] = [];
    console.log(`\n— check 1: write hello.txt in ${cwd}`);
    try {
      const res = await runComposer({
        dispatchId: `check-hello-${Date.now()}`,
        projectRoot: cwd,
        prompt: "Create a file named hello.txt containing exactly: hello from claude code. Then stop.",
        model,
        maxTurns: 4,
        maxBudgetUsd: 0.25,
        onEvent: (e) => events.push(e),
      });
      printEvents(events);
      console.log(`   result: subtype=${res.subtype} ok=${res.ok} cost=$${res.costUsd.toFixed(4)} turns=${res.turns} durationMs=${res.durationMs}`);
      console.log(`   options log: ${res.optionsLogPath}`);
      if (res.errors.length) console.log(`   errors: ${res.errors.join(" | ")}`);
      if (res.permissionDenials.length) console.log(`   denials: ${JSON.stringify(res.permissionDenials)}`);

      const helloPath = path.join(cwd, "hello.txt");
      if (!fs.existsSync(helloPath)) fail(`hello.txt was not created (subtype=${res.subtype}, errors=${res.errors.join(" | ") || "none"})`);
      else {
        const text = fs.readFileSync(helloPath, "utf8");
        if (/hello from claude code/i.test(text)) pass(`hello.txt written: ${JSON.stringify(text.trim())}`);
        else fail(`hello.txt has unexpected content: ${JSON.stringify(text)}`);
      }
      if (res.ok) pass(`run finished: ${res.subtype} · $${res.costUsd.toFixed(4)} · ${res.turns} turns`);
      else fail(`run did not succeed: ${res.subtype} — ${res.errors.join(" | ") || "no error text"}`);
      if (fs.existsSync(res.optionsLogPath)) {
        const logged = JSON.parse(fs.readFileSync(res.optionsLogPath, "utf8")) as { options: { env?: Record<string, string>; settingSources?: unknown } };
        const env = logged.options.env ?? {};
        if (env.ANTHROPIC_API_KEY === "<redacted>" && !("DEEPGRAM_API_KEY" in env)) pass("options log: key redacted, env allowlisted");
        else fail(`options log env looks wrong: ${JSON.stringify(env)}`);
      } else fail(`options log missing at ${res.optionsLogPath}`);
      if (events.some((e) => e.kind === "info" && /Claude Code/.test(e.text))) pass("init event received");
      else fail("no init event — Claude Code never reported in");
    } catch (e) {
      fail(`check 1 threw: ${errText(e)}`);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  // 2. Abort + orphan sweep ────────────────────────────────────────────────
  {
    const cwd = scratchDir("abort");
    const events: DesignEvent[] = [];
    const ac = new AbortController();
    console.log(`\n— check 2: abort a Bash sleep 40 after 6 s, in ${cwd}`);
    const timer = setTimeout(() => {
      console.log("   → aborting now");
      ac.abort();
    }, 6000);
    try {
      const t0 = Date.now();
      const res = await runComposer(
        {
          dispatchId: `check-abort-${Date.now()}`,
          projectRoot: cwd,
          prompt: "Run the bash command: sleep 40. Then write done.txt containing the word done.",
          model,
          maxTurns: 4,
          maxBudgetUsd: 0.25,
          onEvent: (e) => events.push(e),
          signal: ac.signal,
        },
        // test-only widening so Claude Code can actually run `sleep`
        { allowedToolsOverride: [...COMPOSER_ALLOWED_TOOLS, "Bash(sleep:*)"] },
      );
      const took = Date.now() - t0;
      printEvents(events);
      console.log(`   result: subtype=${res.subtype} ok=${res.ok} cost=$${res.costUsd.toFixed(4)} turns=${res.turns} durationMs=${res.durationMs} (wall ${took} ms)`);
      if (res.errors.length) console.log(`   errors: ${res.errors.join(" | ")}`);

      if (res.subtype === "aborted") pass(`abort reported as subtype "aborted" after ${took} ms`);
      else fail(`expected subtype "aborted", got ${res.subtype} (did the sleep tool call happen? events: ${events.map((e) => e.kind).join(",")})`);
      if (took < 30_000) pass("returned well before the sleep would have finished");
      else fail(`took ${took} ms — the abort did not cut the run short`);
      if (fs.existsSync(path.join(cwd, "done.txt"))) fail("done.txt exists — the run continued past the abort");
      else pass("done.txt was never written");

      // give the OS a beat to reap, then look for survivors under us
      await new Promise((r) => setTimeout(r, 500));
      const survivors = (await listDescendants(process.pid)).filter((p) => /(^|\/)(node|npm|npx|claude|sleep|sh)\b/.test(p.command) && !/esbuild/.test(p.command));
      if (survivors.length === 0) pass("no node/npm/claude/sleep survivors under this process");
      else fail(`orphans left behind: ${survivors.map((p) => `${p.pid} ${p.command.slice(0, 80)}`).join(" ; ")}`);
    } catch (e) {
      fail(`check 2 threw: ${errText(e)}`);
    } finally {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }

  console.log("");
  if (failures) {
    console.error(`❌ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("✅ composer check passed");
}

main().catch((e) => {
  fail(errText(e));
  process.exit(1);
});
