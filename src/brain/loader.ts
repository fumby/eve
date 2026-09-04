// Mtime-cached file reads for the brain's prose files (identity, core
// knowledge). Files are re-read only when their modification time changes, so
// per-turn prompt assembly costs a stat(), not a read — while an edit still
// lands on the very next turn.
import fs from "node:fs";

interface Cached {
  mtimeMs: number;
  text: string;
}

const cache = new Map<string, Cached>();

// Returns the file's text, or "" if it doesn't exist (a missing prose file
// must never crash a turn — the prompt just goes without that section).
export function readFresh(path: string): string {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(path).mtimeMs;
  } catch {
    cache.delete(path);
    return "";
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.text;
  const text = fs.readFileSync(path, "utf8");
  cache.set(path, { mtimeMs, text });
  return text;
}
