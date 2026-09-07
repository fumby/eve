// Delegate to the right AI — EVE's judgement about which model does which
// job best, put into a tool. She can send a task to:
//
//   - **hermes**: runs the local Hermes agent under the `eve` profile (same
//     install this chat lives in, invoked via the `eve` shell alias). It is a
//     full agent: sessions, web search/extract, browser, terminal, cron,
//     multi-step research. Use it for anything multi-step that benefits from
//     a real tool loop: "research X and give me a cited summary", "check
//     these sites and compare prices". EVE chooses to delegate — Hermes is a
//     tool in her box, never her runtime. It writes NOTHING to EVE's stores
//     (no memory, no commitments, no notices): the result comes back as text
//     and EVE owns what happens with it.
//
//   - **claude-code**: runs Claude Code through the Agent SDK (same path the
//     design composer uses) with real file access inside one of Umberto's
//     configured project folders. It can Read, Write, Edit, Bash, Glob, Grep —
//     the full Claude Code skill set. Use it for coding tasks: "add a
//     function", "fix this bug", "refactor that file", "write the tests".
//
//   - **claude**: a single deep-reasoning call through the Anthropic SDK
//     (Claude Opus / Sonnet) with no tools — pure thinking. Use it for
//     questions that need sustained reasoning without file access: "analyse
//     this trade-off", "draft this email", "break down this problem".
//
//   - **chatgpt**: a single call through the OpenAI SDK (GPT-4o or whatever
//     model is configured). Use it for ChatGPT's strengths: image analysis,
//     certain creative tasks, a second opinion from a different model.
//
// The tool description tells EVE which AI to pick and why, so the choice is
// visible in the tool call rather than hidden in the prompt. Each call is
// parameterised by the task text and returns the AI's answer as plain text.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { loadConfig, requireKey } from "../core/config.js";
import { audit } from "../core/audit.js";
import { resolveRoot } from "../projects/read.js";
import { emitAgentEvent } from "../core/agent-events.js";
import { guardOutbound } from "../memory/privacy.js";

// ── Claude Code (Agent SDK) ──────────────────────────────────────────────
// Same path the design composer uses: the Agent SDK runs Claude Code
// headlessly with a preset system prompt, an env allowlist, and a permission
// handler that denies anything outside the project folder. The task text is
// the prompt; the project slug determines the cwd.

const CC_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Bash(npm install:*)",
  "Bash(npm run:*)",
  "Bash(npx tsc:*)",
  "Bash(npx tsx:*)",
  "Bash(node:*)",
  "Bash(git:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(mkdir:*)",
  "Bash(cd:*)",
  "Bash(pwd:*)",
  "Glob",
  "Grep",
];

const CC_DISALLOWED_TOOLS = [
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "NotebookEdit",
  "KillShell",
  "TaskStop",
  "TodoWrite",
];

const CC_ENV_ALLOWLIST = ["ANTHROPIC_API_KEY", "HOME", "PATH", "USER", "LANG", "TMPDIR"] as const;

function ccEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of CC_ENV_ALLOWLIST) {
    const v = source[key];
    if (typeof v === "string" && v) out[key] = v;
  }
  return out;
}

async function runClaudeCode(task: string, projectSlug: string): Promise<string> {
  // Resolve the project root through the same guard the project tools use —
  // it refuses a root inside or containing the EVE checkout.
  const cwd = resolveRoot(projectSlug);
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  const controller = new AbortController();
  const started = Date.now();
  const descriptor = {
    id: "claude-code",
    name: "Claude Code",
    specialty: "coding agent",
    initial: "C" as const,
  };
  emitAgentEvent({ agent: "claude-code", phase: "dispatch", label: task.slice(0, 80), descriptor });

  // The options object mirrors the design composer's: a preset system prompt,
  // SDK isolation (no ~/.claude or project settings), an env allowlist so
  // DEEPGRAM/ELEVENLABS/SUPABASE keys never reach the child, and a permission
  // handler that denies anything outside the allowed-tools list.
  const canUseTool = async (_toolName: string): Promise<{ behavior: "deny"; message: string }> => ({
    behavior: "deny",
    message: `EVE's delegate only allows ${CC_ALLOWED_TOOLS.join(", ")}. Use an allowed tool.`,
  });

  try {
    let fullText = "";
    const stream = await query({
      prompt: task,
      options: {
        cwd,
        // Follow the brain Umberto chose for EVE (config.json), not a hardcoded
        // tier: delegating coding to a model dumber than EVE's own makes the
        // delegate the weak link — "delegate to the BEST, not to the cheapest".
        model: loadConfig().model === "claude-sonnet-5" ? "sonnet" : "opus",
        maxTurns: 30,
        // Opus-class coding runs cost more per turn; $5 was a Sonnet-era cap
        // that a real refactor could hit mid-task. Umberto's standing priority
        // is quality over cost — the cap guards against a runaway, not spend.
        maxBudgetUsd: 10,
        permissionMode: "default",
        allowedTools: CC_ALLOWED_TOOLS,
        disallowedTools: CC_DISALLOWED_TOOLS,
        canUseTool,
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: [],
        strictMcpConfig: true,
        env: ccEnv(),
        persistSession: false,
        includePartialMessages: false,
        abortController: controller,
      },
    });
    for await (const msg of stream) {
      // SDK messages are a discriminated union on `type`; assistant messages
      // carry text in `content` blocks.
      const m = msg as { type?: string; content?: Array<{ type: string; text?: string }> };
      if (m.type === "assistant" && Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === "text" && typeof block.text === "string") fullText += block.text;
        }
      }
      emitAgentEvent({
        agent: "claude-code",
        phase: "working",
        label: m.type ?? "working",
        descriptor,
      });
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    audit("delegate", { to: "claude-code", project: projectSlug, seconds: elapsed });
    emitAgentEvent({ agent: "claude-code", phase: "done", label: `${elapsed}s`, descriptor });
    return fullText.trim() || "(Claude Code returned no text — it may have only used tools.)";
  } catch (err) {
    emitAgentEvent({ agent: "claude-code", phase: "error", label: String(err).slice(0, 80), descriptor });
    throw new Error(`Claude Code failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Hermes (local agent, eve profile) ────────────────────────────────────
// Umberto's rule: EVE stays EVE; Hermes is an option SHE chooses. We invoke
// the `eve` shell alias (hermes -p eve) headless with a timeout, and the
// result comes back as plain text. The child agent has no access to EVE's
// stores — it cannot write memories, commitments or notices; anything it
// produces returns through this tool and EVE decides what to do with it.
const HERMES_BIN = "/Users/YOU/.local/bin/eve";
const HERMES_TIMEOUT_MS = 5 * 60 * 1000;

async function runHermes(task: string): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileP = promisify(execFile);
  const started = Date.now();
  const descriptor = {
    id: "hermes",
    name: "Hermes",
    specialty: "full local agent",
    initial: "H" as const,
  };
  emitAgentEvent({ agent: "hermes", phase: "dispatch", label: task.slice(0, 80), descriptor });
  try {
    const { stdout } = await execFileP(
      HERMES_BIN,
      ["chat", "-q", task],
      { timeout: HERMES_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    const elapsed = Math.round((Date.now() - started) / 1000);
    audit("delegate", { to: "hermes", seconds: elapsed });
    emitAgentEvent({ agent: "hermes", phase: "done", label: `${elapsed}s`, descriptor });
    const text = stdout.trim();
    return text || "(Hermes returned no text.)";
  } catch (err) {
    emitAgentEvent({ agent: "hermes", phase: "error", label: String(err).slice(0, 80), descriptor });
    const msg = err instanceof Error ? err.message : String(err);
    const timedOut = msg.includes("TIMED OUT") || (err as { killed?: boolean }).killed;
    throw new Error(
      timedOut
        ? `Hermes did not finish within 5 minutes — the task may be too long for a single delegation. Split it or do it yourself.`
        : `Hermes failed: ${msg.slice(0, 300)}`,
    );
  }
}

// ── Claude (Anthropic SDK, deep reasoning) ───────────────────────────────
async function runClaude(task: string, systemPrompt: string): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ apiKey: requireKey("ANTHROPIC_API_KEY") });
  const started = Date.now();
  const descriptor = {
    id: "claude",
    name: "Claude",
    specialty: "deep reasoning",
    initial: "C" as const,
  };
  emitAgentEvent({ agent: "claude", phase: "dispatch", label: task.slice(0, 80), descriptor });
  try {
    const res = await client.messages.create({
      model: loadConfig().model,
      max_tokens: 4096,
      system: systemPrompt || "You are a precise, thoughtful assistant. Answer in the language the user uses.",
      messages: [{ role: "user", content: task }],
    });
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("");
    const elapsed = Math.round((Date.now() - started) / 1000);
    audit("delegate", { to: "claude", seconds: elapsed });
    emitAgentEvent({ agent: "claude", phase: "done", label: `${elapsed}s`, descriptor });
    return text.trim();
  } catch (err) {
    emitAgentEvent({ agent: "claude", phase: "error", label: String(err).slice(0, 80), descriptor });
    throw new Error(`Claude failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── ChatGPT (OpenAI SDK) ─────────────────────────────────────────────────
async function runChatGPT(task: string, systemPrompt: string): Promise<string> {
  let OpenAI: typeof import("openai").default;
  try {
    OpenAI = (await import("openai")).default;
  } catch {
    throw new Error("the OpenAI SDK isn't installed — run `npm install openai`, and add OPENAI_API_KEY to .env");
  }
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in .env — ChatGPT delegation needs it. Add it and retry.");
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const started = Date.now();
  const descriptor = {
    id: "chatgpt",
    name: "ChatGPT",
    specialty: "second opinion / creative",
    initial: "G" as const,
  };
  emitAgentEvent({ agent: "chatgpt", phase: "dispatch", label: task.slice(0, 80), descriptor });
  try {
    const res = await client.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 4096,
      messages: [
        { role: "system", content: systemPrompt || "You are a helpful, precise assistant. Answer in the language the user uses." },
        { role: "user", content: task },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    const elapsed = Math.round((Date.now() - started) / 1000);
    audit("delegate", { to: "chatgpt", seconds: elapsed });
    emitAgentEvent({ agent: "chatgpt", phase: "done", label: `${elapsed}s`, descriptor });
    return text.trim();
  } catch (err) {
    emitAgentEvent({ agent: "chatgpt", phase: "error", label: String(err).slice(0, 80), descriptor });
    throw new Error(`ChatGPT failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export const delegateTools: EveTool[] = [
  {
    name: "delegate_to_ai",
    description:
      "Delegate a task to the AI that does it best: 'hermes' for multi-step work needing a full tool loop (web research with sources, browser use, comparisons — a complete local agent; use it when YOU choose that a task benefits from more tools than you have, e.g. 'research this and give me a cited summary'), 'claude-code' for coding (it runs Claude Code with real file access inside one of Umberto's configured project folders — Read, Write, Edit, Bash, Grep — and can actually write and run code), 'claude' for deep reasoning without file access (sustained multi-step thinking, trade-off analysis, drafting), 'chatgpt' for a second opinion from a different model (image analysis, certain creative tasks, a different perspective). Pick the one that fits the task: research/multi-step → hermes; coding → claude-code; reasoning → claude; second opinion or different strengths → chatgpt. Each takes the task as text and returns the AI's answer, which you then relay to Umberto in your own voice. Claude Code costs real money per run (file + tool calls), so use it when the task genuinely needs code execution, not for a question you could answer yourself.",
    schema: z.object({
      ai: z
        .enum(["hermes", "claude-code", "claude", "chatgpt"])
        .describe("Which AI to delegate to: 'hermes' (full local agent: web research, browser, multi-step work), 'claude-code' (coding, file access, tool use), 'claude' (deep reasoning, no tools), 'chatgpt' (second opinion, different model)."),
      task: z
        .string()
        .min(5)
        .max(8000)
        .describe("The self-contained task: what to do, the context, the constraints, what a good answer looks like. The AI can't see this conversation, so put everything it needs in here."),
      project: z
        .string()
        .optional()
        .describe("For 'claude-code' only: the project slug from list_projects (e.g. 'youtube-analysis'). Required for claude-code; ignored for the others."),
      system_prompt: z
        .string()
        .optional()
        .describe("An optional system prompt to steer the AI's approach. For claude and chatgpt only; claude-code uses its own preset."),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const ai = String(input.ai);
      const task = String(input.task);
      const systemPrompt = input.system_prompt ? String(input.system_prompt) : "";
      // The privacy guard: the task text leaves for another provider (or a
      // local agent with web access) ungated. His identifiers do not ride
      // along — the guard's refusal text says how to generalise.
      const refused = guardOutbound(`${task}\n${systemPrompt}`, `to ${ai}`);
      if (refused) return refused;
      if (ai === "hermes") {
        return await runHermes(task);
      }
      if (ai === "claude-code") {
        if (!input.project) {
          throw new Error("delegating to Claude Code needs a `project` — use list_projects first and give the slug.");
        }
        return await runClaudeCode(task, String(input.project));
      }
      if (ai === "claude") {
        return await runClaude(task, systemPrompt);
      }
      if (ai === "chatgpt") {
        return await runChatGPT(task, systemPrompt);
      }
      throw new Error(`unknown AI: "${ai}" — use 'claude-code', 'claude', or 'chatgpt'`);
    },
  },
];
