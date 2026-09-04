import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// Tier 3 verification: ten realistic questions through the board router.
// Expectation: at least one legitimate decline, ZERO illegitimate ones — in
// particular, "personal decisions about my own venture" MUST route, because
// they are the board's core use case. Run: npx tsx scripts/board-router-check.ts
import { loadEnv } from "../src/core/config.js";
import { routeQuestion } from "../src/board/meeting.js";

loadEnv();

const QUESTIONS: { q: string; expect: "route" | "decline" }[] = [
  { q: "Should I raise the price of my tutoring service from 15 to 25 euros per hour?", expect: "route" },
  // The trap from the design brief: "personal decision about my own business"
  // was once declined by an over-eager gate. It must route.
  { q: "Dovrei lasciar perdere il mio progetto di e-commerce? È una decisione personale sulla mia attività.", expect: "route" },
  { q: "What would O’Leary say — sorry, I mean what would Munger say about putting my savings into a dropshipping business?", expect: "route" },
  { q: "Should I focus on my thesis or launch my side business this semester?", expect: "route" },
  { q: "I have chest pain when I run — what should I do about it?", expect: "decline" },
  { q: "Fix this TypeScript error in my server code: TS2345 argument not assignable.", expect: "decline" },
  { q: "How should I price a Notion template product aimed at university students?", expect: "route" },
  { q: "Is my cousin legally right to sue his landlord over the deposit?", expect: "decline" },
  { q: "How do I protect deep work hours while trying to get a first venture off the ground?", expect: "route" },
  { q: "Which market should I pick for a first venture: university students in Napoli, or small local restaurants?", expect: "route" },
];

let illegitimate = 0;
let legitimateDeclines = 0;
for (const { q, expect } of QUESTIONS) {
  const r = await routeQuestion(q);
  const got = r.boardQuestion ? "route" : "decline";
  const ok = got === expect;
  if (!ok && expect === "route") illegitimate++;
  if (ok && expect === "decline") legitimateDeclines++;
  console.log(
    `${ok ? "✓" : "✗ WRONG"} [${got.toUpperCase().padEnd(7)}] "${q.slice(0, 72)}"` +
      (r.boardQuestion ? `\n    → seats: ${r.seats.map((s) => s.id).join(", ")} (${r.reason.slice(0, 90)})` : `\n    → ${r.reason.slice(0, 100)}`),
  );
}
console.log(
  `\n${illegitimate === 0 ? "✅" : "❌"} illegitimate declines: ${illegitimate} (must be 0) · legitimate declines: ${legitimateDeclines} (must be ≥1)`,
);
process.exit(illegitimate === 0 && legitimateDeclines >= 1 ? 0 : 1);
