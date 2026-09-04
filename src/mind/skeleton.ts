// Assembles the mind map's skeleton: a flat node list, a flat edge list, and
// honest stats. Pure function over explicit inputs so it can be tested without
// a server. Every region is built inside its own try — a broken source empties
// that region and records an error in stats, rather than 500-ing the page.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../core/config.js";
import { embed, similarityEdges, TOP_K, SIM_THRESHOLD, type SimilarityKind } from "./embed.js";
import type { StoredMemory } from "../memory/store.js";
import type { Reminder } from "../tools/reminders.js";
import type { Conversation } from "../core/conversations.js";
import type { EveTool } from "../core/registry.js";

export const REGION_COLORS = {
  core: "#2DD4A8",
  memory: "#A78BFA",
  working: "#67E8F9",
  agents: "#E88FB3",
  knowledge: "#F5A524",
  rim: "#8B93A1",
} as const;

export type RegionName = keyof typeof REGION_COLORS;

export interface MindNode {
  id: string;
  type: string;
  region: RegionName;
  label: string;
  color: string;
  size: number;
  freshness: number;
  extra: Record<string, unknown>;
}

export interface MindEdge {
  source: string;
  target: string;
  kind: string;
  weight: number;
}

export interface Skeleton {
  regions: { name: RegionName; color: string; label: string }[];
  nodes: MindNode[];
  edges: MindEdge[];
  stats: Record<string, unknown>;
}

// Exponential decay on age — a scatter of bright recent thoughts among dim old
// ones is what makes the memory web read as a mind rather than a chart.
export function freshness(iso: string | null | undefined): number {
  if (!iso) return 1;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 1;
  const days = ms / 86_400_000;
  return Math.max(0.15, 0.5 ** (days / 30));
}

// Which files EVE genuinely reads or depends on every turn. This doubles as the
// allow-list for the detail endpoint's previews — an arbitrary path would be a
// directory traversal.
export const KNOWLEDGE_MANIFEST = [
  "AGENT.md",
  "config.json",
  "brain/identity.md",
  "memory/core/me.md",
  "memory/core/studies.md",
  "memory/core/ventures.md",
  "memory/core/people.md",
  "memory/core/personal.md",
  "brain/ledger-schema.md",
] as const;

const TOOL_CATEGORY: Record<string, string> = {
  add_reminder: "reminders",
  list_reminders: "reminders",
  complete_reminder: "reminders",
  search_notes: "studies",
  read_note: "studies",
  set_studies_dir: "studies",
  list_projects: "projects",
  project_status: "projects",
  search_project: "projects",
  read_project_file: "projects",
  set_project_dir: "projects",
  forget_project_dir: "projects",
  save_memory: "memory",
  recall_memories: "memory",
  forget_memory: "memory",
  get_weather: "world",
  set_location: "world",
  deep_research: "research",
  research_status: "research",
  perplexity_search: "research",
  query_ledger: "ledger",
  design_dispatch: "design",
  design_status: "design",
  design_cancel: "design",
};

// External services EVE actually depends on, with the env var that proves it.
const INTEGRATIONS = [
  { id: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY", role: "brain" },
  { id: "elevenlabs", label: "ElevenLabs", env: "ELEVENLABS_API_KEY", role: "voice + ears" },
  { id: "deepgram", label: "Deepgram", env: "DEEPGRAM_API_KEY", role: "live captions" },
  { id: "voyage", label: "Voyage AI", env: "VOYAGE_API_KEY", role: "semantic memory" },
  { id: "github", label: "GitHub", env: "GITHUB_TOKEN", role: "repo watch" },
  { id: "supabase", label: "Supabase", env: "SUPABASE_LEDGER_URL", role: "ledger (read-only SQL)" },
  { id: "claude-code", label: "Claude Code", env: "ANTHROPIC_API_KEY", role: "design composer" },
  { id: "gemini", label: "Gemini", env: "GEMINI_API_KEY", role: "design imagery" },
  { id: "openmeteo", label: "Open-Meteo", env: null, role: "weather" },
  { id: "websearch", label: "Web search", env: "ANTHROPIC_API_KEY", role: "research" },
  { id: "perplexity", label: "Perplexity", env: "PERPLEXITY_API_KEY", role: "quick sourced answers" },
];

export interface SkeletonInput {
  memories: StoredMemory[];
  conversations: Conversation[];
  reminders: Reminder[];
  tools: EveTool[];
  agentName: string;
  model: string;
}

export async function buildSkeleton(input: SkeletonInput): Promise<Skeleton> {
  const nodes: MindNode[] = [];
  const edges: MindEdge[] = [];
  const stats: Record<string, unknown> = {
    similarity_top_k: TOP_K,
    similarity_threshold: SIM_THRESHOLD,
  };

  // ---------------------------------------------------------------- core
  try {
    nodes.push({
      id: "core:eve",
      type: "agent",
      region: "core",
      label: input.agentName,
      color: REGION_COLORS.core,
      size: 1,
      freshness: 1,
      extra: { model: input.model },
    });
    stats.core = "ok";
  } catch (err) {
    stats.core = "error";
    stats.core_error = String(err);
  }

  // ---------------------------------------------------------------- memory
  let simKind: SimilarityKind = "lexical";
  try {
    // An absent memory/store/ is a legitimately empty store (fresh brain),
    // not an error — listMemories() already distinguishes malformed files.
    const items = input.memories.map((m) => ({
      id: `mem:${m.name}`,
      text: `${m.hook}. ${m.body.slice(0, 300)}`,
    }));
    let vectors = new Map<string, number[]>();
    try {
      const r = await embed(items);
      vectors = r.vectors;
      simKind = r.kind;
    } catch (err) {
      stats.embeddings_error = String(err); // degrade to lexical, don't fail
    }
    const sim = similarityEdges(items, vectors);
    const degree = new Map<string, number>();
    for (const e of sim) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      edges.push({ source: e.source, target: e.target, kind: "similarity", weight: e.weight });
    }
    for (const m of input.memories) {
      const id = `mem:${m.name}`;
      nodes.push({
        id,
        type: "memory",
        region: "memory",
        label: m.hook.length > 48 ? m.hook.slice(0, 45) + "…" : m.hook,
        color: REGION_COLORS.memory,
        size: 0.5 + Math.min(3, degree.get(id) ?? 0) * 0.12,
        // Store files carry real created dates — brightness is finally earned.
        freshness: freshness(m.created || null),
        extra: { degree: degree.get(id) ?? 0, memType: m.type },
      });
    }
    // Recall always flows core-ward, so there are always trunks: the best
    // connected memories, padded with the newest when the web is sparse.
    const ranked = [...input.memories]
      .map((m) => ({ id: `mem:${m.name}`, deg: degree.get(`mem:${m.name}`) ?? 0 }))
      .sort((a, b) => b.deg - a.deg)
      .slice(0, 3);
    for (const r of ranked) {
      edges.push({ source: r.id, target: "core:eve", kind: "recall", weight: 0.6 + r.deg * 0.1 });
    }
    stats.memory_total = input.memories.length;
    stats.memory_shown = input.memories.length;
    stats.similarity = simKind;
    stats.similarity_edges = sim.length;
    stats.memory = "ok";
  } catch (err) {
    stats.memory = "error";
    stats.memory_error = String(err);
  }

  // ---------------------------------------------------------------- working
  try {
    const recent = [...input.conversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12);
    for (const c of recent) {
      const first = c.turns.find((t) => t.role === "user")?.text ?? "(empty)";
      nodes.push({
        id: `thread:${c.id}`,
        type: "thread",
        region: "working",
        label: first.length > 40 ? first.slice(0, 37) + "…" : first,
        color: REGION_COLORS.working,
        size: 0.45 + Math.min(6, c.turns.length) * 0.03,
        freshness: freshness(c.updatedAt),
        extra: { turns: c.turns.length, source: c.source },
      });
      edges.push({ source: "core:eve", target: `thread:${c.id}`, kind: "thread", weight: 0.5 });
    }
    for (const r of input.reminders.filter((x) => !x.done)) {
      nodes.push({
        id: `task:${r.id}`,
        type: "reminder",
        region: "working",
        label: r.text.length > 40 ? r.text.slice(0, 37) + "…" : r.text,
        color: REGION_COLORS.working,
        size: 0.5,
        freshness: freshness(r.createdAt),
        extra: { due: r.due },
      });
      edges.push({ source: "core:eve", target: `task:${r.id}`, kind: "thread", weight: 0.4 });
    }
    stats.working = "ok";
    stats.threads = recent.length;
  } catch (err) {
    stats.working = "error";
    stats.working_error = String(err);
  }

  // ---------------------------------------------------------------- knowledge
  try {
    let count = 0;
    for (const rel of KNOWLEDGE_MANIFEST) {
      const full = path.join(ROOT, rel);
      if (!fs.existsSync(full)) continue;
      const st = fs.statSync(full);
      nodes.push({
        id: `know:${rel}`,
        type: "knowledge",
        region: "knowledge",
        label: rel,
        color: REGION_COLORS.knowledge,
        size: 0.55,
        freshness: freshness(st.mtime.toISOString()),
        extra: { bytes: st.size },
      });
      edges.push({ source: "core:eve", target: `know:${rel}`, kind: "knowledge", weight: 0.5 });
      count++;
    }
    stats.knowledge = "ok";
    stats.knowledge_files = count;
  } catch (err) {
    stats.knowledge = "error";
    stats.knowledge_error = String(err);
  }

  // ---------------------------------------------------------------- rim
  try {
    const categories = new Set<string>();
    for (const t of input.tools) {
      const cat = TOOL_CATEGORY[t.name] ?? t.name.split("_")[0] ?? "other";
      categories.add(cat);
      nodes.push({
        id: `tool:${t.name}`,
        type: "tool",
        region: "rim",
        label: t.name,
        color: REGION_COLORS.rim,
        size: 0.4,
        freshness: 1,
        extra: { category: cat, needsConfirmation: t.needsConfirmation },
      });
    }
    for (const cat of categories) {
      nodes.push({
        id: `cat:${cat}`,
        type: "category",
        region: "rim",
        label: cat,
        color: REGION_COLORS.rim,
        size: 0.55,
        freshness: 1,
        extra: {},
      });
      edges.push({ source: "core:eve", target: `cat:${cat}`, kind: "capability", weight: 0.7 });
      for (const t of input.tools) {
        const c = TOOL_CATEGORY[t.name] ?? t.name.split("_")[0] ?? "other";
        if (c === cat) {
          edges.push({ source: `cat:${cat}`, target: `tool:${t.name}`, kind: "owns", weight: 0.5 });
        }
      }
    }
    for (const integ of INTEGRATIONS) {
      const live = integ.env === null || !!process.env[integ.env];
      nodes.push({
        id: `integ:${integ.id}`,
        type: "integration",
        region: "rim",
        label: integ.label,
        color: REGION_COLORS.rim,
        size: 0.5,
        freshness: live ? 1 : 0.3,
        extra: { role: integ.role, live },
      });
      // A configured integration glows; an unconfigured one hangs faint rather
      // than being hidden — absence is information too.
      edges.push({
        source: "core:eve",
        target: `integ:${integ.id}`,
        kind: "capability",
        weight: live ? 0.8 : 0.15,
      });
    }
    stats.rim = "ok";
    stats.tools = input.tools.length;
    stats.categories = categories.size;
  } catch (err) {
    stats.rim = "error";
    stats.rim_error = String(err);
  }

  // Agents region is deliberately absent: EVE has no sub-agents, and inventing
  // them would be exactly the kind of pretty lie this map must never tell.
  const present = new Set(nodes.map((n) => n.region));
  const regions = (Object.keys(REGION_COLORS) as RegionName[])
    .filter((r) => present.has(r))
    .map((name) => ({ name, color: REGION_COLORS[name], label: name }));

  stats.nodes = nodes.length;
  stats.edges = edges.length;
  return { regions, nodes, edges, stats };
}
