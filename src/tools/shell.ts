// A shell on the world. EVE can run any command — which is exactly why the
// Tier 6 gate is on it: a command can delete files, spend money, or phone
// home. The confirmation prompt shows the EXACT command so Umberto can read
// it before saying yes, and the Factory never hands this to a spawned agent.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { EveTool } from "../core/registry.js";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 8000;

export const shellTools: EveTool[] = [
  {
    name: "run_command",
    description:
      "Run a shell command on this machine via bash -c and return its stdout. " +
      "Use this when Umberto asks you to run, check, or inspect something only a shell can reach — " +
      "git status, a CLI tool, a one-off script, a system check. It needs his confirmation every time. " +
      "Output is truncated to 8000 characters. A command that exits non-zero returns its stderr.",
    schema: z.object({
      command: z
        .string()
        .min(1)
        .describe("The exact command to run, passed to `bash -c`."),
    }),
    needsConfirmation: true,
    factoryAllowed: false,
    confirmIntent: (input) => {
      const command = String(input.command ?? "");
      // The human reads the literal command so he can judge it; the log
      // carries the same string (a shell command is not a secret).
      return {
        human: `Run shell command: \`${command}\``,
        log: `run_command: ${command}`,
      };
    },
    run: async (input) => {
      const command = String(input.command ?? "");
      // execFile never touches a shell itself — we hand it bash -c, so the
      // command runs in a real shell with no further interpolation.
      const { stdout, stderr } = await execFileAsync(
        "bash",
        ["-c", command],
        { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      );
      let out = stdout;
      if (out.length > MAX_OUTPUT) {
        out = out.slice(0, MAX_OUTPUT) + `\n…[truncated, ${out.length} chars total]`;
      }
      if (stderr && stderr.trim()) {
        // Keep stderr visible but compact so a noisy warning doesn't bury the
        // output; it's prefixed so the model can tell the two streams apart.
        const err = stderr.trim().slice(0, 2000);
        out = `${out}${out ? "\n" : ""}[stderr] ${err}`;
      }
      return out || "(no output)";
    },
  },
];
