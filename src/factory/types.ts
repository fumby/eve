// The Factory's data contract — shared by every tier. A spawned agent is PURE
// CONFIGURATION: a row here, run by one generic runtime. If anything in this
// system ever wants a per-agent class, that's the pattern breaking.
import { z } from "zod";

// ---------------------------------------------------------------- research (Tier 1)
export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
  excerpt: z.string().max(400).default(""),
});

export const ToolWishlistEntrySchema = z.object({
  name: z.string().min(1),
  purpose: z.string().min(1),
  external_dependency: z.string().default(""),
});

export const SkillsReportSchema = z.object({
  domain: z.string().min(1),
  competencies: z.array(z.string().min(1)).min(3).max(10),
  tools_available: z.array(z.string()),
  tools_wishlist: z.array(ToolWishlistEntrySchema),
  design_patterns: z.array(z.string()).max(8),
  sources: z.array(SourceSchema).max(20),
});
export type SkillsReport = z.infer<typeof SkillsReportSchema>;

export interface ResearchReport {
  id: string;
  query: string; // normalized
  report: SkillsReport;
  createdAt: string;
  // Honest provenance: how many searches ran, and whether the emit had to
  // be forced on the final iteration.
  searches: number;
  forced: boolean;
}

// ---------------------------------------------------------------- spawn tasks (Tier 3/4)
export const TASK_STATES = [
  "pending",
  "researching",
  "drafting_spec",
  "writing_prompt",
  "awaiting_approval",
  "approved",
  "rejected",
  "failed",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

// The transition table — invalid moves fail loudly at the store layer.
export const TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  pending: new Set(["researching", "failed"]),
  researching: new Set(["drafting_spec", "failed"]),
  drafting_spec: new Set(["writing_prompt", "failed"]),
  writing_prompt: new Set(["awaiting_approval", "failed"]),
  awaiting_approval: new Set(["approved", "rejected", "writing_prompt", "failed"]),
  approved: new Set(),
  rejected: new Set(),
  failed: new Set(),
};

export interface Manifest {
  slug: string;
  name: string;
  specialty: string;
  system_prompt: string;
  tool_allowlist: string[];
  model: string;
}

export interface SpawnTask {
  id: string;
  requestedBy: string; // "umberto" | "eve" (when EVE asks on his behalf)
  nameHint: string;
  roleDescription: string; // sanitized
  specialRequirements: string; // sanitized
  status: TaskState;
  slug: string | null;
  researchReportId: string | null;
  proposedManifest: Manifest | null;
  approvalIterations: number;
  revisionFeedback: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- spawned agents (Tier 4/5)
export interface SpawnedAgent {
  id: string;
  slug: string;
  name: string;
  specialty: string;
  system_prompt: string;
  tool_allowlist: string[];
  model: string;
  status: "active" | "archived";
  createdByTaskId: string;
  createdAt: string;
  archivedAt: string | null;
}

// Slugs EVE's own specialists already own. Non-negotiable.
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "eve",
  "factory",
  "board",
  "drucker",
  "munger",
  "newport",
  "hormozi",
  "researcher",
  "research",
  "design",
  "head-of-design",
  "head_of_design",
  "heartbeat",
]);

export const DISPATCH_PREFIX = "dispatch_to_";
export const dispatchToolName = (slug: string): string => `${DISPATCH_PREFIX}${slug}`;
