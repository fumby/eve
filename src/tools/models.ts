// Model switching: Umberto tells EVE which model to run on, and she can
// look up what's available and suggest a better fit. set_model is gated —
// changing which brain she thinks with is a setting change (Tier 6), and it
// has a real cost consequence (max-effort Fable is several times the price
// of low-effort Sonnet), so Umberto sees exactly what he's choosing.
//
// The choice persists in data/runtime.json (config.json stays read-only,
// invariant 4) and applies from the NEXT turn — loadConfig() is re-read every
// turn, so no restart. The provider's sticky fallback slot is reset too, or
// an old outage could keep deciding the entry point after a human choice.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { loadConfig, setModel, requireKey, type Config } from "../core/config.js";
import { resetChain } from "../core/provider.js";
import { audit } from "../core/audit.js";
import { addNotice } from "../core/notices.js";

interface ModelInfo {
  id: string;
  display_name?: string;
  created_at?: string;
  capabilities?: {
    effort?: { supported?: boolean; low?: boolean; medium?: boolean; high?: boolean; xhigh?: boolean; max?: boolean };
  };
}

async function fetchModels(): Promise<ModelInfo[]> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
    headers: {
      "x-api-key": requireKey("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`the model list query failed (${res.status})`);
  const j = (await res.json()) as { data?: ModelInfo[] };
  return j.data ?? [];
}

// One line per model, newest first, with the effort ceiling and the flag for
// the one currently in use — the shape Umberto can read aloud in one breath.
function renderModels(models: ModelInfo[], current: string): string {
  const lines = models.map((m) => {
    const caps = m.capabilities?.effort;
    const ceiling = caps?.max ? "max" : caps?.xhigh ? "xhigh" : caps?.high ? "high" : caps?.medium ? "medium" : caps?.low ? "low" : "none";
    const me = m.id === current ? " ← you are here" : "";
    return `  • ${m.id} (${m.display_name ?? "unnamed"}, effort up to ${ceiling}${m.created_at ? `, since ${m.created_at.slice(0, 10)}` : ""})${me}`;
  });
  return `Available models, newest first:\n${lines.join("\n")}\n\nYou are running ${current} at effort ${loadConfig().effort}.`;
}

export const modelTools: EveTool[] = [
  {
    name: "list_models",
    description:
      "List the models available from the provider, with each one's effort ceiling, and which one EVE is running on right now. Use it when Umberto asks what models there are, what she's running on, or before suggesting a switch. Read-only — switching is set_model, which asks him first.",
    schema: z.object({}),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async () => {
      const current = loadConfig().model;
      const models = await fetchModels();
      if (models.length === 0) return `No models came back from the provider — you are on ${current}.`;
      return renderModels(models, current);
    },
  },
  {
    name: "set_model",
    description:
      "Switch which model EVE runs on, and at what effort — applies from your next reply, no restart. Use it when Umberto tells you to run on a specific model ('run on opus', 'use max effort'), or after you've suggested a better one and he agreed. Changing this changes what every future turn costs, so it always asks him first with the exact model and effort. If you believe a different model would do the CURRENT job better, say so in your reply and offer to switch — but never switch without his explicit go-ahead.",
    schema: z.object({
      model: z.string().min(1).describe("The model id exactly as list_models shows it, e.g. 'claude-opus-5' or 'claude-fable-5-1'."),
      effort: z
        .enum(["low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("The effort level. Omit to keep the current one."),
    }),
    needsConfirmation: true,
    factoryAllowed: false,
    confirmIntent: (input) => {
      const model = String(input.model);
      const effort = input.effort ? String(input.effort) : `(keeping ${loadConfig().effort})`;
      return {
        human: `Switch EVE to run on ${model} at effort ${effort}?\n\nThis changes what every future turn costs — max effort on the largest models is several times the price of low effort. It applies from the next reply.`,
        log: `set_model ${model} effort ${input.effort ?? "(unchanged)"}`,
      };
    },
    run: async (input) => {
      const model = String(input.model);
      const effort = input.effort ? (String(input.effort) as Config["effort"]) : undefined;

      // Validate against the live list: a typo in the model name would
      // otherwise persist into runtime.json and only surface as an error on
      // his NEXT turn, after the gate's yes was already spent.
      const models = await fetchModels();
      const known = models.find((m) => m.id === model);
      if (!known) {
        throw new Error(
          `"${model}" isn't a model the provider offers — call list_models for the exact ids. Nothing was changed.`,
        );
      }
      // Effort ceiling check, same reason: max on a model that tops out at
      // high would be refused by the API one turn later.
      if (effort) {
        const caps = known.capabilities?.effort;
        const allowed = ["low", "medium", "high", "xhigh", "max"] as const;
        const ceiling = allowed.filter((e) => caps?.[e]).pop();
        if (caps && !caps[effort]) {
          throw new Error(
            `${model} doesn't support effort ${effort}${ceiling ? ` — it goes up to ${ceiling}` : ""}. Nothing was changed.`,
          );
        }
      }

      setModel(model, effort);
      resetChain(); // a stale fallback slot must not outvote the human choice
      audit("model_switched", { model, effort: effort ?? "(unchanged)", via: "set_model" });
      const what = `${model}${effort ? ` at effort ${effort}` : ""}`;
      addNotice("model", `Switched to ${what} — applies from the next reply.`, "quiet");
      return `Done — running on ${what} from the next reply. Tell Umberto the switch is live and that the old model is one conversation away if he wants it back.`;
    },
  },
];
