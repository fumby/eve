// The repo watch: Umberto's GitHub, polled by EVE's heartbeat, filtered hard.
// Signal only — CI failures on protected branches, emergency-branch pushes,
// stale PRs, HIGH+ CVEs, and projects going quietly dead. Noise (green runs,
// dependabot PRs, his own routine pushes, his own PR openings) never pings.
// Every rule is a pure function over fetched JSON so tests need no network;
// this file's only side effects are fetch + data/repo-watch.json.
//
// Every ping is three sentences, per the spec he gave: what happened, why it
// matters, what he'd do next if he were himself. No screenshots, no logs.
import { loadConfig } from "../core/config.js";
import { readJson, writeJson } from "../core/store.js";
import { audit } from "../core/audit.js";

// ---------------------------------------------------------------- state
interface WatchState {
  seenRuns: Record<string, number[]>; // repo -> completed run ids already judged
  seenPushes: Record<string, string[]>; // repo -> emergency push event ids pinged
  pingedAlerts: Record<string, number[]>; // repo -> dependabot alert numbers pinged
  stalePinged: Record<string, string>; // "repo#num" -> updated_at we pinged for
  dormantPinged: Record<string, string>; // repo -> pushed_at we pinged for
  lastSlowSweep: string | null;
  authWarned: boolean;
}

const STATE_FILE = "repo-watch.json";
const SLOW_SWEEP_MINUTES = 15;
const MAX_WATCHED_REPOS = 25; // rate-limit budget: ~2 calls/repo/min fast lane
const KEEP_IDS = 100;

const loadState = (): WatchState =>
  readJson<WatchState>(STATE_FILE, {
    seenRuns: {},
    seenPushes: {},
    pingedAlerts: {},
    stalePinged: {},
    dormantPinged: {},
    lastSlowSweep: null,
    authWarned: false,
  });

// ---------------------------------------------------------------- API shapes (the fields we read)
export interface RunInfo {
  id: number;
  head_branch: string;
  conclusion: string | null;
  name: string;
  head_sha: string;
  actor?: { login?: string };
}
export interface PushEventInfo {
  id: string;
  type: string;
  actor?: { login?: string };
  payload?: { ref?: string };
}
export interface PrInfo {
  number: number;
  title: string;
  updated_at: string;
  user?: { login?: string };
  draft?: boolean;
}
export interface AlertInfo {
  number: number;
  security_advisory?: { severity?: string; cve_id?: string | null; summary?: string };
  dependency?: { package?: { name?: string } };
}
export interface RepoInfo {
  full_name: string;
  archived: boolean;
  pushed_at: string;
  default_branch: string;
}

const BOTS = /\[bot\]$/;
const BAD_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

// ---------------------------------------------------------------- pure rules
export const isEmergencyRef = (ref: string | undefined): boolean =>
  typeof ref === "string" && /^refs\/heads\/(hotfix|rollback)\//.test(ref);

export function judgeRuns(
  runs: RunInfo[],
  watchedBranches: string[],
  seen: number[] | undefined,
): { pings: string[]; seen: number[] } {
  const ids = runs.map((r) => r.id);
  // First sight of a repo is a baseline: record everything, ping nothing —
  // otherwise switching the watcher on would replay months-old failures.
  if (seen === undefined) return { pings: [], seen: ids };
  const seenSet = new Set(seen);
  const pings: string[] = [];
  for (const r of runs) {
    if (seenSet.has(r.id)) continue;
    if (!watchedBranches.includes(r.head_branch)) continue;
    if (!r.conclusion || !BAD_CONCLUSIONS.has(r.conclusion)) continue;
    if (BOTS.test(r.actor?.login ?? "")) continue; // dependabot's own runs are its problem
    pings.push(
      `CI failed on ${r.head_branch} — "${r.name}" (commit ${r.head_sha.slice(0, 7)}${r.actor?.login ? ` by ${r.actor.login}` : ""}). ` +
        `A broken ${r.head_branch} means everyone pulling it inherits the failure. ` +
        `If it were me: open that run, then revert or fix-forward the breaking commit today.`,
    );
  }
  return { pings, seen: [...seen, ...ids.filter((i) => !seenSet.has(i))].slice(-KEEP_IDS) };
}

export function judgePushEvents(
  events: PushEventInfo[],
  seen: string[] | undefined,
): { pings: string[]; seen: string[] } {
  const relevant = events.filter((e) => e.type === "PushEvent" && isEmergencyRef(e.payload?.ref));
  const ids = relevant.map((e) => e.id);
  if (seen === undefined) return { pings: [], seen: ids };
  const seenSet = new Set(seen);
  const pings: string[] = [];
  for (const e of relevant) {
    if (seenSet.has(e.id)) continue;
    const branch = e.payload!.ref!.replace("refs/heads/", "");
    // "Any push" is the spec — his own pushes included, on these branches only.
    pings.push(
      `${e.actor?.login ?? "someone"} pushed to ${branch}. ` +
        `Pushes to hotfix/rollback branches mean a production problem is being fought right now. ` +
        `If it were me: read the branch diff and make sure the fix has a second pair of eyes before it ships.`,
    );
  }
  return { pings, seen: [...seen, ...ids.filter((i) => !seenSet.has(i))].slice(-KEEP_IDS) };
}

export function judgeStalePRs(
  repo: string,
  prs: PrInfo[],
  staleHours: number,
  stalePinged: Record<string, string>,
  now = new Date(),
): string[] {
  const pings: string[] = [];
  const cutoff = now.getTime() - staleHours * 3_600_000;
  for (const pr of prs) {
    if (BOTS.test(pr.user?.login ?? "")) continue; // dependabot PRs: the CVE rule covers what matters
    if (Date.parse(pr.updated_at) > cutoff) continue;
    const key = `${repo}#${pr.number}`;
    // Ping once per stretch of silence: a new ping only after fresh activity
    // goes stale again. (His own PRs count too — a forgotten PR is forgotten.)
    if (stalePinged[key] === pr.updated_at) continue;
    stalePinged[key] = pr.updated_at;
    const days = Math.floor((now.getTime() - Date.parse(pr.updated_at)) / 86_400_000);
    pings.push(
      `PR #${pr.number} "${pr.title}" has had no activity for ${days} day${days === 1 ? "" : "s"}. ` +
        `Stalled PRs rot — conflicts pile up and the context evaporates. ` +
        `If it were me: review and merge it this week, or close it on purpose.`,
    );
  }
  return pings;
}

export function judgeAlerts(
  alerts: AlertInfo[],
  pinged: number[] | undefined,
): { pings: string[]; pinged: number[] } {
  const done = new Set(pinged ?? []);
  const pings: string[] = [];
  const newPinged = [...(pinged ?? [])];
  for (const a of alerts) {
    const sev = (a.security_advisory?.severity ?? "").toLowerCase();
    if (sev !== "high" && sev !== "critical") continue;
    if (done.has(a.number)) continue;
    newPinged.push(a.number);
    const pkg = a.dependency?.package?.name ?? "a dependency";
    const cve = a.security_advisory?.cve_id ? ` (${a.security_advisory.cve_id})` : "";
    pings.push(
      `Dependabot flags ${pkg} — ${sev.toUpperCase()} severity${cve}. ` +
        `A known-exploitable dependency is a standing invitation. ` +
        `If it were me: bump it now, ship, and read the advisory after.`,
    );
  }
  return { pings, pinged: newPinged.slice(-KEEP_IDS) };
}

// "Previously had weekly activity" = at some point, 4+ consecutive weeks each
// containing at least one commit. GitHub's commit_activity gives 52 weeks.
export function hadWeeklyStreak(weeklyTotals: number[], minWeeks = 4): boolean {
  let streak = 0;
  for (const total of weeklyTotals) {
    streak = total > 0 ? streak + 1 : 0;
    if (streak >= minWeeks) return true;
  }
  return false;
}

export function dormancyPing(repo: string, days: number): string {
  return (
    `no commits in ${days} days after a stretch of weekly activity. ` +
    `Projects that go quiet without a decision tend to die by accident. ` +
    `If it were me: decide on purpose — archive it, or put one small commit on the calendar.`
  );
}

// ---------------------------------------------------------------- GitHub client
class GhError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
  }
}

async function gh(path: string, token: string): Promise<unknown> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "EVE-repo-watch",
    },
  });
  if (res.status === 202) return null; // stats still cooking — try next sweep
  if (!res.ok) throw new GhError(res.status, `${res.status} on ${path}`);
  return res.json();
}

// Repo discovery, cached in-process for the slow-sweep period. Exported for
// the dry-run script's report.
let repoCache: { at: number; repos: RepoInfo[] } | null = null;
export async function watchedRepos(token: string): Promise<RepoInfo[]> {
  if (repoCache && Date.now() - repoCache.at < SLOW_SWEEP_MINUTES * 60_000) return repoCache.repos;
  const cfg = loadConfig();
  let repos: RepoInfo[];
  if (cfg.watch.repos.length > 0) {
    repos = [];
    for (const full of cfg.watch.repos) {
      repos.push((await gh(`/repos/${full}`, token)) as RepoInfo);
    }
  } else {
    const all = (await gh(`/user/repos?affiliation=owner&per_page=100&sort=pushed`, token)) as RepoInfo[];
    repos = all.filter((r) => !r.archived).slice(0, MAX_WATCHED_REPOS);
  }
  repoCache = { at: Date.now(), repos };
  return repos;
}

// ---------------------------------------------------------------- the tick
// Returns ping texts (already "repo: what. why. next.") — the heartbeat turns
// each into a notice. dryRun collects without mutating state or config.
export async function repoWatchTick(opts: { dryRun?: boolean } = {}): Promise<string[]> {
  const token = process.env.GITHUB_TOKEN;
  const state = loadState();
  const save = () => {
    if (!opts.dryRun) writeJson(STATE_FILE, state);
  };

  if (!token) {
    if (state.authWarned) return [];
    state.authWarned = true;
    save();
    return [
      "Repo watch is switched on but GITHUB_TOKEN is missing from .env. " +
        "Without it I can't see your repos at all. " +
        "If it were me: create a fine-grained read-only token on github.com and paste it into .env.",
    ];
  }

  const cfg = loadConfig();
  const pings: string[] = [];
  let repos: RepoInfo[];
  try {
    repos = await watchedRepos(token);
  } catch (err) {
    if (err instanceof GhError && err.status === 401 && !state.authWarned) {
      state.authWarned = true;
      save();
      return [
        "GitHub rejected the token in .env (401). " +
          "The watch is blind until it's fixed. " +
          "If it were me: regenerate the token and paste the new one into .env.",
      ];
    }
    audit("repo_watch_error", { error: String(err) });
    return []; // transient network/API trouble: stay quiet, try next tick
  }
  if (state.authWarned) state.authWarned = false; // token works again

  const runSlow =
    !state.lastSlowSweep ||
    Date.now() - Date.parse(state.lastSlowSweep) >= SLOW_SWEEP_MINUTES * 60_000;

  for (const repo of repos) {
    const name = repo.full_name;
    const tag = (texts: string[]) => texts.map((t) => `${name}: ${t}`);

    // -------- fast lane: CI on watched branches + emergency pushes
    try {
      const runsJson = (await gh(
        `/repos/${name}/actions/runs?status=completed&per_page=15`,
        token,
      )) as { workflow_runs: RunInfo[] } | null;
      const judged = judgeRuns(
        runsJson?.workflow_runs ?? [],
        cfg.watch.branches,
        state.seenRuns[name],
      );
      state.seenRuns[name] = judged.seen;
      pings.push(...tag(judged.pings));
    } catch (err) {
      audit("repo_watch_error", { repo: name, lane: "runs", error: String(err) });
    }

    try {
      const events = (await gh(`/repos/${name}/events?per_page=30`, token)) as
        | PushEventInfo[]
        | null;
      const judged = judgePushEvents(events ?? [], state.seenPushes[name]);
      state.seenPushes[name] = judged.seen;
      pings.push(...tag(judged.pings));
    } catch (err) {
      audit("repo_watch_error", { repo: name, lane: "events", error: String(err) });
    }

    if (!runSlow) continue;

    // -------- slow lane: stale PRs, CVEs, dormancy
    try {
      const prs = (await gh(`/repos/${name}/pulls?state=open&per_page=50`, token)) as PrInfo[];
      pings.push(...tag(judgeStalePRs(name, prs, cfg.watch.stalePRHours, state.stalePinged)));
    } catch (err) {
      audit("repo_watch_error", { repo: name, lane: "pulls", error: String(err) });
    }

    try {
      const alerts = (await gh(
        `/repos/${name}/dependabot/alerts?state=open&severity=high,critical&per_page=50`,
        token,
      )) as AlertInfo[];
      const judged = judgeAlerts(alerts, state.pingedAlerts[name]);
      state.pingedAlerts[name] = judged.pinged;
      pings.push(...tag(judged.pings));
    } catch (err) {
      // 403/404 = alerts not enabled or token lacks the scope: silently none.
      if (!(err instanceof GhError && (err.status === 403 || err.status === 404)))
        audit("repo_watch_error", { repo: name, lane: "alerts", error: String(err) });
    }

    try {
      const silentDays = Math.floor((Date.now() - Date.parse(repo.pushed_at)) / 86_400_000);
      if (silentDays >= cfg.watch.dormantDays && state.dormantPinged[name] !== repo.pushed_at) {
        const stats = (await gh(`/repos/${name}/stats/commit_activity`, token)) as
          | { total: number }[]
          | null;
        if (stats && hadWeeklyStreak(stats.map((w) => w.total))) {
          state.dormantPinged[name] = repo.pushed_at;
          pings.push(...tag([dormancyPing(name, silentDays)]));
        }
        // null (202): GitHub is still computing — retry next sweep, invent nothing.
      }
    } catch (err) {
      audit("repo_watch_error", { repo: name, lane: "dormancy", error: String(err) });
    }
  }

  if (runSlow) state.lastSlowSweep = new Date().toISOString();
  save();
  return pings;
}
