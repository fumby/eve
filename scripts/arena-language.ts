// Which language a reply is written in. Split out of the exam arena so it can
// be tested for free: this is the third generation of a component whose bugs
// are the whole reason scripts/arena-eval.ts was rewritten, and until now the
// only way to exercise it was a nine-turn paid run against the live provider.
// tests/arena-language.test.ts is the guard. No imports on purpose — pure,
// deterministic, and safe for the unit suite to load.
//
// The two failures this design comes from:
//   • The first grader had ONE list, of eleven Italian WEATHER words. A correct
//     Italian reply that said "Nebbia / Alba / tramonto" instead scored 1 and
//     was reported as "NOT Italian?". Topic words alone cannot measure
//     language: what a reply is ABOUT changes with the question.
//   • Its English side did not exist at all, so an English answer to an Italian
//     question — and an Italian answer to an English one — were both invisible.
//
// So: two lists, scored identically, in two layers.
//
// Layer 1 is FUNCTION words. Words that exist in both languages are excluded on
// purpose ("a", "i", "in", "no", "come", "me", "so", "via", "era", "ok",
// "solo", "circa"): a marker that fires for both sides measures nothing. Single
// ASCII letters are excluded outright, because tokenising "e.g." yields "e",
// which is an Italian conjunction — "è" is the one deliberate single-character
// marker, and it is not ASCII. "all" is excluded from the English list even
// though it is unambiguous English, because splitting the Italian elision
// "all'una" yields "all" (see tokenise).
//
// Layer 2 is DOMAIN words, in MATCHED PAIRS — gradi/degrees, pioggia/rain,
// alba/sunrise. This is the layer that looks like the original bug and is not:
// the original bug was asymmetry, not topicality. EVE's answers are
// telegraphic ("Sole, 28 gradi." / "Sunny, 28 degrees.") and carry no function
// words at all, so without this layer the turn whose entire purpose is language
// has nothing to measure. Every entry must be added to BOTH lists or neither.

const IT_FUNCTION = [
  "il", "lo", "la", "gli", "le", "un", "uno", "una",
  "di", "del", "dello", "della", "dei", "degli", "delle",
  "da", "dal", "dalla", "dallo", "nel", "nello", "nella", "nei", "negli", "nelle",
  "sul", "sullo", "sulla", "sui", "sugli", "sulle", "su", "col", "con", "tra", "fra",
  "al", "allo", "alla", "agli", "alle", "per",
  "che", "chi", "cui", "non", "più", "meno", "quando", "dove", "perché", "perche",
  "se", "ma", "però", "anche", "ancora", "già", "molto", "poco", "troppo",
  "questo", "questa", "questi", "queste", "quello", "quella", "quelli", "quelle",
  "sono", "sei", "siamo", "siete", "è", "ho", "hai", "ha", "abbiamo", "hanno",
  "ti", "mi", "ci", "vi", "si", "mio", "mia", "miei", "tuo", "tua", "tuoi", "suo", "sua",
  "oggi", "domani", "ieri", "adesso", "ora", "ore",
  "niente", "nulla", "nessun", "nessuna", "grazie", "sempre", "mai",
  "prima", "dopo", "senza", "sotto", "sopra", "qui", "qua", "là",
  "cosa", "quale", "quali", "tutto", "tutta", "tutti", "tutte", "ogni",
  "essere", "fare", "vuoi", "voglio", "posso", "puoi", "devo", "devi",
  "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica",
  "gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre",
];

const EN_FUNCTION = [
  "the", "an", "and", "but", "or", "if", "of", "to", "at", "on", "by", "as",
  "with", "from", "for", "about", "into", "than", "then", "there", "here",
  "this", "that", "these", "those", "what", "when", "where", "why", "how",
  "which", "who", "whose", "you", "your", "yours", "we", "our", "us",
  "they", "them", "their", "he", "him", "his", "she", "her", "it", "its",
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "can", "could", "should", "must",
  "not", "just", "only", "still", "yet", "also", "always", "never",
  "nothing", "something", "anything", "everything", "yes", "yeah", "nope",
  "get", "got", "need", "want", "know", "think", "one", "up", "out", "now",
  "today", "tomorrow", "yesterday",
  // Notation, not grammar: Italian states the time on a 24-hour clock and never
  // writes "pm". They can never decide a verdict alone — the margin below sees
  // to that — but they are the only signal a bare clock reading carries.
  "am", "pm",
  "it's", "that's", "don't", "doesn't", "didn't", "isn't", "aren't",
  "you're", "i'm", "i'll", "won't", "can't", "haven't", "here's", "there's",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

// Matched pairs, one line each, so a missing counterpart is visible on sight.
const DOMAIN_PAIRS: [string, string][] = [
  ["gradi", "degrees"],
  ["grado", "degree"],
  ["pioggia", "rain"],
  ["piove", "raining"],
  ["piovoso", "rainy"],
  ["sole", "sun"],
  ["soleggiato", "sunny"],
  ["nuvoloso", "cloudy"],
  ["nuvole", "clouds"],
  ["coperto", "overcast"],
  ["sereno", "clear"],
  ["nebbia", "fog"],
  ["nebbioso", "foggy"],
  ["vento", "wind"],
  ["ventoso", "windy"],
  ["neve", "snow"],
  ["temporali", "thunderstorms"],
  ["temporale", "thunderstorm"],
  ["alba", "sunrise"],
  ["tramonto", "sunset"],
  ["massima", "high"],
  ["minima", "low"],
  ["umidità", "humidity"],
  ["previsioni", "forecast"],
  ["caldo", "warm"],
  ["freddo", "cold"],
  ["promemoria", "reminder"],
  ["messaggio", "message"],
  ["scadenza", "deadline"],
  ["inviato", "sent"],
  ["rifiutato", "declined"],
];

export const IT_MARKERS: ReadonlySet<string> = new Set([
  ...IT_FUNCTION,
  ...DOMAIN_PAIRS.map(([it]) => it),
]);

export const EN_MARKERS: ReadonlySet<string> = new Set([
  ...EN_FUNCTION,
  ...DOMAIN_PAIRS.map(([, en]) => en),
]);

export type Lang = "it" | "en" | "unknown";

export interface LangVerdict {
  detected: Lang;
  it: number;
  en: number;
}

/**
 * Words, with elisions split. The apostrophe is kept inside the token so
 * English contractions stay whole ("it's"), and the pieces are ALSO added so
 * Italian elisions are not invisible: "l'ora", "dell'alba", "c'è" and
 * "all'una" would otherwise match nothing at all, and elision is the single
 * most Italian-looking thing in the orthography.
 */
function tokenise(text: string): Set<string> {
  const raw = text.toLowerCase().replace(/[’]/g, "'").match(/[\p{L}']+/gu) ?? [];
  const words = new Set<string>();
  for (const token of raw) {
    const trimmed = token.replace(/^'+|'+$/g, "");
    if (!trimmed) continue;
    words.add(trimmed);
    if (trimmed.includes("'")) for (const part of trimmed.split("'")) if (part) words.add(part);
  }
  return words;
}

/** A verdict needs this many more markers than the other side. */
const MARGIN = 2;

/**
 * Counts DISTINCT markers from each list. Distinct, not total: a two-line
 * answer that says "the" five times is not five times more English than one
 * that says it once, and these replies are short by design.
 *
 * The MARGIN is what keeps one incidental foreign token from deciding a whole
 * turn. "Booked: Trattoria da Enzo, 20:30." is an English sentence carrying one
 * Italian preposition inside a restaurant name; a one-marker bar would call it
 * Italian and fail the turn for drift that never happened. Italian venue,
 * street and surname tokens (di, del, della, la, le) are exactly what an
 * English answer about Umberto's evening contains.
 *
 * "unknown" is a real answer, not a failure. "19:45." is a clock reading in no
 * language at all, and calling that drift would be inventing a defect. What the
 * CALLER must not do is treat unknown as automatically fine on a long reply —
 * see languageHeld in the arena.
 */
export function detectLanguage(text: string): LangVerdict {
  const words = tokenise(text);
  let it = 0;
  let en = 0;
  for (const w of words) {
    if (IT_MARKERS.has(w)) it++;
    if (EN_MARKERS.has(w)) en++;
  }
  const detected: Lang = it - en >= MARGIN ? "it" : en - it >= MARGIN ? "en" : "unknown";
  return { detected, it, en };
}
