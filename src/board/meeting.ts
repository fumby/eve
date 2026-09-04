// The meeting pipeline: router → isolated fan-out → chair.
//
// Two structural defenses, per the design brief:
//   - Consensus theater is defeated by ISOLATION: one model call per seat,
//     each containing exactly one dossier, none aware the others exist.
//   - Fabrication is defeated by the citation gate: a seat may cite only ids
//     it was shown, and everything else is stripped server-side.
// Plus deterministic guards the prose cannot override: budget checked BEFORE
// every call, unanimity computed in code, spoken line assembled from the
// computed verdict.
import crypto from "node:crypto";
import { streamTurn } from "../core/provider.js";
import { loadConfig } from "../core/config.js";
import { audit } from "../core/audit.js";
import { readJson, writeJson } from "../core/store.js";
import {
  loadSeats,
  gateCitations,
  asBool,
  asText,
  asConfidence,
  type Seat,
} from "./dossier.js";
import { shortBrief, fullBrief } from "./brief.js";
import { emitAgentEvent } from "../core/agent-events.js";

export const MAX_SEATS_PER_MEETING = 4;
const SEAT_MAX_TOKENS = 1400; // generous: a truncated seat is money for nothing
const CHAIR_MAX_TOKENS = 2500; // larger than the seats' — it consumes all of them
const ROUTER_MAX_TOKENS = 400;

// ---------------------------------------------------------------- plumbing
interface CallResult {
  text: string;
  costUSD: number;
}

async function callModel(
  system: string,
  user: string,
  opts: { maxTokens: number; effort: "low" | "medium" | "high" },
): Promise<CallResult> {
  let text = "";
  let costUSD = 0;
  const p = loadConfig().pricing;
  for await (const ev of streamTurn({
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: opts.maxTokens,
    effort: opts.effort,
  })) {
    if (ev.type === "text") text += ev.delta;
    else if (ev.type === "done") {
      costUSD =
        (ev.usage.inputTokens / 1e6) * p.inputPerMTok +
        (ev.usage.outputTokens / 1e6) * p.outputPerMTok;
    }
  }
  return { text, costUSD };
}

function extractJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed: unknown = JSON.parse(m[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// Budget is enforced BEFORE each call from a conservative estimate (full
// output assumed), so a ceiling of zero spends zero — a post-hoc check would
// buy a whole fan-out before noticing.
class MeetingBudget {
  spentUSD = 0;
  constructor(private limitUSD: number) {}
  canAfford(systemChars: number, userChars: number, maxOutTokens: number): boolean {
    const p = loadConfig().pricing;
    const inTokens = (systemChars + userChars) / 3.5;
    const est = (inTokens / 1e6) * p.inputPerMTok + (maxOutTokens / 1e6) * p.outputPerMTok;
    return this.spentUSD + est <= this.limitUSD;
  }
  add(costUSD: number): void {
    this.spentUSD += costUSD;
  }
}

// ---------------------------------------------------------------- routing
// Dictated names arrive with curly apostrophes, NBSPs, fullwidth forms.
export function normalizeForMatching(s: string): string {
  return s
    .replace(/[‘’＇]/g, "'")
    .replace(/[   ]/g, " ")
    .replace(/­/g, "")
    .normalize("NFKC")
    .toLowerCase();
}

export interface RouteResult {
  boardQuestion: boolean;
  reason: string;
  seats: Seat[];
}

export async function routeQuestion(question: string): Promise<RouteResult> {
  const { seats } = loadSeats();
  return route(question, seats, new MeetingBudget(loadConfig().board?.maxMeetingUSD ?? 0.35));
}

async function route(question: string, seats: Seat[], budget: MeetingBudget): Promise<RouteResult> {
  // Direct mentions by surname route without spending: bare first names are
  // ambiguous and never route on their own.
  const q = normalizeForMatching(question);
  const direct = seats.filter((s) => {
    const surname = normalizeForMatching(s.name.split(" ").at(-1) ?? "");
    return surname.length > 2 && q.includes(surname);
  });
  if (direct.length > 0) {
    return {
      boardQuestion: true,
      reason: `named directly: ${direct.map((s) => s.name).join(", ")}`,
      seats: direct.slice(0, MAX_SEATS_PER_MEETING),
    };
  }

  const system = `You route questions to a board of advisors for Umberto, a business
administration student who intends to build ventures.

Seats:
${seats.map((s) => `- ${s.id}: ${s.name}, "${s.seat}", domains: ${s.domains.join(", ")}`).join("\n")}

DECLINE only questions like these concrete examples: writing or debugging code;
medical or health questions; legal advice; family and relationship matters;
questions about EVE's own configuration.

Decisions about Umberto's own ventures, business ideas, offers, pricing,
markets, money, studies, or career are THE CORE USE CASE of this board — no
matter how personal they feel. "Should I drop this project", "should I raise
my price", "thesis or side-business first" are exactly what the board is for.
Never decline a question for being "a personal decision".

Reply with ONLY JSON:
{"board_question": true|false, "reason": "one line", "seats": ["id", ...]}
Pick 2-4 seats whose DOMAINS give them standing on this question — not every
seat every time.`;

  if (!budget.canAfford(system.length, question.length, ROUTER_MAX_TOKENS)) {
    return { boardQuestion: false, reason: "budget exhausted before routing", seats: [] };
  }
  const { text, costUSD } = await callModel(system, question, {
    maxTokens: ROUTER_MAX_TOKENS,
    effort: "low",
  });
  budget.add(costUSD);
  const json = extractJson(text);
  if (!json) return { boardQuestion: false, reason: "router returned no parseable answer", seats: [] };

  const wanted = Array.isArray(json.seats) ? json.seats : [];
  const byId = new Map(seats.map((s) => [s.id, s]));
  const chosen: Seat[] = [];
  const seen = new Set<string>();
  for (const w of wanted) {
    if (typeof w !== "string") continue;
    const id = w.trim().toLowerCase();
    if (seen.has(id)) continue; // a router naming one advisor twice buys one call
    seen.add(id);
    const seat = byId.get(id);
    if (seat) chosen.push(seat);
    if (chosen.length >= MAX_SEATS_PER_MEETING) break;
  }
  return {
    boardQuestion: asBool(json.board_question) && chosen.length > 0,
    reason: asText(json.reason, 300) || "no reason given",
    seats: chosen,
  };
}

// ---------------------------------------------------------------- seats
export interface SeatOpinion {
  seatId: string;
  name: string;
  seatTitle: string;
  failed: boolean;
  abstained: boolean;
  unsourced: boolean; // spoke without citing — visible at a glance, not an error
  position: string;
  reasoning: string;
  citations: { id: string; title: string; source: string; verification: string }[];
  confidence: number | null;
  wouldChangeMind: string;
}

function dossierText(seat: Seat): string {
  const live = seat.doctrine.filter((d) => !d.retired);
  return [
    `# Doctrine of ${seat.name} (cite these ids and no others)`,
    ...live.map((d) => `### ${d.id} — ${d.title}\nSource: ${d.source}\n${d.body}`),
    `# Characteristic objection\n${seat.objection}`,
    `# Blind spots (your own limits — abstain when the question falls inside them)\n${seat.blindSpots}`,
    `# Voice\n${seat.voice}`,
  ].join("\n\n");
}

async function askSeat(
  seat: Seat,
  question: string,
  brief: string,
  budget: MeetingBudget,
): Promise<SeatOpinion> {
  const base: SeatOpinion = {
    seatId: seat.id,
    name: seat.name,
    seatTitle: seat.seat,
    failed: true,
    abstained: false,
    unsourced: false,
    position: "",
    reasoning: "",
    citations: [],
    confidence: null,
    wouldChangeMind: "",
  };

  const system = `You are ${seat.name}, holding the seat "${seat.seat}" on a small
advisory board. You reason ONLY from your documented doctrine below, in your
own voice. You are alone — you do not know who else is on the board.

Rules:
- Every substantive claim should rest on a doctrine entry; cite by id (e.g. "D2").
- You may only cite ids that appear in your doctrine. Nothing else exists.
- If the question falls outside your doctrine or inside your blind spots,
  ABSTAIN — say so plainly. An honest "I have no doctrine on this" is a real
  answer; a plausible invention is not.
- Disagree when your doctrine disagrees. You are not here to be agreeable.

${dossierText(seat)}

Reply with ONLY JSON:
{"abstain": true|false, "position": "your stance in 1-3 sentences",
 "reasoning": "why, from your doctrine, in your voice",
 "citations": ["D1", ...], "confidence": 0.0-1.0,
 "would_change_my_mind": "what evidence would flip you"}`;

  const user = `${brief}\n\nThe question before the board:\n${question}`;
  if (!budget.canAfford(system.length, user.length, SEAT_MAX_TOKENS)) {
    base.reasoning = "not called: meeting budget exhausted";
    return base;
  }
  try {
    const { text, costUSD } = await callModel(system, user, {
      maxTokens: SEAT_MAX_TOKENS,
      effort: "medium",
    });
    budget.add(costUSD);
    const json = extractJson(text);
    if (!json) return { ...base, reasoning: "seat returned no parseable answer" };

    const abstained = asBool(json.abstain);
    const gated = gateCitations(json.citations, seat.shownIds);
    const byId = new Map(seat.doctrine.map((d) => [d.id, d]));
    return {
      ...base,
      failed: false,
      abstained,
      unsourced: !abstained && gated.length === 0,
      position: asText(json.position, 800),
      reasoning: asText(json.reasoning, 2500),
      citations: gated.map((id) => {
        const d = byId.get(id)!;
        return { id, title: d.title, source: d.source, verification: d.verification };
      }),
      confidence: asConfidence(json.confidence),
      wouldChangeMind: asText(json.would_change_my_mind, 500),
    };
  } catch (err) {
    return { ...base, reasoning: `seat failed: ${err instanceof Error ? err.message : err}` };
  }
}

// ---------------------------------------------------------------- chair
export interface MeetingRecord {
  id: string;
  at: string;
  question: string;
  unprompted: boolean;
  routerReason: string;
  opinions: SeatOpinion[];
  synthesis: string;
  spoken: string;
  unanimous: boolean;
  costUSD: number;
}

const MEETINGS_FILE = "board-meetings.json";

export const loadMeetings = (): MeetingRecord[] => readJson<MeetingRecord[]>(MEETINGS_FILE, []);

function saveMeeting(m: MeetingRecord): void {
  const all = loadMeetings();
  all.unshift(m);
  writeJson(MEETINGS_FILE, all.slice(0, 100));
}

export async function convene(
  question: string,
  opts: { unprompted?: boolean; allSeats?: boolean } = {},
): Promise<{ ok: boolean; message: string; record?: MeetingRecord }> {
  const cfg = loadConfig();
  const limit = cfg.board?.maxMeetingUSD ?? 0.35;
  const budget = new MeetingBudget(limit);
  if (limit <= 0) {
    return { ok: false, message: "The board's budget is set to zero, so no meeting can be convened." };
  }

  const { seats, warnings } = loadSeats();
  for (const w of warnings) audit("board_warning", { warning: w });
  if (seats.length === 0) {
    return { ok: false, message: `No seats could be loaded${warnings.length ? ` (${warnings.join("; ")})` : ""}.` };
  }

  // The standing review has no question to route — every seat is seated.
  const routed = opts.allSeats
    ? {
        boardQuestion: true,
        reason: "standing review — full board",
        seats: seats.slice(0, MAX_SEATS_PER_MEETING),
      }
    : await route(question, seats, budget);
  if (!routed.boardQuestion) {
    return { ok: false, message: `The board declined: ${routed.reason}` };
  }

  // Fan out — in isolation, tolerantly. One timeout is a partial meeting.
  // Each seat announces itself to the face as it is dispatched and again as
  // its opinion lands, so the constellation shows who is in the room.
  const brief = shortBrief();
  const shortQ = question.slice(0, 80);
  for (const s of routed.seats) emitAgentEvent({ agent: s.id, phase: "dispatch", label: shortQ });
  const settled = await Promise.allSettled(
    routed.seats.map((s) =>
      askSeat(s, question, brief, budget).then(
        (op) => {
          emitAgentEvent({
            agent: s.id,
            phase: op.failed ? "error" : "done",
            label: op.abstained ? "abstained" : op.failed ? op.reasoning.slice(0, 80) : "opinion in",
          });
          return op;
        },
        (err) => {
          emitAgentEvent({ agent: s.id, phase: "error", label: String(err).slice(0, 80) });
          throw err;
        },
      ),
    ),
  );
  const opinions: SeatOpinion[] = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          seatId: routed.seats[i]!.id,
          name: routed.seats[i]!.name,
          seatTitle: routed.seats[i]!.seat,
          failed: true,
          abstained: false,
          unsourced: false,
          position: "",
          reasoning: String(r.reason),
          citations: [],
          confidence: null,
          wouldChangeMind: "",
        },
  );

  const spoke = opinions.filter((o) => !o.failed && !o.abstained);
  const abstained = opinions.filter((o) => o.abstained);
  if (spoke.length === 0) {
    const msg =
      abstained.length > 0
        ? `Every seat abstained — ${abstained.map((o) => o.name).join(", ")} each said this falls outside their doctrine.`
        : "No seat produced an opinion (all calls failed).";
    return { ok: false, message: msg };
  }

  // Chair: the only participant who has read the full live picture.
  const chairSystem = `You are EVE, chairing Umberto's board of advisors. You are
the only participant who has read his full live situation. The seats are
well-read but blind: they saw only a short brief and their own doctrine.

Synthesize their opinions:
- Name the SPLIT before the agreement. Where the board divided is the
  information; where it agreed is often just the obvious.
- Discount seats using their documented blind spots, and say so plainly when
  a position falls inside one.
- Treat abstention as abstention, never as assent.
- Any citation marked verification:"user" is Umberto's own note, not that
  person's documented view — flag positions resting on it as his own
  assumption coming back to him.
- Be concrete: end with what Umberto should actually do.

Reply with ONLY JSON:
{"split": "where the board genuinely divided, one or two sentences",
 "synthesis": "your full reconciliation against his real situation",
 "recommendation": "the concrete next step",
 "unanimous": true|false,
 "spoken": "ONE or TWO sentences for the ear, leading with the split (or the disagreement's absence), then the recommendation"}`;

  const blindSpotsBlock = routed.seats
    .map((s) => `${s.name}: ${s.blindSpots.replace(/\n/g, " ")}`)
    .join("\n");
  const chairUser = [
    `Question: ${question}`,
    "",
    "=== Full live brief (only you see this) ===",
    await fullBrief(),
    "",
    "=== Seat blind spots (use these to discount) ===",
    blindSpotsBlock,
    "",
    "=== Opinions ===",
    JSON.stringify(
      opinions.map((o) => ({
        name: o.name,
        seat: o.seatTitle,
        failed: o.failed,
        abstained: o.abstained,
        unsourced: o.unsourced,
        position: o.position,
        reasoning: o.reasoning,
        citations: o.citations,
        confidence: o.confidence,
        would_change_my_mind: o.wouldChangeMind,
      })),
      null,
      1,
    ),
  ].join("\n");

  let synthesis = "";
  let spoken = "";
  let chairUnanimous = false;
  if (budget.canAfford(chairSystem.length, chairUser.length, CHAIR_MAX_TOKENS)) {
    try {
      const { text, costUSD } = await callModel(chairSystem, chairUser, {
        maxTokens: CHAIR_MAX_TOKENS,
        effort: "medium",
      });
      budget.add(costUSD);
      const json = extractJson(text);
      if (json) {
        synthesis = [asText(json.split, 600), asText(json.synthesis, 3000), asText(json.recommendation, 600)]
          .filter(Boolean)
          .join("\n\n");
        spoken = asText(json.spoken, 600);
        chairUnanimous = asBool(json.unanimous);
      }
    } catch {
      // fall through to the deterministic fallback below
    }
  }

  // Deterministic guards. One voice is never a consensus — and the sentence
  // read aloud must not contradict the computed verdict (it did, once).
  const unanimous = chairUnanimous && spoke.length >= 2;
  if (!unanimous && /unanim/i.test(spoken)) spoken = "";
  if (!synthesis) {
    synthesis = opinions
      .map((o) => `${o.name}: ${o.abstained ? "abstained" : o.failed ? "no answer" : o.position}`)
      .join("\n");
  }
  if (!spoken) {
    spoken = `${spoke.length} seat${spoke.length > 1 ? "s" : ""} spoke${
      abstained.length ? `, ${abstained.length} abstained` : ""
    }. The positions differ — the detail is in the minutes.`;
  }

  const record: MeetingRecord = {
    id: crypto.randomBytes(4).toString("hex"),
    at: new Date().toISOString(),
    question,
    unprompted: opts.unprompted === true,
    routerReason: routed.reason,
    opinions, // citations carry snapshotted title+source+verification already
    synthesis,
    spoken,
    unanimous,
    costUSD: Number(budget.spentUSD.toFixed(4)),
  };
  saveMeeting(record);
  audit("board_meeting", {
    id: record.id,
    question: question.slice(0, 120),
    seats: opinions.map((o) => o.seatId),
    abstained: abstained.length,
    unanimous,
    costUSD: record.costUSD,
    unprompted: record.unprompted,
  });

  return { ok: true, message: formatForAgent(record), record };
}

// What EVE (the outer agent) receives back from the tool: the spoken line
// first, then compact minutes she can draw on if Umberto asks for detail.
function formatForAgent(m: MeetingRecord): string {
  const lines = [
    `BOARD VERDICT (say this part aloud, in Umberto's language): ${m.spoken}`,
    "",
    `Minutes (meeting ${m.id}, cost $${m.costUSD.toFixed(2)}${m.unanimous ? ", unanimous" : ""}):`,
  ];
  for (const o of m.opinions) {
    if (o.failed) lines.push(`- ${o.name}: (no answer — ${o.reasoning || "call failed"})`);
    else if (o.abstained) lines.push(`- ${o.name} ABSTAINED: ${o.position || o.reasoning}`);
    else {
      const cites = o.citations.map((c) => `${c.id}${c.verification === "user" ? "*" : ""}`).join(",");
      lines.push(
        `- ${o.name} (${o.seatTitle}${o.unsourced ? ", UNSOURCED" : ""}${
          o.confidence !== null ? `, conf ${o.confidence}` : ""
        }): ${o.position}${cites ? ` [${cites}]` : ""}`,
      );
    }
  }
  lines.push("", `Chair synthesis:`, m.synthesis);
  lines.push("", "(* = rests on Umberto's own note, not documented doctrine)");
  return lines.join("\n");
}
