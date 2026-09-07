// Music — EVE's hands on his Music.app library. Playlists, playback, and
// nothing else: no buying, no deleting, no touching the library itself.
//
// The gate question is the one that earned this file: is playing music an
// outward action? It sends nothing and costs nothing, but it fills the room
// with sound — on the heartbeat there is no human to ask, so the gate is what
// keeps a heartbeat turn (a standing check, an on-demand brief) from ever
// starting a playlist on its own. Play starts sound: gated. Pause/stop/skip/status/list change nothing that outlives
// the moment: ungated. If he asks for music, call the tool — the gate does the
// asking, per the standing rule; never substitute a verbal double-check. The
// one exception is his wake-up song (WAKE_UP_SONG below): a standing yes.
//
// AppleScript lives in this file's rules: values cross the bridge as ARGV,
// never as interpolated literals (a playlist name with a quote in it must be
// data, not script), and Music gets the ensureAppRunning treatment because a
// closed Music.app refuses one-shot osascript with -600. The playlist MATCH is
// done in TypeScript over the full list, not in a `whose` clause, so the model
// gets the near-misses back and can self-correct in one hop.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { runAppleScript, ensureAppRunning } from "./applescript.js";

const MUSIC_APP = "/System/Applications/Music.app";

async function musicReady(): Promise<void> {
  await ensureAppRunning(MUSIC_APP, "Music");
}

// All playlist names, one per line, from a repeat loop — NOT `name of
// playlists`, which comes back as one comma-joined line and splits a name
// like "Clementino, Sfera & co" in half. Names only: the match below is
// substring-based and duration would be decoration at 90 playlists.
async function listPlaylists(): Promise<string[]> {
  const raw = await runAppleScript(`tell application "Music"
  set out to ""
  repeat with p in playlists
    set out to out & (name of p) & linefeed
  end repeat
  return out
end tell`);
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A library track as the picker sees it: what Music.app returned for a
// substring query, plus the persistent ID that plays exactly that one.
export interface LibraryTrack {
  name: string;
  artist: string;
  id: string;
}

// Candidates for a title come from Music.app's own `whose name contains`
// (case-insensitive, and it does the scan — a large library is not something
// to pull over the bridge line by line). The needle crosses as ARGV, never
// interpolated: a title with a quote in it is data, not script. The control
// char is the separator because titles contain commas and dashes.
async function findTracks(needle: string): Promise<LibraryTrack[]> {
  const raw = await runAppleScript(
    `on run argv
  tell application "Music"
    set out to ""
    repeat with t in (every track of library playlist 1 whose name contains (item 1 of argv))
      set out to out & (name of t) & "\u0001" & (artist of t) & "\u0001" & (persistent ID of t) & linefeed
    end repeat
    return out
  end tell
end run`,
    [needle],
  );
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = "", artist = "", id = ""] = l.split("\u0001");
      return { name, artist, id };
    })
    .filter((t) => t.id !== "");
}

// The picker is pure so the choice can be tested without a library: exact
// title first (case-insensitive), then the first substring match, with the
// artist — when he named one — filtering BEFORE either rule runs. The artist
// is a filter, not a tiebreak: his library holds covers, and "Should I Stay
// or Should I Go" by a cover band is not the song he asked The Clash for. No
// match is null, never the first thing in the list — that is how a wake-up
// would open with the wrong song.
export function pickTrack(tracks: LibraryTrack[], wanted: string, artist?: string): LibraryTrack | null {
  const title = wanted.trim().toLowerCase();
  const by = artist?.trim().toLowerCase() ?? "";
  const pool = by ? tracks.filter((t) => t.artist.toLowerCase().includes(by)) : tracks;
  return (
    pool.find((t) => t.name.toLowerCase() === title) ??
    pool.find((t) => t.name.toLowerCase().includes(title)) ??
    null
  );
}

interface NowPlaying {
  state: string;
  track: string;
  artist: string;
  playlist: string;
}

async function nowPlaying(): Promise<NowPlaying> {
  // The try is not decoration: after `stop` (or on a fresh library) there IS
  // no current track — `current track` is a null placeholder and asking for
  // its name fails with -1700. Watched live in music-live-check.
  const raw = await runAppleScript(`tell application "Music"
  set theState to player state as string
  try
    return theState & "\u0001" & (name of current track) & "\u0001" & (artist of current track) & "\u0001" & (name of current playlist)
  on error
    return theState & "\u0001" & "\u0001" & "\u0001"
  end try
end tell`);
  // Split on a control char because track names contain commas and dashes.
  const [state = "unknown", track = "unknown", artist = "", playlist = ""] = raw.split("\u0001");
  return { state, track, artist, playlist };
}

// Music switches tracks ASYNCHRONOUSLY: `play t` returns before the player
// has moved, and a state read on the very next line reports the old track,
// paused. Watched live in music-live-check: the wake-up song "played" while
// the report named the previous playlist's track, and a second read 100ms
// later said the same — a full second on, it was playing the right song. So
// every report after a play waits for the player to settle on the EXPECTED
// outcome — the caller says what that is — polling up to ~5s. Waiting for
// "playing" alone is not enough: with music already on, the first read is
// "playing" on the OLD track and the report would call the switch a failure.
// Still not there after the cap is reported as such, never papered over.
async function settled(ok: (np: NowPlaying) => boolean): Promise<NowPlaying> {
  let np = await nowPlaying();
  // 20 × 250 ms: a track streamed from Apple Music sat "paused" for more than
  // the original 2 s while it buffered (the 23:43 live run), and the report
  // called it paused when it was starting.
  for (let i = 0; i < 20 && !ok(np); i++) {
    await new Promise((r) => setTimeout(r, 250));
    np = await nowPlaying();
  }
  return np;
}

// His wake-up song — and the ONE standing yes in this file. GATE CHANGE,
// 2026-09-06, his ask: at wake-up the song must start on its own, no card.
// So this exact shape — this title AND this artist, both his words — is
// pre-approved in code. The registry honours it only where a human could
// have been asked (never on the heartbeat's confirm-less registry, so a
// standing check cannot start sound in an empty room), and everything else
// about play_music still asks: the song without the artist (a cover could
// match), another song, a playlist. Changing the song is a gate change —
// surface it separately, per CLAUDE.md.
export const WAKE_UP_SONG = { track: /^should i stay or should i go\b/i, artist: /\bclash\b/i };
export function wakeUpSongApproval(input: Record<string, unknown>): string | null {
  const track = typeof input.track === "string" ? input.track.trim() : "";
  const artist = typeof input.artist === "string" ? input.artist.trim() : "";
  return WAKE_UP_SONG.track.test(track) && WAKE_UP_SONG.artist.test(artist)
    ? "his wake-up song, a standing yes given 2026-09-06"
    : null;
}

export const musicTools: EveTool[] = [
  {
    name: "play_music",
    description:
      "Play music from Umberto's Music.app library. Without arguments, resumes what was playing; with a track (a song title, optionally an artist), finds it in his library and plays it; with a playlist, searches his playlists (substring match) and plays the best one; a number sets the volume (0-100) on the way. Music is personal — when he hasn't named anything and you're choosing for him, pick from his real playlists (list_music first if unsure) and say which one you put on. This fills the room with sound, so it needs his yes.",
    schema: z.object({
      playlist: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Playlist name, or a piece of one — matched against his real playlists."),
      track: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Song title, or a piece of one — matched against the tracks in his library. When both a track and a playlist are given, the track wins."),
      artist: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Narrows a track search to this artist (substring). Only meaningful with `track`."),
      volume: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("Set the volume (0-100) before playing."),
    }),
    needsConfirmation: true,
    standingApproval: wakeUpSongApproval,
    confirmIntent: (input) => {
      const track = input.track ? String(input.track) : null;
      const artist = input.artist ? String(input.artist) : null;
      const playlist = input.playlist ? String(input.playlist) : null;
      const volume = input.volume === undefined ? null : Number(input.volume);
      const vol = volume !== null ? ` at volume ${volume}` : "";
      // The card says the SONG when he asked for one: a song he named is his
      // choice, and a gate question has to be answerable without looking up.
      const what = track
        ? `the song "${track}"${artist ? ` by ${artist}` : ""}`
        : playlist
          ? `the playlist "${playlist}"`
          : null;
      return {
        human: what ? `Play ${what}${vol}?` : `Resume the music${vol}?`,
        log: `play_music ${track ? `track "${track}"${artist ? ` by ${artist}` : ""}` : playlist ? `playlist "${playlist}"` : "(resume)"}${volume !== null ? ` volume ${volume}` : ""}`,
      };
    },
    run: async (input) => {
      await musicReady();
      const wanted = input.playlist ? String(input.playlist) : null;
      const track = input.track ? String(input.track) : null;
      const artist = input.artist ? String(input.artist) : null;
      const volume = input.volume === undefined ? null : Number(input.volume);

      if (volume !== null) {
        await runAppleScript(`on run argv
  tell application "Music" to set sound volume to (item 1 of argv) as integer
end run`, [String(volume)]);
      }

      // A song beats a playlist when both are given: the specific ask wins.
      if (track) {
        const found = await findTracks(track);
        const pick = pickTrack(found, track, artist ?? undefined);
        if (!pick) {
          const near = found.slice(0, 5).map((t) => `"${t.name}" — ${t.artist}`).join(", ");
          return (
            `No song in his library matches "${track}"${artist ? ` by ${artist}` : ""}.` +
            (near ? ` Close: ${near}.` : "") +
            ` Ask him, or try a shorter piece of the title.`
          );
        }
        // Played by persistent ID, the one handle that names exactly the track
        // the picker chose — a second `whose name contains` could land on a
        // different cover than the one he was told about.
        await runAppleScript(`on run argv
  tell application "Music"
    set t to (first track of library playlist 1 whose persistent ID is (item 1 of argv))
    play t
  end tell
end run`, [pick.id]);
        const np = await settled((s) => s.state === "playing" && s.track === pick.name);
        const label = `"${pick.name}"${pick.artist ? ` — ${pick.artist}` : ""}`;
        const vol = volume !== null ? ` Volume ${volume}.` : "";
        // Report what the player SAYS, not what was asked: the name has to
        // match, or he is told a song is on while another one plays.
        if (np.state === "playing" && np.track === pick.name) return `Playing ${label}.${vol}`;
        return (
          `Asked Music to play ${label}, but the player reports ${np.state}` +
          `${np.track ? ` on "${np.track}"` : ""}. Say so rather than claiming it's on.${vol}`
        );
      }

      if (!wanted) {
        await runAppleScript('tell application "Music" to play');
        const np = await settled((s) => s.state === "playing");
        return (
          `Playing. ${np.state === "playing" ? `Now: "${np.track}"${np.artist ? ` — ${np.artist}` : ""} (playlist: ${np.playlist})` : `Player state: ${np.state}`}` +
          (volume !== null ? ` Volume set to ${volume}.` : "")
        );
      }

      const lists = await listPlaylists();
      const needle = wanted.toLowerCase();
      // Exact first, then substring — "clementino" must find "Clementino
      // Essentials" without the model guessing the full name, and an exact
      // name must beat a substring cousin.
      const exact = lists.find((p) => p.toLowerCase() === needle);
      const partial = lists.filter((p) => p.toLowerCase().includes(needle));
      const pick = exact ?? partial[0];
      if (!pick) {
        const near = lists.slice(0, 12).join(", ");
        return `No playlist matches "${wanted}". His playlists include: ${near}${lists.length > 12 ? `, … (${lists.length} total)` : ""}. Ask him which one, or offer to list them all.`;
      }
      await runAppleScript(`on run argv
  tell application "Music" to play playlist (item 1 of argv)
end run`, [pick]);
      const np = await settled((s) => s.state === "playing" && s.playlist === pick);
      const also = partial.length > 1 && !exact
        ? ` (also matched: ${partial.slice(1, 4).join(", ")} — say the word and I'll switch)`
        : "";
      return `Playing "${pick}"${also}. ${np.state === "playing" ? `Starting with "${np.track}"${np.artist ? ` — ${np.artist}` : ""}` : ""}${volume !== null ? ` Volume ${volume}.` : ""}`;
    },
  },
  {
    name: "music_control",
    description:
      "Control what's already playing in Music.app: pause, resume, stop, next/previous track, or just check what's on. Use it when Umberto says 'pause the music', 'skip this', 'what's playing'. Nothing here outlives the moment, so it needs no confirmation.",
    schema: z.object({
      action: z.enum(["pause", "resume", "stop", "next", "previous", "status"]),
    }),
    needsConfirmation: false,
    run: async (input) => {
      await musicReady();
      const action = String(input.action);
      if (action !== "status") {
        await runAppleScript(`on run argv
  tell application "Music" to ${action === "resume" ? "play" : action === "next" ? "next track" : action === "previous" ? "previous track" : action}
end run`);
      }
      const np = await nowPlaying();
      const verbs: Record<string, string> = {
        pause: np.state === "paused" ? "Paused" : `Tried to pause (state: ${np.state})`,
        resume: np.state === "playing" ? "Playing" : `Tried to resume (state: ${np.state})`,
        stop: "Stopped",
        next: "Skipped",
        previous: "Went back",
        status: "",
      };
      const lead = verbs[action] ?? "";
      // Track shown only when there IS one: right after `stop` Music reports
      // state "paused" around a null current track, which rendered as
      // `Holding at "" (playlist: )` — watched live in music-live-check.
      const now =
        np.track && (np.state === "playing" || np.state === "paused")
          ? ` ${np.state === "playing" ? "Now" : "Holding at"} "${np.track}"${np.artist ? ` — ${np.artist}` : ""}${np.playlist ? ` (playlist: ${np.playlist})` : ""}.`
          : "";
      return `${lead}${now}`.trim() || `Player state: ${np.state}.`;
    },
  },
];
