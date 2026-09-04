import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from "./atomic.js";

// Project root = two levels up from src/core/
const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");

// Where EVE's MUTABLE state lives: data/, memory/store/, logs/, agent-specs/.
// Defaults to the project itself, so nothing about production changes. The
// check scripts and the test suite point it at a throwaway directory, because
// they used to write over real conversations, real memories and the real audit
// log — see scripts/sandbox.ts and tests/state-isolation.test.ts.
//
// Read-only, code-owned assets stay under ROOT and are NOT affected: brain/,
// memory/core/, board/, face/, mind/, config.json, .env. So does
// scripts/backup-memory.sh, which backs up the real memory and must never
// follow a sandbox.
export const STATE_ROOT = process.env.EVE_STATE_DIR
  ? path.resolve(process.env.EVE_STATE_DIR)
  : ROOT;

// config.json is static, versioned configuration. The few settings EVE changes
// about herself at runtime (kill switch, studies folder, home city) live in
// data/runtime.json instead, so the checkout never gets dirty on a deployed
// box and a `git pull` can't collide with a flag she flipped. Both files stay
// plain JSON you can open and edit by hand.
const RUNTIME_FILE = path.join(STATE_ROOT, "data", "runtime.json");

export interface RuntimeSettings {
  heartbeatPaused?: boolean;
  studiesDir?: string;
  // Typed off Config so the two cannot drift: config.json holds the default,
  // this holds what EVE was told to change it to.
  location?: Config["location"];
  // The project folders EVE may read. Present here means TOTAL REPLACEMENT of
  // the config.json map, not a merge — forgetting a project is a thing Umberto
  // can ask for, and a shallow merge has no way to express a removal.
  projects?: Config["projects"];
}

export function loadRuntime(): RuntimeSettings {
  try {
    return JSON.parse(fs.readFileSync(RUNTIME_FILE, "utf8")) as RuntimeSettings;
  } catch {
    return {};
  }
}

function saveRuntime(patch: RuntimeSettings): void {
  const next = { ...loadRuntime(), ...patch };
  fs.mkdirSync(path.dirname(RUNTIME_FILE), { recursive: true });
  writeFileAtomic(RUNTIME_FILE, JSON.stringify(next, null, 2) + "\n");
}

export interface Config {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  voice: { voiceId: string; ttsModel: string };
  // Scribe (ElevenLabs) is the recognizer of record — 90+ languages with real
  // detection. model/language/keyterms configure the Deepgram socket that
  // still powers live captions while speaking, and the fallback.
  stt: {
    model: string;
    language: string;
    keyterms: string[];
    scribeModel: string;
    diarize: boolean;
  };
  studiesDir: string;
  // The folders EVE may READ as Umberto's projects: slug -> directory,
  // absolute or ~-prefixed. Same shape as design.projects, deliberately — one
  // way of naming a directory in this repo, not two. Every entry is a standing
  // read grant, so the map is small on purpose and grows only through
  // set_project_dir, which is gated. src/projects/read.ts refuses a root that
  // is inside the EVE checkout OR contains it, wherever the entry came from.
  projects: Record<string, string>;
  location: { city: string; lat: number | null; lon: number | null };
  // Languages to search when resolving a city name. Italian is included so
  // "Napoli"/"Roma" resolve to the Italian cities, not same-named villages.
  geocodeLanguages: string[];
  quietHours: { start: string; end: string };
  heartbeat: { paused: boolean; tickSeconds: number; checks: HeartbeatCheck[] };
  confirmOverrides: Record<string, boolean>;
  pricing: { inputPerMTok: number; outputPerMTok: number };
  face: { port: number };
  // Hard per-meeting spend ceiling for the board of advisors. Zero means no
  // meeting can be convened at all — checked before any call, not after.
  board: { maxMeetingUSD: number };
  // Embedding model for semantic memory recall and mind-map edges (Voyage).
  embeddings: { model: string };
  // The agent Factory: guardrails on minting new sub-agents.
  factory: {
    dailyCap: number; // spawn tasks staged per day
    maxRevisions: number; // reject-with-feedback rounds before the task fails
    model: string; // model spawned agents run on
  };
  // The GitHub repo watch (heartbeat check "repo_watch"). Empty repos list =
  // auto-discover everything he owns (non-archived, most recently pushed).
  watch: {
    repos: string[]; // "owner/name" entries; empty = auto
    branches: string[]; // CI failures only on these
    stalePRHours: number;
    dormantDays: number;
  };
  // The head-of-design sub-agent (src/design/). projects maps a slug to the
  // design root that holds design.md, .prism/ and features/ — absolute, ~-
  // prefixed, or relative to ROOT. Every dispatch is capped at maxDispatchUsd
  // (planner + Claude Code composer + images), enforced before and during.
  design: {
    projects: Record<string, string>;
    plannerModel: string;
    composerModel: string;
    maxDispatchUsd: number;
    composerMaxTurns: number;
    imageModels: { standard: string; premium: string };
  };
  memory: {
    // A conversation younger than this is picked back up on restart.
    resumeWindowMinutes: number;
    // Live context keeps at most this many exchanges; older ones stay on disk.
    liveWindowExchanges: number;
    // Past this depth, the per-turn personality self-audit switches on.
    checkpointAfterExchanges: number;
    // Cheap model for the end-of-session memory extractor.
    extractorModel: string;
  };
}

export interface HeartbeatCheck {
  name: string;
  kind: string;
  intervalMinutes: number;
  // "quiet" items go to the notices inbox; "loud" also interrupt (banner + macOS notification)
  loudness: "quiet" | "loud";
  // optional per-kind settings, e.g. { "at": "08:00" } for the daily briefing
  [key: string]: unknown;
}

export function loadEnv(): void {
  try {
    process.loadEnvFile(path.join(ROOT, ".env"));
  } catch {
    // .env missing is fine — keys may come from the environment
  }
}

// Static config with the runtime overrides applied — every reader keeps seeing
// cfg.heartbeat.paused / cfg.studiesDir / cfg.location exactly as before; the
// values in config.json act as defaults when data/runtime.json has nothing to
// say. Both files are hand-editable, so each override is shape-checked rather
// than trusted.
export function loadConfig(): Config {
  const raw = fs.readFileSync(path.join(ROOT, "config.json"), "utf8");
  const cfg = JSON.parse(raw) as Config;
  const rt = loadRuntime();
  if (typeof rt.heartbeatPaused === "boolean") cfg.heartbeat.paused = rt.heartbeatPaused;
  if (typeof rt.studiesDir === "string") cfg.studiesDir = rt.studiesDir;
  if (rt.location && typeof rt.location.city === "string") cfg.location = rt.location;
  // Shape-checked entry by entry, not trusted: data/runtime.json is a plain
  // file a human edits, and a non-string value here would reach path.resolve
  // as an object. A malformed entry is dropped, never crashed on.
  if (rt.projects && typeof rt.projects === "object" && !Array.isArray(rt.projects)) {
    const clean: Record<string, string> = {};
    for (const [slug, dir] of Object.entries(rt.projects)) {
      if (typeof slug === "string" && slug && typeof dir === "string" && dir) clean[slug] = dir;
    }
    cfg.projects = clean;
  }
  cfg.projects ??= {};
  return cfg;
}

// The kill switch flips a persisted flag: /pause survives restarts and is
// visible (and editable) in data/runtime.json.
export function setHeartbeatPaused(paused: boolean): void {
  saveRuntime({ heartbeatPaused: paused });
}

export function setStudiesDir(dir: string): void {
  saveRuntime({ studiesDir: dir });
}

// Both project setters read through loadConfig() rather than loadRuntime(), so
// the first grant carries config.json's seeded projects forward instead of
// replacing the map with a single entry. saveRuntime's shallow merge cannot
// express a removal, which is why the whole map is written each time.
export function setProjectDir(slug: string, dir: string): void {
  saveRuntime({ projects: { ...loadConfig().projects, [slug]: dir } });
}

export function forgetProjectDir(slug: string): boolean {
  const projects = { ...loadConfig().projects };
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so forgetting
  // "constructor" or "toString" reported a revocation that never happened —
  // and pinned the whole map into runtime.json on the way past.
  if (!Object.hasOwn(projects, slug)) return false;
  delete projects[slug];
  saveRuntime({ projects });
  return true;
}

// The home city used for weather in the daily briefing. This used to rewrite
// config.json in place; it lives here now for the same reason the other two do.
export function setLocation(location: Config["location"]): void {
  saveRuntime({ location });
}

export function requireKey(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing ${name}. Add it to ${path.join(ROOT, ".env")} (see .env.example).`,
    );
  }
  return v;
}
