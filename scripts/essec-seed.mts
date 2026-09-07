// One-shot: walk myESSEC through Umberto's logged-in Chrome and seed
// data/essec-knowledge.json with what his school actually says.
//
//   node --import tsx scripts/essec-seed.mts
//   node --import tsx scripts/essec-seed.mts --dry-run    (read, store nothing)
//
// Four things this script is careful about:
//
// 1. IT CHECKS THE LOGIN FIRST, and stops loudly if myESSEC is not logged in
//    in EVE's Chrome profile. Everything worth knowing here is behind that
//    login; a crawl that runs anyway would store twenty copies of a sign-in
//    page and report success. See SETUP-PENDING.md for the one-time gestures.
// 2. IT IS IDEMPOTENT. Entries merge on section + canonical URL, so running it
//    again refreshes the text and the date in place. Re-run it whenever the
//    semester moves.
// 3. IT REPORTS EVERY PAGE — stored, refused, or failed, with the reason. A
//    page silently dropped reads exactly like a page that had nothing on it,
//    and the whole point of this layer is that EVE never invents school facts.
// 4. IT DISCOVERS RATHER THAN HARDCODES the things that change every term. His
//    courses, his class sessions and this week's news are all followed from
//    the index pages that list them, so next semester's timetable needs a
//    re-run, not an edit.
//
// Safe to run while the face server is up: the only thing it writes is the
// knowledge store, through the same atomic write everything else uses.
import {
  browsePages,
  checkEssecLogin,
  loadKnowledge,
  offHostStub,
  parseSessions,
  saveEntries,
  type BrowseOutcome,
  type BrowseRequest,
  type EssecEntry,
  type EssecSection,
} from "../src/tools/essec.js";

const DRY_RUN = process.argv.includes("--dry-run");

// The hubs, discovered by reading my.essec.fr's own navigation rather than
// guessed. The program centre's seven sections differ only by ?category=, so
// each is its own page — that query string is load-bearing.
const PC = "https://my.essec.fr/en/service/program-center-local-bba";
const SVC = "https://my.essec.fr/en/service";
// His course list. It is a WordPress search page, and the pager turned out to
// be a plain URL after all: clicking "2" only rewrites ?pagenum=. So the pages
// are fetched directly and no click machinery is needed anywhere in this crawl.
const COURSE_INDEX = (n: number) => `https://my.essec.fr/en/?s=&pagenum=${n}&index=crns`;

const PAGES: BrowseRequest[] = [
  // The home page carries the live timetable: the next classes with their
  // rooms, times and professors. It is the single most useful page here, and
  // its agenda links are followed below to reach the rest of the term.
  { url: "https://my.essec.fr/en/", section: "courses", title: "MyESSEC home — upcoming classes and calendar", note: "His live timetable: next sessions with room, time and professor." },

  // ── his actual courses ────────────────────────────────────────────────
  // Two pages of ten. Both are read (they list different courses) and the
  // /crn/ links on them are followed below, one entry per course.
  { url: COURSE_INDEX(1), section: "courses", title: "My courses — index, page 1 of 2", note: "The list of the courses he is enrolled in, with codes and faculties." },
  { url: COURSE_INDEX(2), section: "courses", title: "My courses — index, page 2 of 2", note: "The rest of his enrolled courses — inductions and workshops live here." },
  // Moodle is where the coursework itself lives, and it is an ESSEC host, so
  // it is inside the allowlist. The dashboard's own timeline only shows the
  // next 7 days; the calendar views below are the ones that carry deadlines.
  { url: "https://moodle.essec.fr/my/", section: "courses", title: "Moodle dashboard — his course spaces", note: "The platform his course material and quizzes are on." },

  // ── what is due ───────────────────────────────────────────────────────
  { url: "https://my.essec.fr/en/evaluations/", section: "deadlines", title: "Course evaluations he owes, with their windows", note: "What the notifications bell is counting: each evaluation and the dates it is open." },
  { url: "https://moodle.essec.fr/calendar/view.php?view=upcoming", section: "deadlines", title: "Moodle — upcoming events", note: "Quizzes and assignments with due dates, from the platform that actually holds them." },
  { url: "https://moodle.essec.fr/calendar/view.php?view=month", section: "deadlines", title: "Moodle — this month", note: "The month view of coursework deadlines." },

  // The Global BBA programme centre, section by section.
  { url: PC, section: "program", title: "Global BBA programme centre — hub", note: "The programme centre's index of sections." },
  { url: `${PC}/?category=academics`, section: "program", title: "Global BBA — academics", note: "Academic rules, grading, credits." },
  { url: `${PC}/?category=study-plan`, section: "courses", title: "Global BBA — course offer / study plan", note: "Which courses exist and how the study plan is built." },
  { url: `${PC}/?category=incoming-students`, section: "program", title: "Global BBA — arrival & integration", note: "First-year arrival, induction, integration." },
  { url: `${PC}/?category=exchanges-and-mobilities`, section: "program", title: "Global BBA — exchanges and mobility", note: "Exchange semesters and how to apply." },
  { url: `${PC}/?category=professional-experience-gbba`, section: "program", title: "Global BBA — professional path", note: "Internships and professional experience requirements." },
  { url: `${PC}/?category=after-the-global-bba`, section: "program", title: "After the Global BBA", note: "What follows the BBA — masters, careers." },
  { url: `${PC}/?category=contacts`, section: "contacts", title: "Global BBA — key contacts", note: "Who to email about what in his own programme." },

  // News and calls: where deadlines actually appear. The index is read first
  // and its article links are followed below.
  { url: "https://my.essec.fr/en/news/", section: "deadlines", title: "MyESSEC news and events", note: "Where forums, career fairs and calls for applications are announced." },

  // Registrar & money — the administrative deadlines that cost him if missed.
  { url: `${SVC}/mon-registraire`, section: "services", title: "My registrar", note: "The registrar's own page (personal record — expected to be refused by the guard)." },
  { url: `${SVC}/faq-registraire`, section: "faq", title: "Registrar FAQ", note: "Certificates, transcripts, administrative questions." },
  { url: `${SVC}/paiement-des-frais-de-scolarite`, section: "faq", title: "Tuition payment", note: "How and when tuition is paid." },
  { url: `${SVC}/remboursement`, section: "faq", title: "Reimbursements", note: "How to claim a refund." },

  // Academic machinery.
  { url: `${SVC}/evaluation-des-cours`, section: "courses", title: "Course evaluations", note: "The evaluations he is nagged about in the notifications bell." },
  { url: `${SVC}/safe-exam-browser`, section: "courses", title: "Safe Exam Browser", note: "The lockdown browser used for exams." },
  { url: `${SVC}/discovery`, section: "courses", title: "Discovery", note: "The Discovery course/track." },

  // The library and study spaces — K-Lab.
  { url: `${SVC}/klabservicesandcontacts`, section: "services", title: "K-Lab — services and contacts", note: "The library: what it offers and who to ask." },
  { url: `${SVC}/klab-data-bases`, section: "services", title: "K-Lab — databases", note: "Research databases he can use for coursework." },
  { url: `${SVC}/ateliers-k-lab-student`, section: "services", title: "K-Lab — student workshops", note: "Workshops on research and documentation." },
  { url: "https://my.essec.fr/en/?s=&index=myessec_kdatabase", section: "services", title: "K-Lab — the database directory", note: "The 53 research databases by category: finance, market reports, newspapers, ebooks." },
  { url: `${SVC}/k-lab-thesis`, section: "faq", title: "Theses and dissertations", note: "How the Learning Center helps with a thesis, and what is expected." },
  { url: `${SVC}/k-lab-coursera-consortium`, section: "faq", title: "MOOC Coursera consortium", note: "The Coursera access his student status gives him." },
  { url: `${SVC}/reserver-une-salle-de-travail`, section: "campus", title: "Book a study room", note: "How to book a group study room." },

  // Campus life.
  { url: `${SVC}/3755`, section: "campus", title: "Student and associative life", note: "Associations, funding an associative project, the rules around events." },
  { url: `${SVC}/4096`, section: "campus", title: "Campuses", note: "The campuses hub (a link menu — expected to be refused as too thin)." },
  { url: `${SVC}/sports-and-recreation-center`, section: "campus", title: "Sports and recreation centre", note: "Campus sport facilities." },
  { url: `${SVC}/gaming-lab`, section: "campus", title: "Gaming lab", note: "Campus gaming lab." },
  { url: `${SVC}/mon-portail-logement-alegessec`, section: "campus", title: "Housing portal (ALEGESSEC)", note: "Student housing." },
  { url: `${SVC}/alegessec-plateforme-de-reservation`, section: "campus", title: "ALEGESSEC booking platform", note: "Booking campus facilities." },
  { url: `${SVC}/handicap`, section: "services", title: "Disability support", note: "Accommodations and who arranges them." },

  // Careers.
  { url: `${SVC}/3261`, section: "services", title: "Career guidance by ESSEC", note: "The career-services catalogue: kits, interview prep, networking, getting hired." },
  { url: `${SVC}/3611`, section: "services", title: "Apprenticeship (CFA)", note: "The apprenticeship route, including the GBBA one." },
  { url: `${SVC}/5074`, section: "services", title: "Job boards", note: "The job-board directory, France and international." },
  { url: `${SVC}/forums-et-evenements-carrieres`, section: "services", title: "Career forums and events", note: "Recruiting forums and career events." },
  { url: `${SVC}/rdv-individuel`, section: "services", title: "One-to-one career appointments", note: "Booking a careers adviser." },
  { url: `${SVC}/essec-alumni-for-students`, section: "services", title: "ESSEC Alumni for students", note: "The alumni network as a student resource." },
  { url: `${SVC}/offres-de-monitorat`, section: "services", title: "Student assistant jobs", note: "Paid on-campus student jobs." },

  // ESSEC's own public site. Added after the first live crawl, which found the
  // campus section empty: every myESSEC campus link is a redirect to a booking
  // partner (affluences.com, housing.alegessec.fr), so the campus itself is
  // only described on essec.edu — which is on the allowlist and needs no login.
  { url: "https://www.essec.edu/en/pages/essec-global-bba/", section: "program", title: "Global BBA — the programme as ESSEC describes it", note: "The public description of his own degree: structure, campuses, admissions." },
  { url: "https://www.essec.edu/en/campus/paris-cergy/", section: "campus", title: "Cergy campus", note: "The campus he actually attends." },

  // Practical IT and campus rules. The Google-shaped ones here (Gmail, Drive,
  // Notebook LM, Sites, Zoom) are listed ON PURPOSE even though every one of
  // them leaves ESSEC: the crawl records a stub saying where the link goes and
  // stores nothing from the far side. Knowing that "myESSEC's Gmail tile is his
  // real inbox, and EVE does not read it" is worth an entry; the inbox is not.
  { url: `${SVC}/eduroam`, section: "services", title: "eduroam wifi", note: "Getting online on campus." },
  { url: `${SVC}/imprimer`, section: "services", title: "Printing", note: "How to print on campus (PaperCut — expected to be refused as his personal record)." },
  { url: `${SVC}/office-365`, section: "services", title: "Office 365", note: "How to claim his Office 365 licence." },
  { url: `${SVC}/canva`, section: "services", title: "Canva Pro", note: "The Canva Pro access his student status gives him." },
  { url: `${SVC}/gmail`, section: "services", title: "Gmail (ESSEC mail)", note: "His school mailbox — reached from myESSEC, read by nothing here." },
  { url: `${SVC}/drive`, section: "services", title: "Google Drive (ESSEC)", note: "His school Drive — reached from myESSEC, read by nothing here." },
  { url: `${SVC}/notebook-lm`, section: "services", title: "Notebook LM", note: "The Google notebook tile on myESSEC." },
  { url: `${SVC}/sites`, section: "services", title: "Google Sites (ESSEC)", note: "The Sites tile on myESSEC." },
  { url: `${SVC}/zoom-2`, section: "services", title: "Zoom (ESSEC account)", note: "How his ESSEC Zoom account is activated." },
  { url: `${SVC}/agenda`, section: "courses", title: "Agenda (Google Calendar)", note: "The myESSEC agenda tile — it is his Google Calendar, which get_calendar's job, not this one's." },
  { url: `${SVC}/charte-du-respect-dautrui-staff`, section: "misc", title: "Respect charter", note: "The conduct rules he agreed to." },
  { url: `${SVC}/together-2`, section: "misc", title: "Transcend — ESSEC's strategy", note: "What the school says it is trying to be." },
  { url: `${SVC}/transcendplan`, section: "misc", title: "Transcend plan (PDF)", note: "The strategy as a PDF (expected to come back empty — this reader does not do PDFs)." },
];

// News articles are dated things — hardcoding this week's four would be stale
// next Monday. So the index page's own links are followed instead, bounded.
const MAX_NEWS = 10;
// Slug only: [^/]+ also matched "?s=…" on the index itself, which stored the
// index a second time under a query-string URL.
const NEWS_ARTICLE = /^https:\/\/my\.essec\.fr\/en\/news\/[a-z0-9][a-z0-9-]*\/?$/;

// One page per COURSE. 11 digits: "202600" plus the CRN.
const CRN_PAGE = /^https:\/\/my\.essec\.fr\/en\/crn\/(\d{11})\/?$/;
// One page per SESSION of a course. The id is the CRN followed by the session's
// own DDMMYYYYHHMM — which is why they can be sorted without reading them.
const AGENDA_PAGE = /^https:\/\/my\.essec\.fr\/en\/agenda\/(\d{11})(\d{2})(\d{2})(\d{4})(\d{4})\/?$/;
// The home page links every session in the visible month, past ones included,
// and a term's worth would bury the store: `essec_knowledge read section=courses`
// dumps every entry it holds into the prompt. Twelve upcoming sessions is about
// a fortnight — the horizon a daily briefing can actually use — and the count
// dropped is printed rather than quietly trimmed.
const MAX_SESSIONS = 12;

function line(label: string, detail: string): void {
  console.log(`  ${label.padEnd(9)} ${detail}`);
}

function report(outcomes: BrowseOutcome[]): void {
  for (const o of outcomes) {
    if (o.ok) line("stored", `[${o.section}] ${o.title} — ${o.chars} chars`);
    else line("skipped", `[${o.section}] ${o.url}\n            ↳ ${o.reason}`);
  }
}

/**
 * Sort key for an agenda URL, from the id alone. The id ends DDMMYYYYHHMM, and
 * reordering it to YYYYMMDDHHMM makes a plain string compare chronological —
 * so the crawl can pick the SOONEST sessions without fetching any of them.
 */
function sessionKey(url: string): string | null {
  const m = AGENDA_PAGE.exec(url);
  if (!m) return null;
  const [, , dd, mm, yyyy, hhmm] = m;
  return `${yyyy}${mm}${dd}${hhmm}`;
}

/**
 * Give the course and session entries their own names.
 *
 * browsePages falls back to the page's <title> when the caller doesn't supply
 * one, and every /crn/ and /agenda/ page on myESSEC is titled, simply,
 * "MyESSEC" — the first run of this crawl produced thirty-two entries under
 * that one heading, which is unreadable when the store is dumped back into a
 * prompt. The names are not invented to fix it: each page opens with its own
 * course name and code, so the entries are retitled from the text ALREADY
 * STORED. No second read, no guesswork — and saveEntries merges on section +
 * URL, so this updates the entry in place rather than adding another.
 */
function retitleStored(match: RegExp, name: (lines: string[], text: string) => string): number {
  const entries = loadKnowledge().entries.filter((e) => match.test(e.source.url) && e.title === "MyESSEC");
  for (const e of entries) {
    const lines = e.text.split("\n").map((l) => l.trim());
    const title = name(lines, e.text).trim();
    if (title) saveEntries([{ ...e, title }]);
  }
  return entries.length;
}

const login = await checkEssecLogin();
if (login.state !== "in") {
  console.error(
    [
      "",
      "STOP — myESSEC is not logged in in EVE's Chrome profile.",
      "",
      `  The home page came back as: ${login.page.url}`,
      `  Title: ${login.page.title || "(none)"}`,
      `  Login state: ${login.state}`,
      "",
      "  Nothing was stored, and nothing was invented. Do the one-time gestures in",
      "  SETUP-PENDING.md (log into my.essec.fr in the EVE Chrome window), then run",
      "  this again:",
      "",
      "      node --import tsx scripts/essec-seed.mts",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`myESSEC is logged in (${login.page.title || login.page.url}).`);
console.log(`Reading ${PAGES.length} pages${DRY_RUN ? " (dry run — nothing will be stored)" : ""}…\n`);

const before = loadKnowledge().entries.length;

if (DRY_RUN) {
  for (const p of PAGES) line("would", `[${p.section}] ${p.url}`);
  console.log(
    `\n${PAGES.length} pages would be read, plus up to ${MAX_NEWS} news items, every course linked ` +
      `from the two index pages, and ${MAX_SESSIONS} upcoming class sessions. Nothing was stored.`,
  );
  process.exit(0);
}

const outcomes = await browsePages(PAGES);
report(outcomes);
const all: BrowseOutcome[] = [...outcomes];

// ── follow the indexes ──────────────────────────────────────────────────
// Everything below is discovered from a page just read, never hardcoded: his
// course list and his timetable both change every term.

function linksFrom(url: string): string[] {
  return outcomes.find((o) => o.url === url)?.links ?? [];
}

const articles = [...new Set(linksFrom("https://my.essec.fr/en/news/").filter((l) => NEWS_ARTICLE.test(l)))].slice(0, MAX_NEWS);
if (articles.length > 0) {
  console.log(`\nFollowing ${articles.length} news item${articles.length === 1 ? "" : "s"} from the index…`);
  const news = await browsePages(
    articles.map((url): BrowseRequest => ({
      url,
      section: "deadlines" as EssecSection,
      note: "Announcement from the MyESSEC news feed — check the date before acting on it.",
    })),
  );
  report(news);
  all.push(...news);
} else {
  console.log("\nNo news articles were linked from the index — none were stored (not an error, just nothing there).");
}

const courses = [...new Set([...linksFrom(COURSE_INDEX(1)), ...linksFrom(COURSE_INDEX(2))].filter((l) => CRN_PAGE.test(l)))].sort();
if (courses.length > 0) {
  console.log(`\nFollowing ${courses.length} course pages from his course index…`);
  const crns = await browsePages(
    courses.map((url): BrowseRequest => ({
      url,
      section: "courses" as EssecSection,
      note: "One of his enrolled courses: code, dates, campus, enrolment and the faculty who teach it.",
    })),
  );
  report(crns);
  all.push(...crns);
} else {
  console.log("\nNo course pages were linked from the index — none were stored. If he has courses, the index did not render.");
}

// Upcoming sessions only. The home page lists the whole visible month, and a
// September crawl following the past half of it would spend reads on lectures
// that already happened.
const todayKey = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}0000`;
})();
const sessionLinks = [...new Set(linksFrom("https://my.essec.fr/en/").filter((l) => AGENDA_PAGE.test(l)))]
  .map((url) => ({ url, key: sessionKey(url) ?? "" }))
  .filter((s) => s.key >= todayKey)
  .sort((a, b) => a.key.localeCompare(b.key));
const sessions = sessionLinks.slice(0, MAX_SESSIONS);
if (sessions.length > 0) {
  const dropped = sessionLinks.length - sessions.length;
  console.log(
    `\nFollowing the next ${sessions.length} class session${sessions.length === 1 ? "" : "s"} from the home page's agenda` +
      `${dropped > 0 ? ` (${dropped} further upcoming session${dropped === 1 ? "" : "s"} left unread — cap is ${MAX_SESSIONS})` : ""}…`,
  );
  const agenda = await browsePages(
    sessions.map(({ url }): BrowseRequest => ({
      url,
      section: "courses" as EssecSection,
      note: "One class session: date, time, room and who teaches it.",
    })),
  );
  report(agenda);
  all.push(...agenda);
} else {
  console.log("\nNo upcoming class sessions were linked from the home page — none were stored.");
}

// ── the off-host stubs ──────────────────────────────────────────────────
// Only the curated list above, deliberately: a stub is worth storing when the
// link has a NAME he would recognise ("Gmail", "Book a study room"), so EVE can
// say where a tile goes. "crn/20260001724 — leaves ESSEC" would tell nobody
// anything. Followed links that redirect off-host are still refused by the
// guard and still reported above; they just don't earn an entry.
const byUrl = new Map(PAGES.map((p) => [p.url, p]));
const fetchedAt = new Date().toISOString();
const stubs: EssecEntry[] = [];
for (const o of all) {
  const req = byUrl.get(o.url);
  if (!req) continue;
  const stub = offHostStub(req, o, fetchedAt);
  if (stub) stubs.push(stub);
}
if (stubs.length > 0) {
  console.log(`\nRecording ${stubs.length} off-ESSEC redirects as stubs (where the link goes, and nothing from the far side)…`);
  for (const s of stubs) {
    saveEntries([s]);
    line("stub", `[${s.section}] ${s.title} → ${s.source.finalUrl}`);
  }
}

// ── names for the course and session entries ────────────────────────────
const renamedCourses = retitleStored(/\/crn\/\d{11}$/, (lines) => {
  // "MACROECONOMICS" / "202600-1724" / "Macroeconomics" / "ECOA-11217 / 202600-1724"
  const proper = lines[2] && !/^\d/.test(lines[2]) ? lines[2] : (lines[0] ?? "");
  const code = lines[3]?.includes("/") ? lines[3] : (lines[1] ?? "");
  return code ? `${proper} — ${code}` : proper;
});
const renamedSessions = retitleStored(/\/agenda\/\d{23}$/, (lines, text) => {
  // parseSessions is the same reader the briefing uses, so a session entry is
  // named with exactly the date and time the briefing would read off it.
  const s = parseSessions(text)[0];
  return s ? `${s.course} — ${s.date} ${s.start}${s.room ? ` · ${s.room}` : ""}` : (lines[0] ?? "");
});
if (renamedCourses + renamedSessions > 0) {
  console.log(`\nNamed ${renamedCourses} course and ${renamedSessions} session entries from their own text (they all arrive titled "MyESSEC").`);
}

const stored = all.filter((o) => o.ok).length;
const after = loadKnowledge().entries;
console.log(
  [
    "",
    `Done. ${stored}/${all.length} pages stored, ${all.length - stored} skipped with a reason above, ${stubs.length} recorded as off-ESSEC stubs.`,
    `The store holds ${after.length} entries (${after.length - before} new), across: ${[...new Set(after.map((e) => e.section))].sort().join(", ")}.`,
    "Every entry carries its URL and the day it was read. Re-run this any time to refresh them in place.",
  ].join("\n"),
);
