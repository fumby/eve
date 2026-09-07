#!/usr/bin/env node
// wake-learn.mjs — mines the real Ears log for the wake word's near-misses.
//
// The idea: EVE's wake matcher fires on "greeting + name" with a space
// between. Umberto's human "A-EV" (Neapolitan "a' Eve") arrives FUSED from
// the recogniser — "AEVA", "AEVEVA", "AVA" — one token, no space, no wake.
// Those tokens sit in the log, unmined. This script reads the log, pulls
// every name-shaped token (vowel–v–vowel family) with its counts and
// timestamps, separates the ones that DID wake from the ones that didn't,
// and prints a proposed learned-phrase list — the input the matcher's
// learned set is seeded from.
//
// Mute by construction: reads a file, prints text. Run:
//   node scripts/wake-learn.mjs [--log path] [--min N]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const args = process.argv.slice(2);
const logPath =
  args[args.indexOf("--log") + 1] ?? path.join(os.homedir(), "Library", "Logs", "eve-ears.log");
const minCount = Number(args[args.indexOf("--min") + 1] ?? 2);

// A "name-shaped" word: starts with a vowel, contains a v, ends with a vowel,
// 2–8 chars. Catches eve/eva/evie/eva/ava/aeva/aevaee... rejects
// "even"/"everyone" (consonant after v), "believe" (too long, b start).
const NAME_SHAPED = /^[aei]?[aeiouy]{0,3}v[aeiouy]{0,3}$/i;
const FUSED = /^[aeiouy]{2,8}v[aeiouy]{1,4}$/i; // AEVA, AEVEVA — the A-EV family

const raw = fs.readFileSync(logPath, "utf8");
const lines = raw.split("\n");

const stats = new Map(); // token -> {count, times:[], woke:boolean ever}
let wakes = 0;
let neverminds = 0;

for (const line of lines) {
  const m = line.match(/hearing(?: \(final\))?: (.+)$/);
  if (m) {
    for (const tok of m[1].split(/[^A-Za-z']+|\s+/).filter(Boolean)) {
      if (!NAME_SHAPED.test(tok) && !FUSED.test(tok)) continue;
      const key = tok.toLowerCase();
      const s = stats.get(key) ?? { count: 0, times: [], woke: false };
      s.count++;
      if (s.times.length < 3) s.times.push(line.slice(11, 19));
      stats.set(key, s);
    }
  }
  if (line.includes("heard the phrase")) wakes++;
  if (line.includes("never mind")) neverminds++;
}

// A token heard in the 60 s before a successful wake is a retried attempt —
// the strongest learning signal there is: he said it, it missed, he tried
// again differently.
const wakeTimes = lines
  .filter((l) => l.includes("heard the phrase"))
  .map((l) => new Date(l.slice(0, 10) + l.slice(11, 19) + "Z").getTime())
  .filter((t) => !Number.isNaN(t));

const rows = [...stats.entries()].sort((a, b) => b[1].count - a[1].count);
console.log(`log: ${logPath}`);
console.log(`wakes fired: ${wakes} · "never mind" closes: ${neverminds}`);
console.log(`\nname-shaped tokens the recogniser produced:\n`);
console.log("token        count   last seen");
for (const [tok, s] of rows) {
  console.log(
    `${tok.padEnd(12)} ${String(s.count).padEnd(7)} ${s.times[s.times.length - 1] ?? "?"}`,
  );
}

const learned = rows
  .filter(([tok, s]) => s.count >= minCount && FUSED.test(tok) || (FUSED.test(tok) && s.count >= 1))
  .map(([tok]) => tok);
console.log(`\nproposed learned phrases (fused A-EV family, count ≥ ${minCount}):`);
console.log(learned.length ? learned.join(", ") : "(none yet — the log has no fused tokens)");

const singles = rows.filter(([tok, s]) => s.count >= minCount && !FUSED.test(tok));
if (singles.length) {
  console.log(`\nsingle-word name tokens (risky as wake words alone — review by hand):`);
  for (const [tok, s] of singles) console.log(`  ${tok} ×${s.count}`);
}
