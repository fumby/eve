// HomeKit via the macOS Shortcuts CLI. `/usr/bin/shortcuts` lists and runs the
// shortcuts Umberto has installed — many of which drive HomeKit accessories.
// Running a shortcut is an outward action (it can do anything the shortcut
// does), so it stops at the Tier 6 gate; listing is free.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { EveTool } from "../core/registry.js";

const exec = promisify(execFile);

// `shortcuts list` prints one shortcut name per line. A fresh macOS has zero
// shortcuts; an empty list is a valid result, not an error.
async function listAllShortcuts(): Promise<string[]> {
  const { stdout } = await exec("shortcuts", ["list"]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

// Names that look like HomeKit controls. `ac ` keeps a trailing space so we
// don't match "action" or "cache"; the rest are whole-keyword contains.
const HOMEKIT_KEYWORDS = [
  "light",
  "lights",
  "thermostat",
  "music",
  "fan",
  "door",
  "curtain",
  "blind",
  "heating",
  "ac ",
];

export const homekitTools: EveTool[] = [
  {
    name: "list_shortcuts",
    description:
      "List every macOS Shortcut Umberto has installed (by name, one per line). Read-only — use this to discover what's available before running one with run_shortcut.",
    schema: z.object({}),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async () => {
      const names = await listAllShortcuts();
      if (names.length === 0) return "No shortcuts are installed.";
      return names.join("\n");
    },
  },
  {
    name: "run_shortcut",
    description:
      "Run a named macOS Shortcut by exact name. This is an outward action — it does whatever the shortcut does — so it needs Umberto's confirmation first. Use list_shortcuts first if you don't know the exact name.",
    schema: z.object({
      name: z
        .string()
        .min(1)
        .describe("The exact shortcut name to run, e.g. 'Turn Off Bedroom Lights'."),
    }),
    needsConfirmation: true,
    factoryAllowed: false,
    confirmIntent: (input) => {
      const name = String(input.name ?? "");
      return {
        human: `Run the shortcut “${name}”`,
        log: `run_shortcut: ${name}`,
      };
    },
    run: async (input) => {
      const name = String(input.name);
      const { stdout } = await exec("shortcuts", ["run", name]);
      const out = stdout.trim();
      return out
        ? `Ran “${name}”. Output:\n${out}`
        : `Ran “${name}” (no output).`;
    },
  },
  {
    name: "control_home",
    description:
      "List the shortcuts that look like HomeKit controls — names mentioning lights, thermostat, music, fan, door, curtain, blind, heating, or AC. Read-only; use run_shortcut to actually trigger one (which needs confirmation).",
    schema: z.object({}),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async () => {
      const all = await listAllShortcuts();
      const matches = all.filter((name) => {
        const lower = name.toLowerCase();
        return HOMEKIT_KEYWORDS.some((kw) => lower.includes(kw));
      });
      if (matches.length === 0)
        return "No shortcuts look like HomeKit controls.";
      return matches.join("\n");
    },
  },
];
