// Music tools: the surface that must never surprise him. The AppleScript
// itself only proves itself live (Music.app on this Mac — done by hand, like
// every AppleScript bridge here, per the repo's own rule), so these tests pin
// the CONTRACT only: play is gated (a heartbeat turn must never start sound),
// the controls are not, the confirm card says exactly what will happen, and
// the track picker — the one pure piece — chooses the way he'd expect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { musicTools, pickTrack } from "../src/tools/music.js";
import { capabilitiesSection } from "../src/brain/capabilities.js";
import { Registry } from "../src/core/registry.js";
import { wakeUpSongApproval } from "../src/tools/music.js";

const play = musicTools.find((t) => t.name === "play_music")!;
const control = musicTools.find((t) => t.name === "music_control")!;

test("play_music is gated; music_control is not — sound is the line", () => {
  assert.equal(play.needsConfirmation, true);
  assert.equal(control.needsConfirmation, false);
});

test("the confirm card names the playlist and volume — no surprises at the gate", () => {
  const card = play.confirmIntent!({ playlist: "Clementino Essentials", volume: 35 });
  assert.match(card.human, /Clementino Essentials/);
  assert.match(card.human, /35/);
  const resume = play.confirmIntent!({});
  assert.match(resume.human, /Resume the music/);
  // The audit line names his choice, never a track — track names are his
  // listening history, not gate metadata.
  assert.ok(card.log.includes("play_music"));
  assert.ok(card.log.includes("Clementino Essentials"));
});

// His wake-up song is one track, not a playlist — "Should I Stay or Should I
// Go", asked for on 2026-09-06 — so play_music takes a song. The card must say
// the song (and the artist when he named one), because "play the playlist
// undefined?" is the kind of gate question that gets a reflexive yes.
test("the confirm card names the song when he asked for one", () => {
  const card = play.confirmIntent!({ track: "Should I Stay or Should I Go" });
  assert.match(card.human, /Should I Stay or Should I Go/);
  assert.match(card.human, /song/i);
  assert.doesNotMatch(card.human, /playlist|undefined/);
  assert.ok(card.log.includes("Should I Stay or Should I Go"), "a song he asked for by name is his choice, and the audit names his choice");

  const withArtist = play.confirmIntent!({ track: "Should I Stay or Should I Go", artist: "The Clash", volume: 40 });
  assert.match(withArtist.human, /The Clash/);
  assert.match(withArtist.human, /40/);
});

// The picker runs over what Music.app returned for a substring query, so the
// library's own near-misses are in the list: an exact title must beat a cousin
// that merely contains it, the artist must narrow rather than be ignored (the
// library holds covers), and no match is null — never the first thing in the
// list, which is how a wake-up would open with the wrong song.
test("pickTrack: exact title first, artist narrows, nothing matches → null", () => {
  const lib = [
    { name: "Should I Stay or Should I Go (Remastered)", artist: "The Clash", id: "A" },
    { name: "Should I Stay or Should I Go", artist: "Some Cover Band", id: "B" },
    { name: "Should I Stay", artist: "Gabrielle", id: "C" },
  ];
  assert.equal(pickTrack(lib, "should i stay or should i go")?.id, "B", "exact title, case-insensitive, beats the remaster that contains it");
  assert.equal(pickTrack(lib, "Should I Stay or Should I Go", "clash")?.id, "A", "the artist picks among the titles");
  assert.equal(pickTrack(lib, "should i stay")?.id, "C");
  assert.equal(pickTrack(lib, "should i stay or", "The Clash")?.id, "A", "substring on the title, once the artist has filtered");
  assert.equal(pickTrack(lib, "Rock the Casbah"), null);
  assert.equal(pickTrack(lib, "Should I Stay or Should I Go", "Nirvana"), null, "a named artist that isn't there is a miss, not a cover");
});

// The capabilities prose rides the same stable block as identity. It used to
// say "offer it at wake-up" — the opposite of the wake-up song identity now
// asks for — so the model saw two instructions for the same moment. The
// prose describes the tool; WHEN to play is identity's line alone.
test("the capabilities prose describes the tool's real shape and leaves the wake-up rule to identity", () => {
  const block = capabilitiesSection([]);
  assert.match(block, /play_music/);
  assert.match(block, /track|song/i, "the tool takes a song now");
  assert.doesNotMatch(block, /offer it at wake-up|start music unasked/i, "the wake-up music rule is identity's, and this line contradicted it");
});

// ── the standing yes ────────────────────────────────────────────────────
//
// GATE CHANGE (2026-09-06, his ask): the wake-up song starts on its own — no
// card. It is a standing yes written in CODE for exactly one shape of one
// tool: play_music with this title AND this artist. The registry honours it
// only where a human could have been asked (a confirm hook is installed), so
// the heartbeat's confirm-less registry still auto-denies it — a standing
// check can never start sound in an empty room. Everything else about
// play_music still asks. These tests pin all four edges.

function stubPlay(run: () => Promise<string>) {
  // The real tool's schema, gate, card and standing yes; only run() is stubbed
  // so nothing here touches Music.app.
  return { ...play, run };
}

test("wakeUpSongApproval: the exact shape, title and artist both — nothing looser", () => {
  assert.ok(wakeUpSongApproval({ track: "Should I Stay or Should I Go", artist: "The Clash" }));
  assert.ok(wakeUpSongApproval({ track: "should i stay or should i go (remastered)", artist: "clash" }), "case and the remaster suffix do not matter");
  assert.equal(wakeUpSongApproval({ track: "Should I Stay or Should I Go" }), null, "no artist: a cover could match, so it asks");
  assert.equal(wakeUpSongApproval({ track: "Rock the Casbah", artist: "The Clash" }), null);
  assert.equal(wakeUpSongApproval({ track: "Should I Stay or Should I Go", artist: "Nirvana" }), null);
  assert.equal(wakeUpSongApproval({ playlist: "The Clash" }), null, "a playlist is not the song");
  assert.equal(wakeUpSongApproval({}), null);
});

test("the wake-up song runs without asking on a human channel; every other shape still asks", async () => {
  const asked: string[] = [];
  let ran = 0;
  const reg = new Registry();
  reg.register(stubPlay(async () => { ran++; return "ran"; }));
  reg.confirm = async (_tool, intent) => { asked.push(intent); return true; };

  const song = await reg.execute("play_music", { track: "Should I Stay or Should I Go", artist: "The Clash" });
  assert.equal(song.isError, false);
  assert.equal(song.content, "ran");
  assert.equal(asked.length, 0, "the standing yes: no card for his wake-up song");
  assert.equal(ran, 1);

  await reg.execute("play_music", { track: "Should I Stay or Should I Go" });
  assert.equal(asked.length, 1, "without the artist it asks");
  await reg.execute("play_music", { track: "Rock the Casbah", artist: "The Clash" });
  assert.equal(asked.length, 2, "another song asks");
  await reg.execute("play_music", { playlist: "Clementino" });
  assert.equal(asked.length, 3, "a playlist asks");
  assert.equal(ran, 4, "he said yes each time, so each ran");
});

test("the standing yes never applies where nobody could have been asked: the heartbeat auto-denies the song", async () => {
  let ran = 0;
  const reg = new Registry(); // no confirm hook: the heartbeat's registry
  reg.register(stubPlay(async () => { ran++; return "ran"; }));
  const r = await reg.execute("play_music", { track: "Should I Stay or Should I Go", artist: "The Clash" });
  assert.equal(r.isError, true);
  assert.match(r.content, /NOT done/);
  assert.equal(ran, 0, "sound in an empty room, from a background turn: never");
});
