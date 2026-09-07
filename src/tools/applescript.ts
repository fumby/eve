// Shared plumbing for the macOS AppleScript bridges. Two things every bridge
// needs, in one place so they cannot drift:
//
//   1. runAppleScript — the ARGUMENT-passing runner. Values ride as argv
//      (`on run argv`), never as string-literal interpolation, so a value
//      containing a quote, newline, or anything else is DATA, not script.
//      (Verified live: quotes, newlines, and leading dashes all pass
//      verbatim.) Scripts that must interpolate use only fixed literals.
//
//   2. ensureAppRunning — Calendar (and other sandboxed Apple apps) refuse
//      one-shot osascript with -600 when they aren't already running, and
//      AppleScript's own `launch` doesn't fix it in a one-shot context
//      (both verified live). `open -g` starts the app in the background
//      without stealing focus; we poll until the process exists, so the
//      common case (already running) costs one fast pgrep and no sleep.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runAppleScript(
  script: string,
  args: string[] = [],
  timeoutMs = 20_000,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2_000_000,
    });
    return stdout.trim();
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    const why = (e.stderr ?? "").trim() || e.message;
    throw new Error(`the AppleScript bridge failed: ${why.slice(0, 200)}`);
  }
}

/** True when a process with exactly this name is running. */
async function isRunning(appName: string): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-x", appName], { timeout: 5_000 });
    return true;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

/**
 * Make sure a bundled Apple app is running before AppleScript talks to it.
 * Fast path: one pgrep when it's already up. Cold path: `open -g`, then
 * poll until the process exists (plus a short settle so it accepts events).
 */
export async function ensureAppRunning(bundlePath: string, appName: string): Promise<void> {
  if (await isRunning(appName)) return;
  try {
    await execFileAsync("open", ["-g", bundlePath], { timeout: 10_000 });
  } catch {
    // `open` failing must not mask the real error — the AppleScript that
    // follows will report what actually went wrong.
    return;
  }
  // Poll for the process, up to ~5s. Calendar starts in well under that.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await isRunning(appName)) {
      await new Promise((r) => setTimeout(r, 400)); // settle: accept events
      return;
    }
  }
  // Still not up: proceed anyway and let the script's own error speak.
}
