// The machine half of the morning brief. Since 2026-09-06 nothing is pushed
// at 08:00: the brief happens in the exchange where Umberto SAYS he's awake
// (brain/identity.md, "Mornings"), spoken like any reply — where a notice
// never was. This is what the code owes that moment: recognising the words
// (wakeUpSignal, so the trigger is testable and a normal first message never
// briefs), and the two readings the old scheduled briefing injected into its
// prompt so the model could not skip them by skipping a tool call — today's
// classes from the stored myESSEC timetable, and what his standing watches
// have said lately. Both are pure reads of what is already on disk. Nothing here touches
// the browser, a model, or the network, and nothing here may throw: it runs in
// front of his reply to the wake-up, and a broken store must cost him a
// line, never the reply.
//
// Dynamic imports, the heartbeat's own habit: the tools pull in the browser
// bridge and the notices store, and the prompt module that renders these
// facts is imported by everything (the board's dossier, the check scripts) —
// keeping the tool graph out of that path keeps the cheap consumers cheap.
import type { ClassesToday } from "../tools/essec.js";
import type { WatchSummary } from "../tools/standing-checks.js";

export interface MorningFacts {
  classes: ClassesToday;
  watches: WatchSummary[];
}

// The wake-up words. The brief has ONE trigger — Umberto saying he is awake —
// and never the day's first exchange on its own: his ask (2026-09-06), and
// tests/morning.test.ts holds the code to it, because a first message that
// happens to be "what's on my calendar" must get a calendar answer, not a
// briefing. Two tiers. An explicit first-person "I just woke up" counts at
// any hour (a nap is a wake-up too; identity decides how much day is left to
// brief). A bare morning greeting counts only in the morning, only when it
// opens a short message: "buongiorno" at seven is a wake-up, the same word at
// four in the afternoon is a hello, and "scrivi a Marco: buongiorno…" is a
// message to write. The review of the first version found "my sister woke
// up sick last night, can you find a pharmacy" opening with a gate card for
// The Clash — so every pattern below is anchored to HIM, NOW: a first-person
// subject, and a clause-local veto for negation and time-shift ("when I woke
// up yesterday…", "non sono sveglio"). Clause-local on purpose: "I just woke
// up, what happened yesterday?" still fires. The list is the deterministic
// floor the tests can pin; identity handles the rest by asking, never by
// guessing (brain/identity.md, "Mornings").
const CLAUSE = /[,.;:!?()\n]+/;
const EXPLICIT = [
  /\bi\s*(?:'ve\s+|have\s+)?(?:just\s+)?(?:woke|woken)\s+up\b/, // I (just) woke up / I've (just) woken up
  /\bi\s*(?:am|'m)\s+(?:awake|up)\b(?!\s+(?:for|to)\b)/, // I'm awake / I'm up — not "I'm up for a coffee"
  /\bi\s+(?:just\s+)?got\s+(?:up|out\s+of\s+bed)\b/, // I (just) got up / got out of bed
  /\bmi\s+sono\s+(?:appena\s+)?(?:svegliat|alzat)[oa]\b/, // mi sono (appena) svegliato / alzato
  /\b(?:sono|son)\s+(?:appena\s+)?svegli[oa]\b/, // sono sveglio / sveglia
  /\bappena\s+(?:svegli|alzat)[oa]\b/, // appena sveglio / alzato
  /\b(?:sono|finalmente)\s+in\s+piedi\b/, // sono / finalmente in piedi
  /\bje\s+viens\s+de\s+me\s+r[ée]veiller\b/, // je viens de me réveiller
  /\bje\s+suis\s+r[ée]veill[ée]e?\b/, // je suis réveillé(e)
  /\bje\s+me\s+suis\s+lev[ée]e?\b/, // je me suis levé(e)
];
// Subject-less forms count only when they OPEN the message (after a
// vocative): said as the first thing, "just woke up" is about him.
const OPENING = /^\s*(?:(?:eve|ehi|hey|ok|okay|ciao)[,!]?\s*)*(?:just\s+(?:woke|got)\s+up|got\s+out\s+of\s+bed)\b/;
// Negation or time-shift in the SAME clause as the match: not a wake-up.
const VETO =
  /\b(?:not|never|non|haven'?t|hadn'?t|didn'?t|isn'?t|wasn'?t|when\s+i|yesterday|last\s+night|ago|quando|ieri|stanotte|l'altra\s+notte|pas|hier)\b/;
// Greetings: only opening the message (a vocative may precede), and a bare
// "morning" only when nothing but punctuation or her name follows it —
// "morning run planned at 8" is a plan, not a hello.
const GREETING = [
  /^\s*(?:(?:eve|ehi|hey|ciao)[,!]?\s*)*(?:buon\s?giorno|good\s+morning|bonjour)\b/,
  /^\s*(?:(?:eve|ehi|hey|ciao)[,!]?\s*)*morning\b(?=\s*(?:[!,.?]|eve\b|$))/,
];
const MORNING_HOURS = { from: 5, to: 12 }; // [05:00, 12:00) local
const GREETING_MAX_WORDS = 6; // a greeting with a task attached is the task

export function wakeUpSignal(text: string, now = new Date()): boolean {
  const t = text.toLowerCase().replace(/[\u2019\u2018]/g, "'");
  const clauses = t.split(CLAUSE);
  if (OPENING.test(t) && !VETO.test(clauses[0] ?? "")) return true;
  for (const c of clauses) {
    if (EXPLICIT.some((re) => re.test(c)) && !VETO.test(c)) return true;
  }
  const h = now.getHours();
  const morning = h >= MORNING_HOURS.from && h < MORNING_HOURS.to;
  const short = t.trim().split(/\s+/).length <= GREETING_MAX_WORDS;
  return morning && short && GREETING.some((re) => re.test(t));
}

// A fresh object each time: the renderer never mutates it, but a shared
// constant with an array inside is the kind of thing that stops being true.
const noClasses = (): ClassesToday => ({ status: "empty", readDay: "", coversThrough: "", today: [] });

export async function morningFacts(now = new Date()): Promise<MorningFacts> {
  let classes = noClasses();
  let watches: WatchSummary[] = [];
  try {
    const { classesToday } = await import("../tools/essec.js");
    classes = classesToday(now);
  } catch {
    // A corrupt timetable store leaves the classes line out. It never blocks the turn.
  }
  try {
    const { watchSummaries } = await import("../tools/standing-checks.js");
    watches = watchSummaries(now);
  } catch {
    // Same rule for the watch store.
  }
  return { classes, watches };
}
