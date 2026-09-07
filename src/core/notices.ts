// The notices inbox: everything proactive lands here first, so nothing EVE
// notices while you're away is ever lost. Loud items ALSO interrupt; quiet
// ones wait to be seen. All of it is dismissible.
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { readJson, writeJson } from "./store.js";

export interface Notice {
  id: string;
  check: string;
  text: string;
  loudness: "quiet" | "loud";
  createdAt: string;
  dismissed: boolean;
}

const FILE = "notices.json";
// The inbox is a UI surface, not an archive. An unbounded file made 427
// notices pile up in six weeks (405 of them one reminder re-pinging), and
// every open tab re-renders the whole list on every snapshot.
const MAX_OPEN = 60; // newest kept when the open set overflows
const MAX_DISMISSED_AGE_DAYS = 3; // dismissed items leave the file after this

export function listNotices(includeDismissed = false): Notice[] {
  const all = readJson<Notice[]>(FILE, []);
  return includeDismissed ? all : all.filter((n) => !n.dismissed);
}

export function addNotice(check: string, text: string, loudness: "quiet" | "loud"): Notice {
  const all = readJson<Notice[]>(FILE, []);

  // DEDUPE: an identical OPEN notice already says this. Re-adding it is how
  // one overdue reminder became 405 entries — the heartbeat re-fires every
  // few minutes, and each fire minted a fresh row with a fresh id, so the
  // inbox filled with the same sentence hundreds of times. Refresh the
  // existing one instead of growing the pile.
  const dupe = all.find((n) => !n.dismissed && n.check === check && n.text === text);
  if (dupe) return dupe;

  const notice: Notice = {
    id: crypto.randomBytes(3).toString("hex"),
    check,
    text,
    loudness,
    createdAt: new Date().toISOString(),
    dismissed: false,
  };
  all.push(notice);

  // PRUNE: dismissed items age out of the file; open items overflow by age.
  // Oldest-first dismissal keeps the newest 60 open — the ones a human is
  // actually going to scroll to.
  const cutoff = Date.now() - MAX_DISMISSED_AGE_DAYS * 86_400_000;
  const kept = all.filter((n) => !(n.dismissed && Date.parse(n.createdAt) < cutoff));
  const open = kept.filter((n) => !n.dismissed);
  if (open.length > MAX_OPEN) {
    const dropIds = new Set(open.slice(0, open.length - MAX_OPEN).map((n) => n.id));
    for (const n of kept) if (dropIds.has(n.id)) n.dismissed = true;
  }
  writeJson(FILE, kept);
  return notice;
}

export function dismissNotice(id: string): boolean {
  const all = readJson<Notice[]>(FILE, []);
  const n = all.find((x) => x.id === id);
  if (!n || n.dismissed) return false;
  n.dismissed = true;
  writeJson(FILE, all);
  return true;
}

export function dismissAll(): number {
  const all = readJson<Notice[]>(FILE, []);
  let count = 0;
  for (const n of all) if (!n.dismissed) ((n.dismissed = true), count++);
  writeJson(FILE, all);
  return count;
}

// OS-level banner for loud items, best-effort and never able to crash the
// loop: macOS gets a Notification Center banner, a Linux desktop gets
// notify-send if it exists, and a headless server gets nothing here — the
// face server separately pushes every loud notice to connected browsers,
// which is how a phone or another Mac on the tailnet hears about it.
export function osNotification(text: string): void {
  const safe = text.replace(/[\\"]/g, " ").slice(0, 180);
  if (process.platform === "darwin") {
    execFile("osascript", ["-e", `display notification "${safe}" with title "EVE"`], () => {});
  } else if (process.platform === "linux") {
    execFile("notify-send", ["EVE", safe], () => {});
  }
}
