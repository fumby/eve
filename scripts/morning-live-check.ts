// Live check for the morning flow: sandbox state, real model, real tools,
// and the one trigger the brief has — his wake-up words ("I just woke up" →
// wakeUpSignal fires; a first message that isn't that never briefs, and
// tests/morning.test.ts pins that half without a paid turn). Proves the BEHAVIOUR the unit
// tests can't: that "I just woke up" produces the spoken morning brief —
// weather, the day's classes read off the context block (seeded below into
// the sandbox store, so the model has something to read without the browser),
// the schedule — and reaches for his wake-up song. The song is gated and this
// harness has no confirm function, so play_music is auto-denied here: the
// CALL is what's asserted, never the sound. Run by hand:
//   node --import tsx scripts/morning-live-check.ts
import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
import { loadEnv } from "../src/core/config.js";
import { Agent } from "../src/core/agent.js";
import { Registry } from "../src/core/registry.js";
import { localDate } from "../src/core/time.js";
import { addNotice } from "../src/core/notices.js";
import { weatherTools } from "../src/tools/weather.js";
import { calendarTools } from "../src/tools/calendar.js";
import { reminderTools } from "../src/tools/reminders.js";
import { essecTools, saveEntries } from "../src/tools/essec.js";
import { musicTools } from "../src/tools/music.js";
import { commitmentTools } from "../src/tools/commitments.js";
import { decisionTools } from "../src/tools/decisions.js";
import { noteTools } from "../src/tools/notes.js";
import { upsertStandingCheck } from "../src/tools/standing-checks.js";
import { runAppleScript } from "../src/tools/applescript.js";

loadEnv();

// Seed the sandbox with a class TODAY (the per-session agenda-page shape
// parseSessions knows) and one standing watch with a recent finding, so the
// context block has both readings to carry. Nothing real is touched: the
// sandbox import above put every write path in a throwaway directory.
const today = localDate(new Date());
saveEntries([
  {
    section: "courses",
    title: "Macroeconomics — session (live-check fixture)",
    text: [
      "MACROECONOMICS",
      `${today} 08:30`,
      "Onsite",
      "Macroeconomics",
      "Date",
      "Schedule",
      "08:30 – 11:30",
      "Location",
      "Classroom P.101 | P | Campus Cergy",
      "Antoine MARTIN",
    ].join("\n"),
    source: { url: "https://my.essec.fr/en/agenda/live-check", fetchedAt: new Date().toISOString() },
  },
]);
upsertStandingCheck({ mission: "watch the Paris weather for storms and cold snaps", intervalMinutes: 720, slug: "weather-paris" });
addNotice("standing:weather-paris", "Rain from 14:00 — take the umbrella.", "loud");

const registry = new Registry();
for (const t of [
  ...weatherTools,
  ...calendarTools,
  ...reminderTools,
  ...essecTools,
  ...musicTools,
  ...commitmentTools,
  ...decisionTools,
  ...noteTools,
])
  registry.register(t);

// The gate, with a spy: the song must run WITHOUT asking (its standing yes),
// so any card that appears is recorded and, for everything but the song,
// answered no — this check must never send, spend, or browse on his behalf.
const asked: string[] = [];
registry.confirm = async (tool, intent) => {
  asked.push(`${tool}: ${intent}`);
  return false;
};
// Music at volume 0 for the duration: the song really starts, silently.
const volumeBefore = await runAppleScript('tell application "Music" to sound volume as string');
await runAppleScript('tell application "Music" to set sound volume to 0');
const restoreVolume = () => runAppleScript(`tell application "Music" to set sound volume to ${Number(volumeBefore) || 62}`);

const toolCalls: string[] = [];
const agent = new Agent(registry, "typed");

// The wake-up moment: his words carry the trigger, so the context block gets
// "Sveglia: …" plus the two readings seeded above (and, the sandbox store
// being empty, "Primo scambio di oggi" — which on its own would NOT brief).
const reply = await agent.runTurn("Eve, I just woke up.", {
  onToolCall: (name) => toolCalls.push(name),
});

console.log("=== TOOL CALLS ===");
console.log(toolCalls.join("\n") || "(none)");
console.log("\n=== EVE'S REPLY ===");
console.log(reply);

// The assertions that make this a check, not a demo.
let failed = false;
const weather = toolCalls.includes("get_weather") || /°|degree|celsius|gradi/i.test(reply);
console.log(`\nweather reached: ${weather}`);
if (!weather) {
  console.error("❌ no weather in the wake-up reply — the morning ritual did not fire");
  failed = true;
}
// The class rides the context block, not a tool: the reply must carry it even
// though the model may never have called essec_knowledge.
const classes = /macroeconom|P\.101/i.test(reply);
console.log(`today's class in the reply: ${classes}`);
if (!classes) {
  console.error("❌ the seeded class never reached the reply — the morning readings are not landing");
  failed = true;
}
// The song: identity says put it on when he says he just woke up, and the
// standing yes means NO card. The evidence is threefold: the call happened,
// no confirm was requested for it, and Music.app is actually playing it.
const song = toolCalls.includes("play_music");
console.log(`wake-up song attempted: ${song}`);
if (!song) {
  console.error("❌ play_music was never called — the wake-up song is not part of the morning");
  failed = true;
}
const songAsked = asked.filter((a) => a.startsWith("play_music"));
console.log(`gate cards shown: ${asked.length === 0 ? "(none)" : asked.join(" | ")}`);
if (songAsked.length > 0) {
  console.error("❌ the wake-up song asked for a yes — the standing approval did not apply");
  failed = true;
}
const status = await musicTools.find((t) => t.name === "music_control")!.run({ action: "status" });
console.log(`Music.app: ${status}`);
// "Now …" is the player PLAYING; "Holding at …" is paused on it — which the
// 23:43 run reported and this check wrongly let through. Only "Now" counts.
if (!/^Now "Should I Stay or Should I Go/.test(status)) {
  console.error(`❌ Music.app is not playing the wake-up song (status: ${status})`);
  failed = true;
}
await musicTools.find((t) => t.name === "music_control")!.run({ action: "stop" });
await restoreVolume();
console.log(`(Music volume restored to ${volumeBefore})`);
if (failed) process.exit(1);
console.log("✅ morning flow verified live — brief, song without a card, readings");
