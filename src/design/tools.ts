// EVE's hands for the head-of-design agent. design_dispatch spends real money
// (planner + Claude Code + images, capped per dispatch), so it sits behind the
// Tier 6 gate; the confirm prompt is where Umberto sees the cap. It returns
// immediately — the work runs in the background and lands as a loud notice —
// so a voice turn is never blocked for five minutes.
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { loadConfig } from "../core/config.js";
import type { Notice } from "../core/notices.js";
import { listProjects } from "./docs.js";
import { readMockupManifest } from "./scaffold.js";
import { currentDispatch, recentDispatches, startDispatch } from "./dispatch.js";
import { SLUG_RE } from "./types.js";

// The face server installs its broadcaster here so the completion notice
// reaches every open tab the moment it lands.
let noticeSink: ((n: Notice) => void) | null = null;
export function setDesignNoticeSink(fn: ((n: Notice) => void) | null): void {
  noticeSink = fn;
}

function pickProject(given: unknown): string {
  const projects = listProjects();
  if (typeof given === "string" && given.trim()) {
    const slug = given.trim().toLowerCase();
    if (!projects.some((p) => p.slug === slug)) {
      throw new Error(`no design project called '${slug}' — known: ${projects.map((p) => p.slug).join(", ") || "(none configured in config.json design.projects)"}`);
    }
    return slug;
  }
  if (projects.length === 1) return projects[0]!.slug;
  if (projects.length === 0) throw new Error("no design projects are configured (config.json → design.projects)");
  throw new Error(`which project? one of: ${projects.map((p) => p.slug).join(", ")}`);
}

export const designTools: EveTool[] = [
  {
    name: "design_dispatch",
    description:
      "Commission a design mockup from EVE's head-of-design agent: one award-quality screen (hero, landing page, dashboard surface, product page) composed as a real Next.js + shadcn/MagicUI page, built to a static export and served at /api/<project>/preview/<feature>/<screen>/. " +
      "Use it when Umberto asks to design, mock up, or redo a screen for a project. It costs real money (planner + Claude Code + optional images, capped per dispatch by config.json design.maxDispatchUsd), so it requires his explicit confirmation — the gate does the asking. " +
      "It returns at once and runs in the background for a few minutes; a loud notice with the URL arrives when it's done, and design_status shows progress. The brief is law: if the request conflicts with the project's .prism/brief.md the agent stops and asks instead of composing.",
    schema: z.object({
      project: z.string().optional().describe("Project slug from config.json design.projects (e.g. 'eve'). Omit when there is only one."),
      request: z.string().min(10).describe("What to design, in Umberto's words: the screen, its purpose, any direction ('the landing hero for EVE, editorial, show the voice loop')."),
      feature: z.string().regex(SLUG_RE).optional().describe("Feature slug (kebab-case) to reuse — omit to let the planner pick."),
      screen: z.string().regex(SLUG_RE).optional().describe("Screen name (kebab-case), e.g. 'hero'. Omit to let the planner pick."),
      quality: z.enum(["standard", "premium"]).optional().describe("premium = more polish, more turns, premium image model. Default standard."),
      references: z.array(z.string()).optional().describe("Reference image filenames under <project>/.prism/references/<feature>/ to anchor the look."),
      max_usd: z.number().positive().optional().describe("Lower spend cap for this dispatch than the config default (never higher)."),
    }),
    needsConfirmation: true,
    run: async (input) => {
      const project = pickProject(input.project);
      const running = currentDispatch();
      if (running) {
        throw new Error(`a design dispatch is already running (${running.id}: ${running.input.project} — ${running.input.request.slice(0, 80)}) — wait for its notice or call design_cancel`);
      }
      const cfg = loadConfig();
      const cap = Math.min(cfg.design.maxDispatchUsd, typeof input.max_usd === "number" ? input.max_usd : cfg.design.maxDispatchUsd);
      const handle = startDispatch(
        {
          project,
          request: String(input.request),
          ...(typeof input.feature === "string" ? { featureSlug: input.feature } : {}),
          ...(typeof input.screen === "string" ? { screenName: input.screen } : {}),
          ...(input.quality === "standard" || input.quality === "premium" ? { quality: input.quality } : {}),
          ...(Array.isArray(input.references) ? { referenceImages: input.references.map(String) } : {}),
          maxUsd: cap,
        },
        { onNotice: (n) => noticeSink?.(n) },
      );
      return (
        `Design dispatch ${handle.id} started for ${project}: "${String(input.request).slice(0, 120)}". ` +
        `It runs in the background (typically 3–8 minutes; first dispatch on a project longer because of npm install), capped at $${cap.toFixed(2)}. ` +
        `A notice with the preview URL will arrive when it's done; design_status shows live progress. Tell Umberto it's underway and move on — don't wait in this turn.`
      );
    },
  },
  {
    name: "design_status",
    description:
      "What the head-of-design agent is doing and has produced: the running dispatch (if any) with its latest progress lines, the last results with preview URLs and cost, and every configured design project with its built mockups. Use it when Umberto asks how the design is going, for the link to a mockup, or which projects/screens exist.",
    schema: z.object({}),
    needsConfirmation: false,
    run: async () => {
      const lines: string[] = [];
      const running = currentDispatch();
      if (running) {
        const tail = running.events.slice(-6).map((e) => `  · [${e.kind}] ${e.text}`);
        lines.push(`RUNNING ${running.id} (${running.input.project}, since ${running.startedAt}): ${running.input.request.slice(0, 100)}`);
        lines.push(...(tail.length ? tail : ["  · starting…"]));
      } else {
        lines.push("No dispatch running.");
      }
      const recent = recentDispatches();
      if (recent.length) {
        lines.push("Recent:");
        for (const r of recent.slice(0, 5)) {
          lines.push(`  · ${r.dispatchId} ${r.project} ${r.featureSlug}/${r.screenName}: ${r.ok ? "ready" : "not ready"} ${r.url ?? ""} ($${r.costUsd.toFixed(2)})${r.openQuestions.length ? ` — open: ${r.openQuestions.join(" | ")}` : ""}`);
        }
      }
      const projects = listProjects();
      lines.push(projects.length ? "Projects:" : "Projects: none configured (config.json design.projects)");
      for (const p of projects) {
        let mockups: Array<{ feature: string; screen: string; url: string; builtAt: string }> = [];
        try {
          mockups = readMockupManifest(p).mockups;
        } catch {
          mockups = [];
        }
        lines.push(`  · ${p.slug} (${p.root}): ${mockups.length ? mockups.map((m) => `${m.feature}/${m.screen} → ${m.url}`).join("; ") : "no mockups yet"}`);
      }
      return lines.join("\n");
    },
  },
  {
    name: "design_cancel",
    description:
      "Stop the running design dispatch (Claude Code is interrupted, child processes swept, spend stops). Use it when Umberto says to stop or cancel the design work in progress.",
    schema: z.object({}),
    needsConfirmation: false,
    run: async () => {
      const running = currentDispatch();
      if (!running) return "Nothing to cancel — no design dispatch is running.";
      running.cancel();
      return `Cancelling design dispatch ${running.id} (${running.input.project}). Spend stops here; whatever was built so far stays on disk.`;
    },
  },
];
