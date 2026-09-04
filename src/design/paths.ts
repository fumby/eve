// Path hygiene shared by every design module: ~ expansion, containment checks
// (the agent and Claude Code write under a project root and nowhere else),
// and slug validation. Pure except for path resolution.
import os from "node:os";
import path from "node:path";
import { ROOT } from "../core/config.js";
import { SLUG_RE } from "./types.js";

// "~/x" → /Users/…/x; relative → under the EVE checkout; absolute stays.
export function expandProjectPath(p: string): string {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (p === "~") return os.homedir();
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(ROOT, p);
}

export class PathError extends Error {}

// Resolves `candidate` (relative to `root`, or absolute) and throws unless the
// result is `root` itself or strictly inside it. Rejects `..` escapes and
// symlink-free lookalike prefixes ("/a/bc" is not inside "/a/b").
export function assertWithinProject(root: string, candidate: string): string {
  const base = path.resolve(root);
  const target = path.resolve(base, candidate);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new PathError(`refusing to touch ${candidate}: outside the project root`);
  }
  return target;
}

export function assertSlug(value: string, what: string): string {
  if (typeof value !== "string" || !SLUG_RE.test(value) || value.length > 64) {
    throw new PathError(`${what} must be kebab-case (a-z, 0-9, hyphens), got ${JSON.stringify(value)}`);
  }
  return value;
}
