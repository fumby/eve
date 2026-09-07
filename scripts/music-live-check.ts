// Live check for the music tools against the real Music.app — run by hand:
//   node --import tsx scripts/music-live-check.ts
// Follows the repo rule that no AppleScript bridge is done until watched
// against the real app. PLAY IS NOT EXERCISED here beyond a momentary play of
// the FIRST playlist at zero volume, immediately paused and restored — sound
// filling the room is the one thing this check must never do to him.
import { musicTools } from "../src/tools/music.js";

const play = musicTools.find((t) => t.name === "play_music")!;
const control = musicTools.find((t) => t.name === "music_control")!;

const run = async (label: string, fn: () => Promise<string>) => {
  const out = await fn();
  console.log(`\n[${label}]\n${out}`);
};

// Remember the volume so the check leaves the room as it found it.
let before: string | null = null;
try {
  before = await runAppleScriptVolumeGet();
} catch {
  /* Music may be closed; the tools start it. */
}

await run("status", () => control.run({ action: "status" }));
await run("pause (safe, nothing playing or not)", () => control.run({ action: "pause" }));
await run("play nonexistent playlist (contract: guidance, not error)", () =>
  play.run({ playlist: "zzz-no-such-playlist-xyz" }),
);
await run("play 'Clementino' partial match, volume 0 (momentary, paused right after)", async () => {
  const out = await play.run({ playlist: "Clementino", volume: 0 });
  await control.run({ action: "pause" });
  return out;
});
// His wake-up song (2026-09-06): one track, by title and artist, through the
// same gate-side path the morning uses — at volume 0, stopped right after.
await run("play the wake-up song by title + artist, volume 0 (momentary, stopped right after)", async () => {
  const out = await play.run({ track: "Should I Stay or Should I Go", artist: "The Clash", volume: 0 });
  const status = await control.run({ action: "status" });
  await control.run({ action: "stop" });
  return `${out}\n${status}`;
});
await run("play a song that isn't in the library (contract: guidance, not error)", () =>
  play.run({ track: "zzz-no-such-song-xyz" }),
);
await run("play a real title with the wrong artist (contract: a miss, never a cover)", () =>
  play.run({ track: "Should I Stay or Should I Go", artist: "Nirvana" }),
);
await run("resume then stop", async () => {
  const a = await control.run({ action: "resume" });
  const b = await control.run({ action: "stop" });
  return `${a}\n${b}`;
});
if (before !== null) {
  // Raw osascript on purpose: play.run({volume}) with no playlist RESUMES
  // playback — fine when he asked for music, wrong when a check script is
  // putting the room back as it found it.
  await runAppleScriptVolumeSet(Number(before));
  console.log(`(volume restored to ${before})`);
}
console.log("\nOK — every path ran against the real Music.app.");

async function runAppleScriptVolumeGet(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync("osascript", [
    "-e",
    'tell application "Music" to sound volume as string',
  ]);
  return stdout.trim();
}

async function runAppleScriptVolumeSet(v: number): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("osascript", ["-e", `tell application "Music" to set sound volume to ${v}`]);
}
