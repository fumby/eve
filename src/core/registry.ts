// The tool registry: EVE's hands. Adding a capability means writing one
// self-contained tool and registering it here — never editing the agent loop.
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolProvider } from "./agent.js";
import { loadConfig } from "./config.js";
import { audit } from "./audit.js";
import { addNotice } from "./notices.js";

export interface EveTool {
  name: string;
  // Written for a reader: what it does AND when to reach for it.
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  // Consequential tools (send/spend/delete/change-a-setting) are flagged here;
  // the Tier 6 gate stops them until Umberto says yes. A FUNCTION makes the
  // gate conditional on the arguments — for tools that are ordinary almost
  // always and consequential in one specific shape. It is evaluated once, on
  // Zod-parsed input, before run() is ever called.
  needsConfirmation: boolean | ((input: Record<string, unknown>) => boolean);
  // How this call is described at the gate. `human` is what Umberto reads, and
  // may quote the content he needs in order to judge; `log` is what reaches
  // logs/audit.jsonl and the notices inbox, and must NEVER carry content that
  // shouldn't be persisted in plaintext. Omit it and both default to the tool
  // name plus its JSON arguments, as before.
  confirmIntent?(input: Record<string, unknown>): { human: string; log: string };
  // May the Factory hand this tool to agents it spawns? Absent = derived:
  // confirmation-gated tools and anything secrets/settings/spend-adjacent are
  // withheld by default; everything else is offered. Set explicitly to opt
  // in or out regardless of the default.
  factoryAllowed?: boolean;
  run(input: Record<string, unknown>): Promise<string>;
}

// The default policy the Factory applies when a tool doesn't say. Kept as a
// pure function so it's testable and visible in one place.
const FACTORY_WITHHELD = /^(set_|forget_|design_|convene_board$|query_ledger$|dispatch_to_)/;
export function isFactoryAllowed(tool: EveTool): boolean {
  if (typeof tool.factoryAllowed === "boolean") return tool.factoryAllowed;
  // `=== true`, not truthy: a CONDITIONAL gate depends on arguments we don't
  // have here, and a tool that is consequential only in one rare shape stays
  // offered — the gate still fires per call inside execute(), and on a registry
  // with no human attached that means auto-deny, never a silent run.
  if (tool.needsConfirmation === true) return false;
  return !FACTORY_WITHHELD.test(tool.name);
}

export type ConfirmFn = (toolName: string, intent: string) => Promise<boolean>;

export class Registry implements ToolProvider {
  private tools = new Map<string, EveTool>();
  // Installed by the Tier 6 gate; until then, flagged tools run freely.
  confirm: ConfirmFn | null = null;

  register(tool: EveTool): void {
    this.tools.set(tool.name, tool);
  }

  // Archived Factory agents lose their dispatch tool live, no restart.
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  all(): EveTool[] {
    return [...this.tools.values()];
  }

  definitions(): Anthropic.Messages.ToolUnion[] {
    return [...this.tools.values()].map((t) => {
      const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
      delete schema.$schema;
      return {
        name: t.name,
        description: t.description,
        input_schema: schema as Anthropic.Tool.InputSchema,
      };
    });
  }

  async execute(name: string, input: unknown): Promise<{ content: string; isError: boolean }> {
    const tool = this.tools.get(name);
    if (!tool) return { content: `No tool named "${name}" exists.`, isError: true };

    const parsed = tool.schema.safeParse(input ?? {});
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
        .join("; ");
      return { content: `Invalid input for ${name} — ${problems}`, isError: true };
    }

    // ── THE GATE ─────────────────────────────────────────────────────────
    // Consequential tools stop here until Umberto says yes. Per-action:
    // one yes covers exactly one call, never the next. config.confirmOverrides
    // can flip a tool's flag without touching code.
    const flagged =
      typeof tool.needsConfirmation === "function"
        ? tool.needsConfirmation(parsed.data)
        : tool.needsConfirmation;
    const needsConfirmation = loadConfig().confirmOverrides[name] ?? flagged;
    if (needsConfirmation) {
      // Two renderings, because they go to different places. `intent` is read by
      // a human on his own screen and may carry the content he is judging;
      // `logIntent` is persisted to logs/audit.jsonl and data/notices.json, and
      // a tool asking about a secret must not write that secret to either.
      const described = tool.confirmIntent?.(parsed.data);
      const intent = described?.human ?? `${name} ${JSON.stringify(parsed.data)}`;
      const logIntent = described?.log ?? intent;
      if (!this.confirm) {
        // No human on this path (heartbeat/background): safe default is to do
        // nothing and leave a note — never block, never act unapproved.
        audit("gate", { tool: name, intent: logIntent, decision: "auto-denied (no human present)" });
        addNotice(
          "gate",
          `I wanted to run ${logIntent} but you weren't there to approve it, so I didn't.`,
          "quiet",
        );
        return {
          content:
            "This action needs Umberto's explicit confirmation and he isn't available on this channel. It was NOT done; a note was left in his inbox. Do not retry.",
          isError: true,
        };
      }
      const ok = await this.confirm(name, intent);
      audit("gate", { tool: name, intent: logIntent, decision: ok ? "approved" : "declined" });
      if (!ok) {
        return {
          content:
            "Umberto declined (or didn't answer in time), so this was NOT done. Don't retry unless he asks again.",
          isError: true,
        };
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    try {
      const content = await tool.run(parsed.data);
      audit("tool_ran", { tool: name, ok: true });
      return { content, isError: false };
    } catch (err) {
      audit("tool_ran", { tool: name, ok: false, error: err instanceof Error ? err.message : String(err) });
      // Tools failing is normal life; the model gets a plain-language error
      // and decides how to recover or explain it.
      return {
        content: `The ${name} tool failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}
