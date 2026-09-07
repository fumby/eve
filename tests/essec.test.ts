// The ESSEC knowledge layer. What each test protects, and the failure behind
// it — every one of these is a way the store could quietly become worthless or
// dangerous rather than obviously broken:
//
// 1. Provenance is not optional. An ESSEC "fact" with no URL and no date is
//    indistinguishable from a model inventing a deadline, and Umberto would
//    act on it. The store refuses the entry rather than stamping a default.
// 2. Merge by URL. A seed script is meant to be re-runnable; without a merge
//    key every re-run would append a second copy of every page and the store
//    would fill with stale duplicates that all look equally current.
// 3. The host allowlist. This tool drives the browser holding Umberto's live
//    Gmail/Drive sessions. Ungated + "fetch any URL" is a confused deputy, so
//    the allowlist is checked before Chrome is even started — and a lookalike
//    host (essec.fr.evil.example) must not pass a prefix match.
// 4. The personal-record guard. The FIRST live read of /service/mon-registraire
//    returned his birth date, home address, phone numbers, national student
//    number and his family's contact details. That page must never become an
//    entry: this store is plain text that gets read back into prompts.
// 5. Honest emptiness. A login wall and a blank page are refusals with a
//    reason, never a stored entry — an empty scrape reported as success is how
//    a knowledge store fills up with nothing.
// 6. State isolation — writes land under STATE_ROOT like everything else.
//
// No network and no Chrome anywhere in here: everything the browser touches is
// behind readPage(), and everything worth testing is a pure function beside it.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ESSEC_SECTIONS,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_RENDER_CHARS,
  buildClassesDigest,
  classesToday,
  SCHEMA_VERSION,
  canonicalUrl,
  essecTools,
  isEssecUrl,
  loadKnowledge,
  loginState,
  offHostStub,
  parseSessions,
  personalMarkers,
  refusalReason,
  renderKnowledge,
  saveEntries,
  searchKnowledge,
  stripChrome,
  type BrowseOutcome,
  type BrowseRequest,
  type EssecEntry,
} from "../src/tools/essec.js";
import { STATE_ROOT } from "../src/core/config.js";

const FILE = path.join(STATE_ROOT, "data", "essec-knowledge.json");

function cleanup(): void {
  fs.rmSync(FILE, { force: true });
}

const NOW = "2026-09-06T10:00:00.000Z";

function entry(over: Partial<EssecEntry> = {}): EssecEntry {
  return {
    section: "services",
    title: "Program center GBBA",
    text: "Program center. Key contacts, arrival and integration, course offer, academics.",
    source: { url: "https://my.essec.fr/en/service/program-center-local-bba", fetchedAt: NOW },
    ...over,
  };
}

test("round trip: an entry saves, reads back with its provenance, and lands under STATE_ROOT", () => {
  cleanup();
  const { added, updated } = saveEntries([entry()]);
  assert.equal(added, 1);
  assert.equal(updated, 0);

  const k = loadKnowledge();
  assert.equal(k.schemaVersion, SCHEMA_VERSION);
  assert.equal(k.entries.length, 1);
  assert.equal(k.entries[0]!.source.url, "https://my.essec.fr/en/service/program-center-local-bba");
  assert.equal(k.entries[0]!.source.fetchedAt, NOW);

  // The rendering shows the source, because an answer about his school that
  // can't be traced to a page is the thing this whole layer exists to avoid.
  const rendered = renderKnowledge();
  assert.match(rendered, /Program center GBBA/);
  assert.match(rendered, /source: https:\/\/my\.essec\.fr\/en\/service\/program-center-local-bba \(read 2026-09-06\)/);

  assert.ok(fs.existsSync(FILE), "the store must live under STATE_ROOT, never the real data/");
});

test("a redirect is recorded in the provenance, but the merge key stays the asked-for URL", () => {
  cleanup();
  saveEntries([
    entry({
      title: "Registrar FAQ",
      source: {
        url: "https://my.essec.fr/en/service/faq-registraire",
        fetchedAt: NOW,
        finalUrl: "https://ernest.essec.edu/fr/support/solutions",
      },
    }),
  ]);
  assert.match(renderKnowledge(), /faq-registraire → https:\/\/ernest\.essec\.edu\/fr\/support\/solutions/);
  // Re-reading the same myESSEC link must still merge, even though some final
  // URLs carry a per-session nonce that would otherwise mint a new entry every
  // single run.
  const again = saveEntries([
    entry({
      title: "Registrar FAQ",
      source: {
        url: "https://my.essec.fr/en/service/faq-registraire",
        fetchedAt: NOW,
        finalUrl: "https://ernest.essec.edu/fr/support/solutions?nonce=deadbeef",
      },
    }),
  ]);
  assert.equal(again.added, 0);
  assert.equal(again.updated, 1);
  assert.equal(loadKnowledge().entries.length, 1);
});

test("provenance is enforced at the write: no source, no entry", () => {
  cleanup();
  // No URL at all.
  assert.throws(
    () => saveEntries([{ ...entry(), source: { url: "", fetchedAt: NOW } }]),
    /must carry its source URL and fetch date/,
  );
  // A URL but no date — "read on some unknown day" is not provenance.
  assert.throws(
    () => saveEntries([{ ...entry(), source: { url: "https://my.essec.fr/en/", fetchedAt: "" } }]),
    /must carry its source URL and fetch date/,
  );
  // A section the store doesn't know: it would be unreachable from read/search.
  assert.throws(
    () => saveEntries([{ ...entry(), section: "timetable" as never }]),
    /is not one of/,
  );
  assert.equal(loadKnowledge().entries.length, 0, "a refused entry must leave nothing behind");
});

test("the host allowlist refuses non-ESSEC addresses, including lookalikes", () => {
  assert.equal(isEssecUrl("https://my.essec.fr/en/"), true);
  assert.equal(isEssecUrl("https://moodle.essec.fr/my/"), true);
  assert.equal(isEssecUrl("https://www.essec.edu/en/"), true);
  // The confused-deputy cases: this tool runs inside his logged-in browser.
  assert.equal(isEssecUrl("https://mail.google.com/"), false);
  assert.equal(isEssecUrl("https://essec.fr.evil.example/en/"), false, "a lookalike host must not pass");
  assert.equal(isEssecUrl("https://notessec.fr/"), false, "a suffix match must not pass");
  assert.equal(isEssecUrl("file:///etc/passwd"), false);
  assert.equal(isEssecUrl("not a url"), false);

  cleanup();
  assert.throws(
    () => saveEntries([{ ...entry(), source: { url: "https://mail.google.com/mail/u/0", fetchedAt: NOW } }]),
    /is not an ESSEC address/,
  );
});

test("merge by section + URL: re-running a seed updates in place, it does not duplicate", () => {
  cleanup();
  saveEntries([entry({ text: "first read" })]);
  const second = saveEntries([entry({ text: "second read", source: { url: "https://my.essec.fr/en/service/program-center-local-bba/", fetchedAt: "2026-09-07T09:00:00.000Z" } })]);
  assert.equal(second.added, 0, "a trailing slash is the same page");
  assert.equal(second.updated, 1);

  const k = loadKnowledge();
  assert.equal(k.entries.length, 1);
  assert.equal(k.entries[0]!.text, "second read", "the re-read replaced the text");
  assert.equal(k.entries[0]!.source.fetchedAt, "2026-09-07T09:00:00.000Z", "and moved the date on");

  // A fragment is the same page too (my.essec.fr/en/#calendar is the home page).
  assert.equal(
    canonicalUrl("https://My.Essec.fr/en/service/program-center-local-bba/#contacts"),
    "https://my.essec.fr/en/service/program-center-local-bba",
  );
  // …but the QUERY is load-bearing: the program centre's seven sections differ
  // only by ?category=, and collapsing them would lose six of them.
  saveEntries([entry({ title: "Academics", source: { url: "https://my.essec.fr/en/service/program-center-local-bba/?category=academics", fetchedAt: NOW } })]);
  assert.equal(loadKnowledge().entries.length, 2, "?category= pages are different pages");

  // The same URL under a different section is a different entry on purpose:
  // one page can be both a service and a deadline.
  saveEntries([entry({ section: "deadlines" })]);
  assert.equal(loadKnowledge().entries.length, 3);

  // A confirmation Umberto gave survives the next re-read — it is his fact
  // about the entry, not the page's.
  const stored = loadKnowledge();
  stored.entries[0]!.confirmed = true;
  saveEntries([stored.entries[0]!]);
  saveEntries([entry({ text: "third read" })]);
  assert.equal(loadKnowledge().entries[0]!.confirmed, true, "a re-read must not erase his confirmation");
});

test("one malformed URL hand-edited into the store does not brick every future save", () => {
  cleanup();
  saveEntries([entry()]);
  // The store is a plain JSON file Umberto is invited to edit by hand — that is
  // house doctrine for every state file. A typo in one `url` used to make the
  // merge lookup throw, and that lookup runs for EVERY incoming entry, so a
  // single bad line stopped the tool storing anything ever again.
  const poisoned = JSON.parse(fs.readFileSync(FILE, "utf8"));
  poisoned.entries.push({
    section: "services",
    title: "hand-edited row with a typo",
    text: "typed in by hand at midnight",
    source: { url: "my.essec.fr/oops", fetchedAt: NOW }, // no scheme: new URL() throws on this
  });
  fs.writeFileSync(FILE, JSON.stringify(poisoned, null, 2));

  assert.doesNotThrow(() =>
    saveEntries([entry({ title: "still works", source: { url: "https://my.essec.fr/en/service/klab-data-bases", fetchedAt: NOW } })]),
  );
  assert.ok(
    loadKnowledge().entries.some((e) => e.title === "still works"),
    "a new page must still store alongside an unparseable hand-edited row",
  );
  // And the bad row is inert, not silently merged into by something else.
  assert.equal(loadKnowledge().entries.filter((e) => e.source.url === "my.essec.fr/oops").length, 1);
});

test("a hand-edited row with no source is held aside, not fatal and not deleted", () => {
  cleanup();
  saveEntries([entry()]);
  // The review reproduced this: ONE row without `source` made read, search and
  // every future browse throw, and the tool stopped working while the good
  // entries sat there intact. Losing the row instead would be its own failure —
  // this file is meant to be hand-editable, so a slip must not cost him what he
  // typed.
  const poisoned = JSON.parse(fs.readFileSync(FILE, "utf8"));
  poisoned.entries.push({ section: "services", title: "typed by hand, forgot the source", text: "some note" });
  fs.writeFileSync(FILE, JSON.stringify(poisoned, null, 2));

  const k = loadKnowledge();
  assert.equal(k.entries.length, 1, "the sourceless row must not count as an entry");
  assert.equal(k.ignoredRows.length, 1, "…and must not be thrown away either");
  assert.doesNotThrow(() => renderKnowledge(), "read must still work");
  assert.doesNotThrow(() => searchKnowledge("program"), "search must still work");
  assert.match(renderKnowledge(), /carry no source and are held aside/);

  // A later save keeps the row on disk rather than quietly deleting his edit.
  saveEntries([entry({ title: "a later page", source: { url: "https://my.essec.fr/en/service/klab-data-bases", fetchedAt: NOW } })]);
  const onDisk = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.equal(onDisk.ignoredRows.length, 1, "the hand-edited row survived the next write");
  assert.equal(onDisk.ignoredRows[0].title, "typed by hand, forgot the source");
});

test("the personal guard covers the categories the file promises, and strong ones refuse alone", () => {
  // Both of these were stored before the review: the first matched NO marker at
  // all, the second matched exactly one and the threshold was two.
  const coordinates = [
    "Mes coordonnées",
    "Adresse personnelle : 14 rue des Chênes, 95000 Cergy",
    "Téléphone portable : +33 6 12 34 56 78",
    "Téléphone fixe : +33 1 23 45 67 89",
  ].join("\n");
  assert.ok(personalMarkers(coordinates).length >= 2, `expected markers, got ${JSON.stringify(personalMarkers(coordinates))}`);
  assert.match(String(refusalReason({ url: "https://my.essec.fr/en/service/coordonnees", title: "MyESSEC", text: coordinates, raw: coordinates, hasPasswordField: false, links: [] })), /personal record/);

  // One unambiguous marker is enough on its own — a school page does not print
  // an emergency contact or a national student number in passing.
  const onlyEmergency = "Emergency contact — Marie Rossi — +33 6 00 00 00 00 — mother. Everything else on this page is ordinary school prose about the campus and the library opening hours.";
  assert.equal(personalMarkers(onlyEmergency).length >= 1, true);
  assert.match(String(refusalReason({ url: "https://my.essec.fr/en/x", title: "x", text: onlyEmergency, raw: onlyEmergency, hasPasswordField: false, links: [] })), /personal record/);

  // And the school's own contact page still stores: "address" and "phone
  // number" unqualified are ordinary words on a page about the registrar.
  const schoolContacts = "Program centre key contacts. The registrar's office address is on the ground floor of building B. For the phone number of the programme assistant, see the directory. Opening hours 9-17.";
  assert.equal(refusalReason({ url: "https://my.essec.fr/en/service/pc", title: "Contacts", text: schoolContacts, raw: schoolContacts, hasPasswordField: false, links: [] }), null);
});

test("the credential filter is wired in and fires on a page that renders a password", () => {
  // This guard had NO test at all: the review mutated it to `if (false && …)`
  // and the suite stayed green. It is one of the guards the commit message
  // calls out, and the trade-off it makes (it costs the registrar FAQ) is only
  // defensible if it actually fires.
  const tempPassword =
    "Welcome to ESSEC IT. Your temporary password is Xy7-kq99-Zt and you must change it at first login. " +
    "This page explains how to connect to the student portal for the first time.";
  assert.match(
    String(refusalReason({ url: "https://ernest.essec.edu/support/x", title: "IT", text: tempPassword, raw: tempPassword, hasPasswordField: false, links: [] })),
    /credential filter/,
  );
  // The reason must not echo what tripped it: this string reaches the model and
  // the audit log, and repeating the secret there would defeat the filter.
  const reason = String(refusalReason({ url: "https://ernest.essec.edu/support/x", title: "IT", text: tempPassword, raw: tempPassword, hasPasswordField: false, links: [] }));
  assert.ok(!reason.includes("Xy7-kq99-Zt"), "the refusal must not repeat the credential it refused");
  // An ordinary school page is untouched by it.
  const ordinary = "The K-Lab is open from 8am to 10pm during term. Book a study room through the portal, and ask staff for help with databases.";
  assert.equal(refusalReason({ url: "https://my.essec.fr/en/service/klab", title: "K-Lab", text: ordinary, raw: ordinary, hasPasswordField: false, links: [] }), null);
});

test("search: hits rank title over body, misses say so instead of guessing", () => {
  cleanup();
  saveEntries([
    entry({
      section: "courses",
      title: "Macroeconomics — Antoine Martin",
      text: "Macroeconomics, 7 September 2026, 08:30-11:30, Classroom P.101, Campus Cergy.",
      source: { url: "https://my.essec.fr/en/agenda/20260001724070920260830", fetchedAt: NOW },
    }),
    entry({
      section: "services",
      title: "K-Lab",
      text: "The library. Book a study room, databases, thesis support, workshops.",
      source: { url: "https://my.essec.fr/en/service/klabservicesandcontacts", fetchedAt: NOW },
    }),
  ]);

  const hits = searchKnowledge("macroeconomics");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.entry.title, "Macroeconomics — Antoine Martin");
  assert.ok(hits[0]!.excerpt.length > 0, "a hit carries the excerpt he'd want read out");

  // A word only in the body still hits, and ranks below a title match.
  const room = searchKnowledge("study room");
  assert.equal(room[0]!.entry.title, "K-Lab");

  // A miss is a miss. Nothing invented.
  assert.equal(searchKnowledge("blockchain").length, 0);
  // Too-short queries don't match everything by accident.
  assert.equal(searchKnowledge("a").length, 0);
});

test("the personal-record guard refuses the registrar page, and leaves ordinary pages alone", () => {
  // Verbatim shape of the FIRST live read of /service/mon-registraire — this
  // is the page that made the guard necessary.
  const registrar = [
    "ROSSI Umberto",
    "My profile",
    "My documents",
    "ESSEC Global Bachelor in Business Administration",
    "Identity Information",
    "Birth Date",
    "7/9/2008",
    "Birthplace",
    "Naples (99) Italy",
    "Nationality",
    "Nationality Italian",
    "Enrollment status",
    "En cours de scolarité",
    "INE",
    "253146474FC",
    "Personal E-mail",
    "someone@example.com",
  ].join("\n");
  const markers = personalMarkers(registrar);
  assert.ok(markers.length >= 2, `expected several personal markers, got ${JSON.stringify(markers)}`);
  const reason = refusalReason({ url: "https://my.essec.fr/en/service/mon-registraire", title: "ESSEC", text: registrar, raw: registrar, hasPasswordField: false, links: [] });
  assert.match(String(reason), /personal record/);

  // An ordinary school page is NOT refused — a guard that refuses everything
  // protects nothing, it just empties the store.
  const news =
    "SPECIALISATIONS FORUM | SEPTEMBER 10TH 9 AM - 1.30 PM\n" +
    "Discover the different specializations offered at ESSEC and talk directly to alumni, " +
    "program directors and staff. Thursday 10 September, 9 AM - 1.30 PM, Grand Hall. My account.";
  assert.equal(refusalReason({ url: "https://my.essec.fr/en/news/specialisations-forum/", title: "Forum", text: news, raw: news, hasPasswordField: false, links: [] }), null);

  // One marker alone is not a record: "nationality" turns up in prose about
  // exchanges, and refusing on it would cost the mobility pages.
  assert.equal(
    personalMarkers("Students of any nationality may apply to the exchange programme.").length,
    1,
  );
});

test("honest emptiness: a login wall, a blank page and an empty store all say so", () => {
  cleanup();
  // A login wall is a refusal with a reason, never an entry.
  assert.match(
    String(refusalReason({ url: "https://my.essec.fr/login", title: "Sign in", text: "Sign in to continue to MyESSEC", raw: "Sign in to continue to MyESSEC", hasPasswordField: true, links: [] })),
    /login wall/,
  );
  assert.equal(loginState({ url: "https://my.essec.fr/en/", title: "MyESSEC", text: "", raw: "NOTIFICATIONS 4 CONTACT MY ACCOUNT", hasPasswordField: false, links: [] }), "in");
  assert.equal(loginState({ url: "https://auth.essec.fr/cas/login", title: "Login", text: "", raw: "", hasPasswordField: false, links: [] }), "out");
  assert.equal(loginState({ url: "https://my.essec.fr/en/x", title: "x", text: "some page text with nothing telling", raw: "some page text with nothing telling", hasPasswordField: false, links: [] }), "unknown");

  // A page that came back all but empty is a failure, not knowledge.
  assert.match(
    String(refusalReason({ url: "https://my.essec.fr/en/service/x", title: "MyESSEC", text: "", raw: "My account", hasPasswordField: false, links: [] })),
    /almost no text/,
  );

  // And with nothing stored, read/search tell EVE to say so rather than answer.
  assert.match(renderKnowledge(), /empty/i);
  assert.match(renderKnowledge("courses"), /Nothing stored under "courses"/);
});

test("the login check reads the RAW page, not the stripped one", () => {
  // The bug this pins, caught on the first live run: stripChrome deletes
  // exactly the logged-in furniture — "MY ACCOUNT", "NOTIFICATIONS", "Logout"
  // — so asking the STORED text whether we are logged in answered "unknown"
  // for a session that was working, and the seed stopped with a STOP message
  // on a perfectly good login.
  const rawHome = ["Rechercher", "NOTIFICATIONS", "4", "CONTACT", "MY ACCOUNT", "TOOLS", "FR", "EN", "Macroeconomics", "Campus Cergy"].join("\n");
  const stored = stripChrome(rawHome);
  assert.doesNotMatch(stored, /MY ACCOUNT|NOTIFICATIONS/, "the shell really is stripped out of what gets stored");
  assert.equal(
    loginState({ url: "https://my.essec.fr/en/", title: "MyESSEC", text: stored, raw: rawHome, hasPasswordField: false, links: [] }),
    "in",
    "a logged-in page must still read as logged in after its shell is stripped",
  );
});

test("a myESSEC link that redirects off ESSEC is refused, whatever it lands on", () => {
  // The hole the first live crawl found. myESSEC's "service" pages are mostly
  // redirects: /service/offres-de-monitorat really lands on docs.google.com and
  // /service/forums-et-evenements-carrieres on jobteaser.com — both sites
  // Umberto is logged into in this very profile. Checking the allowlist only on
  // the URL we ASK for is an open redirect straight through it, and this tool
  // would have read one of his Google Sheets into a plaintext store.
  const sheet = {
    url: "https://docs.google.com/spreadsheets/d/1JOE32gI2rLwx6/edit",
    title: "OFFRES DE MONITORATS ESSEC - Google Sheets",
    text: "a spreadsheet of student assistant jobs, and whatever else is in his Drive",
    raw: "a spreadsheet of student assistant jobs, and whatever else is in his Drive",
    hasPasswordField: false,
    links: [],
  };
  assert.match(String(refusalReason(sheet)), /redirects off ESSEC to docs\.google\.com/);
  // Same for a Google Sites page under an essec.edu PATH — the host is what
  // counts, and sites.google.com/essec.edu/… is not an ESSEC host.
  assert.match(
    String(refusalReason({ ...sheet, url: "https://sites.google.com/essec.edu/k-labworkshops/catalog" })),
    /redirects off ESSEC to sites\.google\.com/,
  );
  // A redirect that stays inside ESSEC is fine: /service/faq-registraire really
  // lands on ernest.essec.edu, and that FAQ is exactly what he wants known.
  assert.equal(
    refusalReason({
      ...sheet,
      url: "https://ernest.essec.edu/fr/support/solutions",
      text: "Registrar solutions: certificates, transcripts, how to request a document, and the rest of the FAQ.",
      raw: "Registrar solutions: certificates, transcripts, how to request a document, and the rest of the FAQ.",
    }),
    null,
  );
});

test("the login signal is a password box, not the words 'se connecter'", () => {
  // eduroam.essec.fr's French documentation explains how to *connect to the
  // wifi*. The prose matcher read that as a login wall and threw away 2,854
  // characters of the page he'd actually want.
  const eduroam = {
    url: "https://eduroam.essec.fr/",
    title: "eduroam",
    text: "eduroam permet aux membres d'une institution participante de se connecter au réseau sans fil sécurisé de toute autre institution partenaire.",
    raw: "eduroam permet aux membres d'une institution participante de se connecter au réseau sans fil sécurisé de toute autre institution partenaire.",
    hasPasswordField: false,
    links: [],
  };
  assert.notEqual(loginState(eduroam), "out", "wifi documentation is not a login wall");
  assert.equal(refusalReason(eduroam), null, "and it must be storable");
  // Put a real password box on it and it is a login page, whatever it says.
  assert.equal(loginState({ ...eduroam, hasPasswordField: true }), "out");
});

test("stripChrome removes the WordPress furniture, keeps the page", () => {
  const raw = [
    "Rechercher",
    "NOTIFICATIONS",
    "4",
    "CONTACT",
    "MY ACCOUNT",
    "TOOLS",
    "FR",
    "EN",
    "|",
    "Program center",
    "KEY CONTACTS",
    "ESSEC.FR",
    "ESSEC KNOWLEDGE",
    "Respect for others",
    "Download MYESSEC APP",
    "MYESSEC © GROUPE ESSEC 2024",
  ].join("\n");
  assert.equal(stripChrome(raw), "Program center\nKEY CONTACTS");
  // The © line's year moves every January; the match must not be pinned to it.
  assert.equal(stripChrome("Body text\nMYESSEC © GROUPE ESSEC 2031"), "Body text");

  // The badge is dropped because it FOLLOWS the label, not because it is a
  // small number near the top. The loose version deleted the day out of the
  // news and event cards — the ones stored under "deadlines", where the date
  // is the whole point.
  const newsCard = ["NOTIFICATIONS", "4", "News and events", "12", "September 2026", "Career forum — register before the 10th"].join("\n");
  const kept = stripChrome(newsCard);
  assert.doesNotMatch(kept, /^4$/m, "the notification badge is still dropped");
  assert.match(kept, /^12$/m, "the day of the month must survive");
  assert.match(kept, /September 2026/);
});

test("the store has a cap, and the tool is ungated but withheld from the Factory", async () => {
  cleanup();
  const tool = essecTools.find((t) => t.name === "essec_knowledge");
  assert.ok(tool, "essec_knowledge must exist");
  // Reading pages sends nothing, spends nothing, deletes nothing and changes
  // no setting — the four gate criteria. It is safe ungated ONLY because of
  // the host allowlist, which is why that test above exists.
  assert.equal(tool.needsConfirmation, false);
  // …but it drives the browser holding every session he has: not the Factory's.
  assert.equal(tool.factoryAllowed, false);

  // read on an empty store is an honest answer, not an error.
  const empty = (await tool.run({ action: "read" })) as string;
  assert.match(empty, /empty/i);
  const missed = (await tool.run({ action: "search", query: "erasmus" })) as string;
  assert.match(missed, /Nothing is stored/);

  // browse without a section is refused before any browser is touched.
  await assert.rejects(
    () => tool.run({ action: "browse", url: "https://my.essec.fr/en/" }),
    /needs a section/,
  );
  // …and so is a non-ESSEC address: the allowlist must not depend on Chrome
  // being reachable, or it would only hold on a machine where Chrome runs.
  await assert.rejects(
    () => tool.run({ action: "browse", url: "https://mail.google.com/", section: "misc" }),
    /not an ESSEC address/,
  );

  // The cap: fill to MAX_ENTRIES, then the next one is refused rather than
  // growing a store that costs more to load than it is worth.
  const many: EssecEntry[] = Array.from({ length: MAX_ENTRIES }, (_, i) =>
    entry({ title: `page ${i}`, source: { url: `https://my.essec.fr/en/service/page-${i}`, fetchedAt: NOW } }),
  );
  saveEntries(many);
  assert.equal(loadKnowledge().entries.length, MAX_ENTRIES);
  assert.throws(
    () => saveEntries([entry({ title: "one too many", source: { url: "https://my.essec.fr/en/service/overflow", fetchedAt: NOW } })]),
    new RegExp(`cap ${MAX_ENTRIES}`),
  );
  // An update of an existing page still works at the cap — the ceiling is on
  // how many pages are known, not on keeping them current.
  assert.equal(saveEntries([entry({ title: "page 0 again", source: { url: "https://my.essec.fr/en/service/page-0", fetchedAt: NOW } })]).updated, 1);
});

test("every section name in the schema is one the store accepts", () => {
  cleanup();
  for (const section of ESSEC_SECTIONS) {
    saveEntries([entry({ section, source: { url: `https://my.essec.fr/en/section-${section}`, fetchedAt: NOW } })]);
  }
  assert.equal(loadKnowledge().entries.length, ESSEC_SECTIONS.length);
  cleanup();
});

// ── the timetable, read back out for the briefing ────────────────────────
//
// 7. The briefing speaks these lines out loud as fact, so the parser has to be
//    shape-anchored rather than eager, and the digest has to know the
//    difference between "no classes today" and "the page I stored cannot see
//    today". The myESSEC home page only ever lists the next few sessions: a
//    store read a fortnight ago knows nothing about this morning, and saying
//    "you're free" from it would be a confident lie. None of this touches the
//    browser — buildClassesDigest runs on the heartbeat, and the heartbeat is
//    exactly where crawling his school account unattended is forbidden.

// Verbatim from the first live read of https://my.essec.fr/en/ — including the
// U+2013 en dash in the time ranges and the relative-day headers, which are the
// two things a hand-typed fixture would quietly get wrong.
const HOME_TIMETABLE = [
  "COMING SOON",
  "CALENDAR",
  "TOMORROW",
  "ONSITE",
  "Macroeconomics",
  "7 September 2026",
  "08:30 – 11:30",
  "Classroom P.101 | P | Campus Cergy",
  "Antoine MARTIN",
  "ONSITE",
  "Geopolitics",
  "7 September 2026",
  "13:00 – 16:00",
  "Classroom A.133 | A | Campus Cergy",
  "Josephine STARON",
  "Access Moodle",
  "IN 2 DAYS",
  "ONSITE",
  "Financial Accounting 1",
  "8 September 2026",
  "13:00 – 16:00",
  "Classroom B.223 | B | Campus Cergy",
  "Wolfgang DICK",
].join("\n");

// Verbatim from https://my.essec.fr/en/agenda/20260001724070920260830 — the
// per-session page. It carries the SAME session twice over: once as the machine
// stamp near the top, once as the "Date"/"Schedule" pair below.
const AGENDA_PAGE = [
  "MACROECONOMICS",
  "202600-1724",
  "2026-09-07 08:30",
  "Onsite",
  "Macroeconomics",
  "ECOA-11217 / 202600-1724",
  "Date",
  "7 September 2026",
  "Schedule",
  "08:30 – 11:30",
  "Location",
  "Classroom P.101 | P | Campus Cergy",
  "Antoine MARTIN",
  "antoine.martin@essec.edu",
].join("\n");

test("parseSessions: the home page's unlabelled blocks become sessions, room and professor included", () => {
  const sessions = parseSessions(HOME_TIMETABLE);
  assert.equal(sessions.length, 3, `expected 3 sessions, got ${JSON.stringify(sessions)}`);
  assert.deepEqual(sessions[0], {
    date: "2026-09-07",
    start: "08:30",
    end: "11:30",
    course: "Macroeconomics",
    room: "Classroom P.101 | P | Campus Cergy",
    professor: "Antoine MARTIN",
  });
  // "IN 2 DAYS" / "TOMORROW" sit between blocks and must not be read as a
  // course name — the block is anchored on date-then-time, not on "ONSITE".
  assert.equal(sessions[2]?.course, "Financial Accounting 1", "a relative-day header is not a course");
});

test("parseSessions: an agenda page yields its session once, not twice", () => {
  const sessions = parseSessions(AGENDA_PAGE);
  // The page states the same lecture in two notations. Anchoring the labelled
  // shape on the machine stamp — and requiring the plain shape's time range to
  // sit on the line straight after the date — is what keeps it to one: here the
  // long date is followed by "Schedule", not by a time.
  assert.equal(sessions.length, 1, `expected 1 session, got ${JSON.stringify(sessions)}`);
  assert.deepEqual(sessions[0], {
    date: "2026-09-07",
    start: "08:30",
    end: "11:30",
    course: "Macroeconomics",
    room: "Classroom P.101 | P | Campus Cergy",
    professor: "Antoine MARTIN",
  });
  // The professor's e-mail is on the page and stays out of the session: the
  // briefing says a name out loud, it does not read out an address.
  assert.doesNotMatch(JSON.stringify(sessions[0]), /@essec\.edu/, "a session carries a name, not a mailbox");
});

test("parseSessions: an online session has no room, and still names its teacher", () => {
  // Verbatim from https://my.essec.fr/en/agenda/20260000971160920261315 — his
  // Spanish class, which is ONLINE and so has no "Location" block at all.
  // Anchoring the professor on the room dropped the teacher of every online
  // course in the store; anchoring it on the time as well is what fixed it.
  const online = [
    "ESPAGNOL DÉBUTANT",
    "202600-971",
    "2026-09-16 13:15",
    "Online",
    "Espagnol débutant",
    "LGES-11110 / 202600-971",
    "Date",
    "16 September 2026",
    "Schedule",
    "13:15 – 16:15",
    "Mari Sol GARCIA SOMOZA",
    "dupont@essec.edu",
    "COURSE",
    "TROMBINOSCOPE",
  ].join("\n");
  const [session, ...rest] = parseSessions(online);
  assert.equal(rest.length, 0, "one session, not one per notation of it");
  assert.equal(session?.course, "Espagnol débutant");
  assert.equal(session?.professor, "Mari Sol GARCIA SOMOZA");
  assert.equal(session?.room, "", "an online class has no room, and inventing one would send him to a building");
  assert.doesNotMatch(JSON.stringify(session), /@essec\.edu/, "the name, never the mailbox");
});

test("parseSessions: prose that merely mentions a date and an hour is not a lecture", () => {
  // A real news card off the MyESSEC feed. "9 AM – 1.30 PM" is how the school
  // writes an event time, and it is deliberately not the HH:MM shape a
  // timetable uses — an eager parser would have booked him into a forum.
  const news = ["2026-09-04", "Specialisations Forum | September 10th 9 AM – 1.30 PM", "Read more"].join("\n");
  assert.deepEqual(parseSessions(news), []);
});

test("buildClassesDigest: today's classes come back dated, never passed off as live", () => {
  cleanup();
  saveEntries([
    entry({
      section: "courses",
      title: "MyESSEC home — upcoming classes",
      text: HOME_TIMETABLE,
      source: { url: "https://my.essec.fr/en/", fetchedAt: "2026-09-06T18:47:58.792Z" },
    }),
  ]);
  const digest = buildClassesDigest(new Date("2026-09-07T07:00:00"));
  assert.match(digest, /Macroeconomics/);
  assert.match(digest, /Classroom P\.101/, "the room is the part he actually needs");
  assert.match(digest, /Geopolitics/);
  assert.doesNotMatch(digest, /Financial Accounting/, "tomorrow's class is not today's");
  // The date it was READ is in the line, because the model turns this into
  // speech and a stored page read must never sound like a live lookup.
  assert.match(digest, /2026-09-06/, `the read date must be stated, got: ${digest}`);
  cleanup();
});

test("buildClassesDigest: a timetable that cannot see today says so instead of implying a free day", () => {
  cleanup();
  saveEntries([
    entry({
      section: "courses",
      text: HOME_TIMETABLE,
      source: { url: "https://my.essec.fr/en/", fetchedAt: "2026-09-06T18:47:58.792Z" },
    }),
  ]);
  // Three weeks on. The stored page listed sessions to 8 September and nothing
  // beyond, so it has no opinion about today — and "no classes today" would be
  // a confident lie that costs him a lecture.
  const stale = buildClassesDigest(new Date("2026-09-28T07:00:00"));
  assert.match(stale, /cannot say what he has today/);
  assert.match(stale, /2026-09-08/, "it names the last day it does cover");
  assert.doesNotMatch(stale, /No ESSEC classes today/);

  // Inside the covered window, "nothing today" is a real answer and is given
  // as one — with the window stated so it stays checkable.
  const quiet = buildClassesDigest(new Date("2026-09-06T07:00:00"));
  assert.match(quiet, /No ESSEC classes today/);
  assert.match(quiet, /covers through 2026-09-08/);
  cleanup();
});

test("buildClassesDigest: an empty store adds nothing to the briefing, and only courses are read", () => {
  cleanup();
  // Nothing stored: contribute nothing rather than a sentence about having
  // nothing. The briefing has its own sources; this one simply stays quiet.
  assert.equal(buildClassesDigest(new Date("2026-09-07T07:00:00")), "");

  // A news item filed under deadlines can carry exactly the timetable shape —
  // this one does, verbatim shape and all. It must not become a lecture: the
  // scan is limited to "courses" precisely so the feed cannot invent classes.
  saveEntries([
    entry({
      section: "deadlines",
      title: "Consulting & Finance Career Fair",
      text: ["ONSITE", "Career Fair", "7 September 2026", "09:00 – 17:00", "Campus Cergy", "Careers team"].join("\n"),
      source: { url: "https://my.essec.fr/en/news/consulting-finance-career-fair-2026", fetchedAt: NOW },
    }),
  ]);
  assert.equal(
    buildClassesDigest(new Date("2026-09-07T07:00:00")),
    "",
    "a dated, timed news card in another section must not reach the briefing as a class",
  );
  cleanup();
});

// ── the off-ESSEC stub ───────────────────────────────────────────────────
//
// 8. Most myESSEC /service/… tiles are redirects, and this crawl found the one
//    that matters: /service/gmail lands in his live inbox, in the very browser
//    this tool drives. The host re-check refuses it — but a refusal that leaves
//    no trace is indistinguishable from an empty page, so a STUB is stored
//    saying where the link goes. The stub is the narrowest thing that can be
//    written: a fixed sentence plus an origin. These tests pin that it stays
//    that narrow, because the temptation to "just include a little of the page"
//    is exactly how the boundary would rot.

function outcome(over: Partial<BrowseOutcome> = {}): BrowseOutcome {
  return { url: "https://my.essec.fr/en/service/gmail", section: "services", ok: false, title: "", chars: 0, links: [], ...over };
}

test("offHostStub: a link that leaves ESSEC is recorded as a destination, never as content", () => {
  const req: BrowseRequest = { url: "https://my.essec.fr/en/service/gmail", section: "services", title: "Gmail (ESSEC mail)", note: "His school mailbox." };
  // Verbatim where it actually landed on the live run.
  const stub = offHostStub(req, outcome({ finalUrl: "https://mail.google.com/mail/u/1/", chars: 15751 }), NOW);
  assert.ok(stub, "an off-ESSEC redirect must produce a stub");
  assert.match(stub.title, /leaves ESSEC/);
  assert.match(stub.text, /mail\.google\.com/, "the stub names where the link goes");
  // The origin, and only the origin. The live Sheets and Notebook LM redirects
  // carry document ids in the path, and this store is read back into prompts.
  assert.equal(stub.source.finalUrl, "https://mail.google.com");
  assert.doesNotMatch(stub.source.finalUrl ?? "", /\/mail\/u\//, "the path is dropped, not just the query");
  // The whole point: nothing from the far side. BrowseOutcome carries no page
  // text at all, so the only way content could appear here is if someone added
  // a text field to it — this assertion is the tripwire for that.
  assert.doesNotMatch(stub.text, /15751|inbox|Boîte de réception/i);
  assert.equal(stub.source.url, req.url, "the merge key stays the myESSEC link, so a re-run updates in place");
});

test("offHostStub: a document id in the destination never reaches the store", () => {
  // The real /service/offres-de-monitorat redirect: a Google Sheet of his.
  const stub = offHostStub(
    { url: "https://my.essec.fr/en/service/offres-de-monitorat", section: "services", title: "Student assistant jobs" },
    outcome({ url: "https://my.essec.fr/en/service/offres-de-monitorat", finalUrl: "https://docs.google.com/spreadsheets/d/1JOE32gI2rLwx6rCGn2njwDaF7_Fus3wbI5z5QPqgKk0/edit?pli=1&gid=1960117530" }),
    NOW,
  );
  assert.ok(stub);
  assert.doesNotMatch(`${stub.text} ${stub.source.finalUrl}`, /1JOE32gI2rLwx6rCGn2njwDaF7/, "the sheet id must not be stored anywhere in the entry");
  assert.equal(stub.source.finalUrl, "https://docs.google.com");
});

test("offHostStub: a redirect that stays inside ESSEC is the page it landed on, not a stub", () => {
  // handicap.essec.edu and ernest.essec.edu are real myESSEC redirects that
  // stay on the allowlist. Stubbing those would throw away 5,000 characters of
  // the disability-support page he might actually need.
  assert.equal(offHostStub(entryReq(), outcome({ finalUrl: "https://handicap.essec.edu/", ok: true, chars: 5156 }), NOW), null);
  assert.equal(offHostStub(entryReq(), outcome({ finalUrl: "https://handicap.essec.edu/" }), NOW), null);
  // A page that was stored is never also stubbed over.
  assert.equal(offHostStub(entryReq(), outcome({ ok: true, finalUrl: "https://mail.google.com/" }), NOW), null);
  // No redirect at all: nothing to say.
  assert.equal(offHostStub(entryReq(), outcome(), NOW), null);
  // A destination we cannot parse is a reason to stay quiet, not to guess.
  assert.equal(offHostStub(entryReq(), outcome({ finalUrl: "not a url" }), NOW), null);
});

function entryReq(): BrowseRequest {
  return { url: "https://my.essec.fr/en/service/handicap", section: "services", title: "Disability support" };
}

// 9. A read has a ceiling. renderKnowledge was written against a 27-entry
//    store; the deeper crawl took it to 95, and `read section=courses` — which
//    the daily briefing asks for BY NAME — became 31,000 characters injected
//    into every morning's turn, with the two classes he actually had that day
//    buried in forty course pages. The store is allowed to grow; a single read
//    is not allowed to grow with it, and what is left out has to be said.
test("read is capped, and says what it left out instead of stopping quietly", () => {
  cleanup();
  const filler = "K-Lab opening hours and study room booking. ".repeat(40); // ~1.7k chars
  for (let i = 0; i < 40; i++) {
    saveEntries([
      entry({
        section: "courses",
        title: `Course page ${i}`,
        text: `${filler} entry number ${i}`,
        source: { url: `https://my.essec.fr/en/crn/2026000${String(i).padStart(4, "0")}`, fetchedAt: NOW },
      }),
    ]);
  }
  assert.equal(loadKnowledge().entries.length, 40, "the store itself is not capped by this");

  const rendered = renderKnowledge("courses");
  assert.ok(
    rendered.length < MAX_RENDER_CHARS + 500,
    `a read must stay under the cap; got ${rendered.length} against ${MAX_RENDER_CHARS}`,
  );
  // The cut is stated, with the way to reach what was cut. A render that just
  // stopped would read as "that is everything I know", which is a lie.
  assert.match(rendered, /further entries are stored and not shown/);
  assert.match(rendered, /essec_knowledge\/search/);
  assert.match(rendered, /ESSEC knowledge — 40 entries/, "the header still reports the true total");
  cleanup();
});

test("read always returns at least one whole entry — the cap can never empty an answer", () => {
  cleanup();
  const filler = "K-Lab opening hours and study room booking. ".repeat(40);
  for (let i = 0; i < 40; i++) {
    saveEntries([
      entry({
        section: "courses",
        title: `Course page ${i}`,
        text: `${filler} entry number ${i}`,
        source: { url: `https://my.essec.fr/en/crn/2026000${String(i).padStart(4, "0")}`, fetchedAt: NOW },
      }),
    ]);
  }
  const rendered = renderKnowledge("courses");
  assert.match(rendered, /Course page 0/, "the first entry is always included");
  // Its body too, not just its header — read back through the per-entry
  // truncation (1200 chars), which is why this looks for text near the START
  // of the entry rather than the marker at its end.
  assert.match(rendered, /K-Lab opening hours and study room booking/, "the body comes back, not just the header");

  // What makes the "always at least one" guard hold is that no single entry can
  // outgrow the render cap: saveEntries clips every entry to MAX_ENTRY_CHARS
  // first. That relationship is the load-bearing one, so it is pinned here — if
  // MAX_ENTRY_CHARS is ever raised above MAX_RENDER_CHARS, this fails and
  // whoever raised it has to decide what a read should do about it.
  assert.ok(
    MAX_ENTRY_CHARS < MAX_RENDER_CHARS,
    `one entry (cap ${MAX_ENTRY_CHARS}) must never be able to fill a whole read (cap ${MAX_RENDER_CHARS})`,
  );
  cleanup();
});

// ── the structured reading behind the digest ────────────────────────────
//
// classesToday() is what the digest AND the wake-up context block are built
// from. The digest (for the on-demand brief) adds guidance for the stale case;
// the context block must not — its contract is facts only — so the structured
// form has to carry the status and the dates and nothing about what to say.
test("classesToday: statuses and dates, with no guidance attached", () => {
  cleanup();
  saveEntries([
    entry({
      section: "courses",
      text: HOME_TIMETABLE,
      source: { url: "https://my.essec.fr/en/", fetchedAt: "2026-09-06T18:47:58.792Z" },
    }),
  ]);
  const today = classesToday(new Date("2026-09-07T07:00:00"));
  assert.equal(today.status, "classes");
  assert.equal(today.readDay, "2026-09-06");
  assert.equal(today.coversThrough, "2026-09-08");
  assert.deepEqual(today.today.map((s) => s.course), ["Macroeconomics", "Geopolitics"]);

  const stale = classesToday(new Date("2026-09-28T07:00:00"));
  assert.equal(stale.status, "stale");
  assert.equal(stale.coversThrough, "2026-09-08");
  assert.deepEqual(stale.today, []);
  assert.doesNotMatch(JSON.stringify(stale), /offer|browse|say/i, "guidance lives in the digest, not the reading");

  assert.equal(classesToday(new Date("2026-09-06T07:00:00")).status, "none");
  cleanup();
  assert.equal(classesToday(new Date("2026-09-07T07:00:00")).status, "empty");
});
