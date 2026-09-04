// Tiny JSON persistence helpers. Everything EVE stores is pretty-printed and
// human-readable — you can always open data/ files and edit them by hand.
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT } from "./config.js";
import { writeFileAtomic } from "./atomic.js";

export const DATA_DIR = path.join(STATE_ROOT, "data");

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(path.join(DATA_DIR, file), JSON.stringify(value, null, 2) + "\n");
}
