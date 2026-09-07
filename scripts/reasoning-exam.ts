// EVE's REASONING exam — measures how she THINKS, not what she remembers.
// Fresh agent per section (pure reasoning, no conversation contamination),
// minimal or no tools unless the section tests tool judgment.
// Grading is mechanical wherever the answer is checkable; rubric-based where
// it is judgment. Run: npx tsx reasoning-exam.ts (sandboxed state, real brain).
import "./sandbox.js";
import fs from "node:fs";
import path from "node:path";
import { loadEnv, STATE_ROOT } from "../src/core/config.js";
import { Agent } from "../src/core/agent.js";
import { Registry } from "../src/core/registry.js";
import { delegateTools } from "../src/tools/delegate.js";

loadEnv();

interface Section {
  id: string;
  title: string;
  prompt: string;
  tools: "none" | "delegate";
  grade: (reply: string) => { pass: boolean; score: string; note: string };
}

// ── helpers ────────────────────────────────────────────────────────────────
const has = (s: string, ...n: string[]) => n.some((x) => s.toLowerCase().includes(x));
const num = (s: string): number[] => [...s.matchAll(/[\d][\d.,]*/g)].map((m) => parseFloat(m[0]!.replace(/,/g, "")));

async function ask(prompt: string, tools: "none" | "delegate"): Promise<string> {
  const registry = new Registry();
  if (tools === "delegate") for (const t of delegateTools) registry.register(t);
  // "none" → Tier 1 brain: no tools, pure reasoning. A registry with zero
  // tools still validates the tool loop; the model simply has nothing to call.
  const agent = new Agent(tools === "delegate" ? registry : undefined, "typed");
  return await agent.runTurn(prompt);
}

// ── the eight sections ────────────────────────────────────────────────────
const sections: Section[] = [
  {
    id: "R1",
    title: "multi-step arithmetic (business)",
    prompt:
      "Quick business math, answer with the number and one line of how you got it. " +
      "My gross margin is 34% of revenue. Payment fees are 8% of revenue. Rent is 2200 €/month, " +
      "other fixed costs 900 €/month. What monthly revenue do I need for 5000 € of profit?",
    tools: "none",
    grade: (r) => {
      // 0.34r - 0.08r - 3100 = 5000 → r = 8100 / 0.26 ≈ 31,153.85
      const target = 31153.85;
      const nums = num(r).filter((n) => n > 10000 && n < 100000);
      const ok = nums.some((n) => Math.abs(n - target) < 300);
      return { pass: ok, score: ok ? "correct (≈31.2k €)" : "wrong number", note: `numbers seen: ${nums.join(", ") || "none"}` };
    },
  },
  {
    id: "R2",
    title: "logic consistency",
    prompt:
      "Pure logic puzzle. Island of knights (always truthful) and knaves (always lying). " +
      "A says: 'B and I are both knaves.' B says: 'A is a knight.' " +
      "Is there any consistent assignment of knight/knave to A and B? Explain briefly.",
    tools: "none",
    grade: (r) => {
      // No consistent world: A knave → statement false → at least one knight → B knight,
      // but B's claim 'A is a knight' is then false → contradiction.
      const saysImpossible =
        has(r, "no consistent", "not consistent", "impossible", "contradiction", "cannot", "can't", "no assignment", "no valid", "nessuna") ||
        /\bno\b.*\bworld\b/i.test(r);
      const sawContradiction = has(r, "contradict");
      const pass = saysImpossible || sawContradiction;
      return { pass, score: pass ? "spotted the contradiction" : "missed it", note: r.slice(0, 140) };
    },
  },
  {
    id: "R3",
    title: "constraint chain (planning)",
    prompt:
      "Travel planning, be precise. Train Cergy→Lyon leaves 08:12 and arrives 10:04. I must be at the " +
      "station 25 minutes before departure. My alarm-to-out-the-door routine takes 35 minutes. " +
      "I want to start getting ready as late as possible. What time do I set the alarm for?",
    tools: "none",
    grade: (r) => {
      // 08:12 − 25 = 07:47 at station − 35 = 07:12 alarm.
      const ok = /7[:.]12/.test(r) || /07[:.]12/.test(r) || has(r, "7:12", "07:12", "7.12");
      return { pass: ok, score: ok ? "07:12 exactly" : "off", note: r.slice(0, 120) };
    },
  },
  {
    id: "R4",
    title: "Fermi estimation",
    prompt:
      "Estimate the monthly revenue of a busy café in Cergy. Show your reasoning with numbers, " +
      "then give one final figure. Don't look anything up — estimate.",
    tools: "none",
    grade: (r) => {
      // Plausible band: 15k–120k €/month. Reasoning must have visible components.
      const figures = num(r).filter((n) => n >= 15000 && n <= 120000);
      const components = num(r).filter((n) => n > 20 && n < 15000).length >= 2;
      const ok = figures.length > 0 && components;
      return { pass: ok, score: figures.length ? `${figures[0]} €` : "no figure", note: components ? "component math visible" : "no component math" };
    },
  },
  {
    id: "R5",
    title: "business trade-off (his real world)",
    prompt:
      "Real decision, advise me. I can take a paid internship (1400 €/month gross, 20h/week, Paris) " +
      "or go all-in on my venture: current burn 800 €/month, revenue 300 €/month, savings 6000 €. " +
      "What would you advise, and why? One short paragraph.",
    tools: "none",
    grade: (r) => {
      const runway = has(r, "12 month", "12 mesi", "12-month", "un anno", "a year"); // 6000/(800-300) = 12
      const recommends = has(r, "i'd advise", "i would", "my advice", "consiglio", "i'd take", "i'd go", "ti consigli");
      const conditions = has(r, "if ", "unless", "condition", "milestone", "pivot", "review", "se ");
      const pass = runway && recommends && conditions;
      return {
        pass,
        score: `${runway ? "runway computed" : "no runway math"} + ${recommends ? "clear advice" : "no advice"} + ${conditions ? "conditions" : "no conditions"}`,
        note: r.slice(0, 140),
      };
    },
  },
  {
    id: "R6",
    title: "calibration (do you know what you know?)",
    prompt:
      "Five quick questions. After each answer, give your confidence as a percentage. " +
      "1) Capital of Australia? 2) Square root of 1024? 3) How many hearts does an octopus have? " +
      "4) In what year did euro cash enter circulation? 5) Which planet is closest to the Sun? " +
      "Format: answer (confidence%).",
    tools: "none",
    grade: (r) => {
      const answers = [
        /canberra/i,
        /\b32\b/,
        /\b3\b|\bthree\b|\btre\b/i,
        /\b2002\b/,
        /mercury|mercurio/i,
      ];
      const right = answers.filter((re) => re.test(r)).length;
      const confs = [...r.matchAll(/\((\d{1,3})\s*%\)/g)].map((m) => parseInt(m[1]!, 10));
      const avgConf = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0;
      // Well-calibrated on 5 easy-ish questions: right answers deserve high conf.
      const pass = right >= 4 && confs.length >= 4;
      return { pass, score: `${right}/5 correct, avg conf ${avgConf.toFixed(0)}%`, note: confs.length ? `confidence format ok (${confs.length})` : "no confidence given" };
    },
  },
  {
    id: "R7",
    title: "delegation judgment (who & why)",
    prompt:
      "Three tasks — for each, tell me in one line: you, or which AI, and why. Reason out loud, " +
      "don't run anything. (1) Tomorrow's weather in Cergy. (2) A cited comparison of French banks' " +
      "student-entrepreneur accounts, current as of today. (3) A bug fixed in my youtube-analysis project.",
    tools: "delegate",
    grade: (r) => {
      const low = r.toLowerCase();
      const w1 = /(weather|meteo)/.test(low) && /(myself|me|i('| a)?ll|i can|i look|get_weather|io)/.test(low);
      const w2 = /hermes/.test(low) && /(research|brows|source|citat|multi-step|web)/.test(low);
      const w3 = /claude[- ]code/.test(low) && /(code|project|file|fix|run)/.test(low);
      const pass = w1 && w2 && w3;
      return { pass, score: `weather:${w1 ? "self" : "?"} banks:${w2 ? "hermes" : "?"} bug:${w3 ? "claude-code" : "?"}`, note: r.slice(0, 160) };
    },
  },
  {
    id: "R8",
    title: "critique a flawed argument (monitoring)",
    prompt:
      "Quick sanity check on this analysis from a friend's pitch — is the math sound? " +
      "\"Our app has 10,000 downloads and 8% weekly retention, so after a year we'll have " +
      "41,600 active users (10,000 × 8% × 52).\" One short paragraph.",
    tools: "none",
    grade: (r) => {
      const low = r.toLowerCase();
      const seesAdditive = has(r, "add", "sum", "linear") || /week(ly)? (retention|rate)/i.test(low);
      const seesCompound =
        has(r, "compound", "exponential", "decays", "decay", "0.08^", "power", "multiply the retention") ||
        /\b(zero|0)\b.*\buser/i.test(low) ||
        has(r, "almost no", "nobody", "essentially 0", "≈ 0");
      const pass = seesCompound || (seesAdditive && /wrong|flaw|error|mistake|not sound|sbagliat/i.test(low));
      return {
        pass,
        score: seesCompound ? "spotted compounding error" : seesAdditive ? "spotted additive error" : "missed the flaw",
        note: r.slice(0, 140),
      };
    },
  },
];

// ── run ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const results: Record<string, { title: string; pass: boolean; score: string; note: string; reply: string; seconds: number }> = {};
  let allPass = true;
  for (const s of sections) {
    const t0 = Date.now();
    let reply = "";
    try {
      reply = await ask(s.prompt, s.tools);
    } catch (err) {
      reply = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
    const seconds = Math.round((Date.now() - t0) / 100) / 10;
    const g = s.grade(reply);
    allPass = allPass && g.pass;
    results[s.id] = { title: s.title, ...g, reply, seconds };
    console.log(`${g.pass ? "PASS" : "FAIL"}  ${s.id} ${s.title} — ${g.score}  [${seconds}s]`);
    console.log(`      ${reply.replace(/\n+/g, " ").slice(0, 200)}\n`);
  }
  fs.writeFileSync(
    path.join(STATE_ROOT, "reasoning-report.json"),
    JSON.stringify({ when: new Date().toISOString(), results }, null, 2) + "\n",
  );
  const passed = Object.values(results).filter((r) => r.pass).length;
  console.log(`\n${passed}/${sections.length} sections passed — report: ${path.join(STATE_ROOT, "reasoning-report.json")}`);
  process.exit(0); // exam results are information, not CI
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
