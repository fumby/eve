// The Factory's three "tables" — JSON files under data/factory/, matching how
// everything else in EVE persists: human-readable, hand-editable, no DB.
// The transition table is enforced HERE, so an invalid state move throws
// instead of silently corrupting a task.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../core/store.js";
import { writeFileAtomic } from "../core/atomic.js";
import {
  TRANSITIONS,
  type Manifest,
  type ResearchReport,
  type SkillsReport,
  type SpawnTask,
  type SpawnedAgent,
  type TaskState,
} from "./types.js";

const DIR = path.join(DATA_DIR, "factory");
const TASKS = path.join(DIR, "tasks.json");
const AGENTS = path.join(DIR, "agents.json");
const RESEARCH = path.join(DIR, "research.json");
const RESEARCH_TTL_MS = 24 * 3_600_000;

function readList<T>(file: string): T[] {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T[];
  } catch {
    return [];
  }
}
function writeList(file: string, list: unknown[]): void {
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(file, JSON.stringify(list, null, 2) + "\n");
}
const now = () => new Date().toISOString();
const newId = () => crypto.randomBytes(6).toString("hex");

export class InvalidTransition extends Error {}

// ---------------------------------------------------------------- tasks
export const listTasks = (): SpawnTask[] => readList<SpawnTask>(TASKS);
export const getTask = (id: string): SpawnTask | null =>
  listTasks().find((t) => t.id === id) ?? null;

export function createTask(input: {
  requestedBy: string;
  nameHint: string;
  roleDescription: string;
  specialRequirements: string;
}): SpawnTask {
  const all = listTasks();
  const t: SpawnTask = {
    id: newId(),
    ...input,
    status: "pending",
    slug: null,
    researchReportId: null,
    proposedManifest: null,
    approvalIterations: 0,
    revisionFeedback: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
  };
  all.push(t);
  writeList(TASKS, all);
  return t;
}

// Tasks created today — the daily-cap check reads this at creation time.
export function tasksCreatedToday(): number {
  const today = now().slice(0, 10);
  return listTasks().filter((t) => t.createdAt.startsWith(today)).length;
}

export function updateTask(
  id: string,
  patch: Partial<Omit<SpawnTask, "id" | "createdAt" | "status">>,
): SpawnTask {
  const all = listTasks();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error(`no spawn task ${id}`);
  Object.assign(t, patch, { updatedAt: now() });
  writeList(TASKS, all);
  return t;
}

// The ONLY way a task's status changes. Refuses anything not in the table.
export function transition(id: string, to: TaskState): SpawnTask {
  const all = listTasks();
  const t = all.find((x) => x.id === id);
  if (!t) throw new Error(`no spawn task ${id}`);
  if (!TRANSITIONS[t.status].has(to)) {
    throw new InvalidTransition(`spawn task ${id}: ${t.status} → ${to} is not allowed`);
  }
  t.status = to;
  t.updatedAt = now();
  writeList(TASKS, all);
  return t;
}

export const pendingApproval = (): SpawnTask[] =>
  listTasks()
    .filter((t) => t.status === "awaiting_approval")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

// ---------------------------------------------------------------- agents
export const listAgents = (): SpawnedAgent[] => readList<SpawnedAgent>(AGENTS);
export const activeAgents = (): SpawnedAgent[] => listAgents().filter((a) => a.status === "active");
export const getAgentBySlug = (slug: string): SpawnedAgent | null =>
  listAgents().find((a) => a.slug === slug) ?? null;

export function saveAgent(m: Manifest, createdByTaskId: string): SpawnedAgent {
  const all = listAgents();
  if (all.some((a) => a.slug === m.slug)) throw new Error(`slug "${m.slug}" already registered`);
  const a: SpawnedAgent = {
    id: newId(),
    ...m,
    status: "active",
    createdByTaskId,
    createdAt: now(),
    archivedAt: null,
  };
  all.push(a);
  writeList(AGENTS, all);
  return a;
}

// Archive, never delete: the row stays for audit and the slug stays taken.
export function archiveAgent(slug: string): SpawnedAgent | null {
  const all = listAgents();
  const a = all.find((x) => x.slug === slug && x.status === "active");
  if (!a) return null;
  a.status = "archived";
  a.archivedAt = now();
  writeList(AGENTS, all);
  return a;
}

// ---------------------------------------------------------------- research cache
export const normalizeQuery = (q: string): string =>
  q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function cachedResearch(query: string): ResearchReport | null {
  const key = normalizeQuery(query);
  const hit = readList<ResearchReport>(RESEARCH).find((r) => r.query === key);
  if (!hit) return null;
  return Date.now() - Date.parse(hit.createdAt) < RESEARCH_TTL_MS ? hit : null;
}

export function saveResearch(
  query: string,
  report: SkillsReport,
  meta: { searches: number; forced: boolean },
): ResearchReport {
  const key = normalizeQuery(query);
  const all = readList<ResearchReport>(RESEARCH).filter((r) => r.query !== key);
  const r: ResearchReport = { id: newId(), query: key, report, createdAt: now(), ...meta };
  all.push(r);
  writeList(RESEARCH, all.slice(-200));
  return r;
}

export const getResearch = (id: string): ResearchReport | null =>
  readList<ResearchReport>(RESEARCH).find((r) => r.id === id) ?? null;
