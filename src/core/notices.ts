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

export function listNotices(includeDismissed = false): Notice[] {
  const all = readJson<Notice[]>(FILE, []);
  return includeDismissed ? all : all.filter((n) => !n.dismissed);
}

export function addNotice(check: string, text: string, loudness: "quiet" | "loud"): Notice {
  const all = readJson<Notice[]>(FILE, []);
  const notice: Notice = {
    id: crypto.randomBytes(3).toString("hex"),
    check,
    text,
    loudness,
    createdAt: new Date().toISOString(),
    dismissed: false,
  };
  all.push(notice);
  writeJson(FILE, all);
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
