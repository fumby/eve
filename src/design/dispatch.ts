// A design dispatch, end to end: resolve the project → bootstrap the docs on
// first contact → parse tokens (bail loudly if the design system is
// half-shaped) → plan (brief is law) → scaffold-or-skip → images → compose
// with Claude Code → verify the build → audit the TSX → one repair round →
// manifest + notice. Deterministic orchestration around two model steps
// (planner, composer); every step emits a DesignEvent the face can show live
// and the audit log keeps. Runs in the background: EVE's turn returns at once
// and the loud notice tells Umberto when the screen is ready.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_ROOT, loadConfig } from "../core/config.js";
import { audit } from "../core/audit.js";
import { addNotice, osNotification, type Notice } from "../core/notices.js";
import { writeFileAtomic } from "../core/atomic.js";
import {
  appendFeatureLog,
  bootstrapProject,
  ensureProjectLayout,
  listReferenceImages,
  readBrief,
  readDesignDoc,
  readFeatureDoc,
  resolveProjectRoot,
  validateReferenceImages,
  writeFeatureDoc,
} from "./docs.js";
import { featureTemplate } from "./templates.js";
import { parseTokens, TokenError } from "./tokens.js";
import { installCommandsFor } from "./catalog.js";
import { isBuilt, isInstalled, pageFile, prepareScaffold, refreshTokenFiles, upsertMockup } from "./scaffold.js";
import { runComposer } from "./composer.js";
import { generateImage, imagesAvailable } from "./images.js";
import { auditPageTsx, renderAuditForPrompt } from "./audit.js";
import { buildComposerPrompt, composerPaths } from "./prompt.js";
import { runPlanner, type Plan } from "./planner.js";
import {
  mockupUrl,
  type AuditReport,
  type ComposerResult,
  type DesignEvent,
  type DesignEventKind,
  type DesignEventSink,
  type ImageQuality,
  type ImageResult,
  type MockupResult,
  type ProjectRef,
} from "./types.js";
import { emitAgentEvent } from "../core/agent-events.js";

export interface DispatchInput {
  project: string;
  request: string;
  featureSlug?: string;
  screenName?: string;
  quality?: ImageQuality;
  // Bare filenames or paths relative to the project root, under .prism/references/<feature>/.
  referenceImages?: string[];
  // Lower cap than config for this one dispatch (never higher).
  maxUsd?: number;
}

// ── event fan-out (face server subscribes; audit keeps everything) ─────────
type Listener = (e: DesignEvent) => void;
const listeners: Listener[] = [];
export function onDesignEvent(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
// Composer events can carry a tool's full input (an entire page.tsx on a
// Write). The audit log and the face get a slim copy: primitives and short
// strings only — the full options/prompt log under logs/design/ is where the
// reproducible detail lives.
export function slimEvent(e: DesignEvent): DesignEvent {
  if (!e.detail) return e;
  const detail: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e.detail)) {
    if (v === null || typeof v === "number" || typeof v === "boolean") detail[k] = v;
    else if (typeof v === "string") detail[k] = v.length > 200 ? v.slice(0, 200) + "…" : v;
    else if (Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === "string" && x.length <= 80)) detail[k] = v;
    // objects (tool inputs) are dropped on purpose
  }
  return { ...e, detail };
}

function fanOut(raw: DesignEvent): void {
  const e = slimEvent(raw);
  audit("design_event", { dispatchId: e.dispatchId, kind: e.kind, text: e.text, ...(e.detail ?? {}) });
  for (const fn of listeners) {
    try {
      fn(e);
    } catch {
      // a spectator must never break the dispatch
    }
  }
}

const LOG_DIR = path.join(STATE_ROOT, "logs", "design");

// ── the repair prompt for the one retry round ──────────────────────────────
export function buildRepairPrompt(input: {
  pageRel: string;
  outRel: string;
  built: boolean;
  auditText: string;
  imageUrls: string[];
}): string {
  return `You are the composer for EVE's head-of-design agent, back for ONE repair pass on an existing page.

Page: ${input.pageRel}
${input.built ? "The build passed, but the visual audit did not." : `The static export ${input.outRel} does NOT exist — the build failed or was skipped.`}

Audit of the current page.tsx (✗ = must fix):
${input.auditText}
${input.imageUrls.length > 0 ? `\nGenerated images that must each appear verbatim in an <img src>: ${input.imageUrls.join(", ")}` : ""}

Rules: work only inside .prism/preview; fix every ✗ by ADDING what is missing (visible ambient texture ≥ opacity-40, a named product-surface component, ≥ 2 continuous motions, ≥ 3 hover states, ≥ 3 mono uppercase annotations at text-sm/14–16px, "use client" if hooks are used, every generated image referenced); keep everything that already works; install any component you add with the exact catalog command and USE it. Then run \`npm run build\` in .prism/preview until it passes and confirm ${input.outRel} exists. Finish with \`DONE: ${input.outRel}\` or \`FAILED: <reason>\`.`;
}

interface Meter {
  cap: number;
  spent: number;
}
const remaining = (m: Meter): number => Math.max(0, m.cap - m.spent);

// ── the run ────────────────────────────────────────────────────────────────
export async function runDispatch(
  input: DispatchInput,
  opts: { sink?: DesignEventSink; signal?: AbortSignal; dispatchId?: string } = {},
): Promise<MockupResult> {
  const cfg = loadConfig();
  const dispatchId = opts.dispatchId ?? crypto.randomBytes(4).toString("hex");
  const emit = (kind: DesignEventKind, text: string, detail?: Record<string, unknown>): void => {
    const e: DesignEvent = { at: new Date().toISOString(), dispatchId, kind, text, ...(detail ? { detail } : {}) };
    opts.sink?.(e);
    fanOut(e);
  };
  emitAgentEvent({ agent: "design", phase: "dispatch", label: input.request.slice(0, 80), detail: { dispatchId } });
  const meter: Meter = { cap: Math.min(cfg.design.maxDispatchUsd, input.maxUsd ?? cfg.design.maxDispatchUsd), spent: 0 };
  const failed = (summary: string, extra: Partial<MockupResult> = {}): MockupResult => {
    emit("error", summary);
    emitAgentEvent({ agent: "design", phase: "error", label: summary.slice(0, 80), detail: { dispatchId } });
    const r: MockupResult = {
      dispatchId,
      project: input.project,
      featureSlug: input.featureSlug ?? extra.featureSlug ?? "",
      screenName: input.screenName ?? extra.screenName ?? "",
      ok: false,
      url: null,
      pagePath: extra.pagePath ?? "",
      indexPath: extra.indexPath ?? "",
      images: extra.images ?? [],
      audit: extra.audit ?? null,
      composer: extra.composer ?? null,
      costUsd: meter.spent,
      openQuestions: extra.openQuestions ?? [],
      summary,
    };
    persistResult(r);
    return r;
  };

  // 1. project + docs
  let ref: ProjectRef;
  try {
    ref = resolveProjectRoot(input.project);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
  ensureProjectLayout(ref);
  const boot = bootstrapProject(ref);
  if (boot.created) emit("info", "first contact: wrote design.md and .prism/brief.md with concrete defaults — worth a read and an edit", { root: ref.root });
  const designMd = readDesignDoc(ref) ?? boot.designMd;
  const briefMd = readBrief(ref) ?? boot.briefMd;

  // 2. tokens — refuse to compose against a half-shaped design system
  let tokens;
  try {
    tokens = parseTokens(designMd);
  } catch (err) {
    if (err instanceof TokenError) return failed(`${err.message} — fix ${path.join(ref.root, "design.md")} and dispatch again`);
    throw err;
  }
  emit("info", `project ${ref.slug} · cap $${meter.cap.toFixed(2)} · ${imagesAvailable() ? "images on" : "images off (no GEMINI_API_KEY)"}`);

  // 3. plan
  const featureMd = input.featureSlug ? readFeatureDoc(ref, input.featureSlug) : null;
  const refsBefore = input.featureSlug ? listReferenceImages(ref, input.featureSlug) : [];
  let plan: Plan;
  try {
    const planned = await runPlanner({
      projectSlug: ref.slug,
      request: input.request,
      ...(input.featureSlug ? { featureSlug: input.featureSlug } : {}),
      ...(input.screenName ? { screenName: input.screenName } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      designMd,
      briefMd,
      featureMd,
      tokens,
      imagesAvailable: imagesAvailable(),
      referenceImages: refsBefore,
      budgetUsd: meter.cap,
    });
    meter.spent += planned.costUsd;
    plan = planned.plan;
    for (const n of planned.notes) emit("warn", `planner: ${n}`);
    emit("info", `plan: ${plan.summary}`, { featureSlug: plan.featureSlug, screenName: plan.screenName, components: plan.components, images: plan.images.length, costUsd: planned.costUsd });
  } catch (err) {
    return failed(`planning failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!plan.proceed) {
    const r = failed(`the brief wins: ${plan.briefConflict ?? "the request conflicts with a standing decision"} — ask Umberto before composing`, {
      featureSlug: plan.featureSlug,
      screenName: plan.screenName,
      openQuestions: plan.openQuestions,
    });
    return { ...r, ok: false };
  }
  if (opts.signal?.aborted) return failed("cancelled before composing");

  // 4. feature doc + references
  if (!readFeatureDoc(ref, plan.featureSlug)) {
    writeFeatureDoc(ref, plan.featureSlug, featureTemplate({ slug: plan.featureSlug, title: plan.featureTitle, intent: plan.featureIntent }));
    emit("info", `wrote features/${plan.featureSlug}.md`);
  }
  appendFeatureLog(ref, plan.featureSlug, `dispatch ${dispatchId}: ${plan.screenName} — ${plan.summary}`);
  let referenceImages: string[] = [];
  try {
    referenceImages =
      input.referenceImages && input.referenceImages.length > 0
        ? validateReferenceImages(ref, plan.featureSlug, input.referenceImages)
        : listReferenceImages(ref, plan.featureSlug);
  } catch (err) {
    emit("warn", `references: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (referenceImages.length > 0) emit("info", `${referenceImages.length} reference image(s) under .prism/references/${plan.featureSlug}/`);

  // 5. scaffold-or-skip; keep token-derived files in sync with design.md
  const scaffold = prepareScaffold(ref, tokens);
  if (scaffold.created) emit("info", `scaffolded the preview app (${scaffold.files.length} files) — first build will npm install`);
  else refreshTokenFiles(ref, tokens);

  // 6. images (only when planned + available; each is a fixed price)
  const images: Array<{ result: ImageResult; alt: string }> = [];
  for (const img of plan.images) {
    if (remaining(meter) < 1.5) {
      emit("warn", `skipping image ${img.slug}: only $${remaining(meter).toFixed(2)} left, the composer needs it`);
      continue;
    }
    try {
      const result = await generateImage(
        { project: ref, featureSlug: plan.featureSlug, slug: img.slug, prompt: img.prompt, quality: img.quality, aspect: img.aspect },
        { tokens },
      );
      meter.spent += result.costUsd;
      images.push({ result, alt: img.alt });
      emit("image", `image ${img.slug} → ${result.url}`, { model: result.model, costUsd: result.costUsd });
    } catch (err) {
      emit("warn", `image ${img.slug} failed: ${err instanceof Error ? err.message : String(err)} — composing without it`);
    }
  }
  if (opts.signal?.aborted) return failed("cancelled before composing", { images: images.map((i) => i.result) });

  // 7. compose
  const paths = composerPaths({ projectRoot: ref.root, featureSlug: plan.featureSlug, screenName: plan.screenName });
  if (remaining(meter) < 1) {
    return failed(`only $${remaining(meter).toFixed(2)} of the $${meter.cap.toFixed(2)} cap is left — not enough to compose`, { images: images.map((i) => i.result) });
  }
  const composerFor = (prompt: string, maxTurns: number): Promise<ComposerResult> =>
    runComposer({
      dispatchId,
      projectRoot: ref.root,
      prompt,
      model: cfg.design.composerModel,
      maxTurns,
      maxBudgetUsd: Math.max(0.5, Math.round(remaining(meter) * 0.9 * 100) / 100),
      onEvent: (e) => {
        opts.sink?.(e);
        fanOut(e);
      },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });

  let installCommands: string[] = [];
  try {
    installCommands = installCommandsFor(plan.components);
  } catch (err) {
    emit("warn", `install commands: ${err instanceof Error ? err.message : String(err)}`);
  }
  const prompt = buildComposerPrompt({
    projectSlug: ref.slug,
    projectRoot: ref.root,
    featureSlug: plan.featureSlug,
    screenName: plan.screenName,
    description: plan.description,
    visualDirection: plan.visualDirection,
    quality: plan.quality,
    tokens,
    components: plan.components,
    images,
    referenceImages,
    forbiddenMoves: plan.forbiddenMoves,
    standingDecisions: plan.standingDecisions,
    installed: isInstalled(ref),
    installCommands,
  });
  emit("info", `composing ${plan.featureSlug}/${plan.screenName} with Claude Code (${cfg.design.composerModel}, ≤ ${cfg.design.composerMaxTurns} turns, ≤ $${(remaining(meter) * 0.9).toFixed(2)})`);
  let composer = await composerFor(prompt, cfg.design.composerMaxTurns);
  meter.spent += composer.costUsd;

  // 8. verify + audit (+ one repair round)
  const imageUrls = images.map((i) => i.result.url);
  const verify = (): { built: boolean; report: AuditReport | null; tsx: string | null } => {
    const built = isBuilt(ref, plan.featureSlug, plan.screenName);
    const pagePath = pageFile(ref, plan.featureSlug, plan.screenName);
    const tsx = fs.existsSync(pagePath) ? fs.readFileSync(pagePath, "utf8") : null;
    const report = tsx ? auditPageTsx(tsx, { imageUrls }) : null;
    return { built, report, tsx };
  };
  let v = verify();
  if (v.report) for (const c of v.report.checks) emit("audit", `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  if (composer.subtype === "aborted") return failed("cancelled during composing", { composer, images: imageUrls.length ? images.map((i) => i.result) : [] });
  const needsRepair = !v.built || !v.report || !v.report.pass;
  if (needsRepair && remaining(meter) >= 1.5 && !opts.signal?.aborted) {
    emit("info", `repair round: ${!v.built ? "no static export yet" : "audit failed"} · $${remaining(meter).toFixed(2)} left`);
    const repair = await composerFor(
      buildRepairPrompt({
        pageRel: paths.pageRel,
        outRel: paths.outRel,
        built: v.built,
        auditText: v.report ? renderAuditForPrompt(v.report) : "✗ page.tsx does not exist yet",
        imageUrls,
      }),
      Math.max(8, Math.floor(cfg.design.composerMaxTurns / 2)),
    );
    meter.spent += repair.costUsd;
    composer = { ...repair, costUsd: composer.costUsd + repair.costUsd, turns: composer.turns + repair.turns };
    v = verify();
    if (v.report) for (const c of v.report.checks) emit("audit", `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
  }

  // 9. result
  const url = v.built ? mockupUrl(ref.slug, plan.featureSlug, plan.screenName) : null;
  const ok = v.built && !!v.report?.pass;
  const auditSummary = v.report ? `${v.report.checks.filter((c) => c.ok).length}/${v.report.checks.length} audit checks` : "no page.tsx";
  const summary = v.built
    ? `${ok ? "ready" : "built, but the audit still fails"}: ${plan.featureSlug}/${plan.screenName} at ${url} · ${auditSummary} · $${meter.spent.toFixed(2)}`
    : `no static export for ${plan.featureSlug}/${plan.screenName} after ${composer.turns} composer turns (${composer.subtype}) · $${meter.spent.toFixed(2)}`;
  if (v.built) {
    upsertMockup(ref, { feature: plan.featureSlug, screen: plan.screenName, title: plan.featureTitle, url: url!, builtAt: new Date().toISOString() });
    appendFeatureLog(ref, plan.featureSlug, `${plan.screenName} ${ok ? "ready" : "built (audit failing)"} → ${url} ($${meter.spent.toFixed(2)})`);
  } else {
    appendFeatureLog(ref, plan.featureSlug, `${plan.screenName} failed: ${composer.subtype} ($${meter.spent.toFixed(2)})`);
  }
  emit(ok ? "info" : "warn", summary, { costUsd: meter.spent, url });
  emitAgentEvent({ agent: "design", phase: ok ? "done" : "error", label: summary.slice(0, 80), detail: { dispatchId, url } });
  const result: MockupResult = {
    dispatchId,
    project: ref.slug,
    featureSlug: plan.featureSlug,
    screenName: plan.screenName,
    ok,
    url,
    pagePath: paths.pageRel,
    indexPath: paths.outRel,
    images: images.map((i) => i.result),
    audit: v.report,
    composer,
    costUsd: meter.spent,
    openQuestions: plan.openQuestions,
    summary,
  };
  persistResult(result);
  return result;
}

function persistResult(r: MockupResult): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    writeFileAtomic(path.join(LOG_DIR, `${r.dispatchId}.result.json`), JSON.stringify(r, null, 2) + "\n");
  } catch {
    // the log must never take the dispatch down
  }
  audit("design_dispatch", { dispatchId: r.dispatchId, project: r.project, feature: r.featureSlug, screen: r.screenName, ok: r.ok, costUsd: r.costUsd, url: r.url });
}

// ── background job: one at a time; a loud notice when it lands ─────────────
export interface DispatchHandle {
  id: string;
  input: DispatchInput;
  startedAt: string;
  promise: Promise<MockupResult>;
  cancel: () => void;
  events: DesignEvent[];
}
let current: DispatchHandle | null = null;
const recent: MockupResult[] = [];

export function currentDispatch(): DispatchHandle | null {
  return current;
}
export function recentDispatches(): MockupResult[] {
  return recent.slice(0, 10);
}

// onNotice lets the host (face server) push the completion notice to every
// connected client the moment it lands — addNotice alone only files it.
export function startDispatch(input: DispatchInput, opts: { onNotice?: (n: Notice) => void } = {}): DispatchHandle {
  if (current) throw new Error(`a design dispatch is already running (${current.id}, ${current.input.project}: ${current.input.request.slice(0, 60)}) — wait for it or cancel it first`);
  const id = crypto.randomBytes(4).toString("hex");
  const ac = new AbortController();
  const events: DesignEvent[] = [];
  const handle: DispatchHandle = {
    id,
    input,
    startedAt: new Date().toISOString(),
    cancel: () => ac.abort(),
    events,
    promise: runDispatch(input, {
      dispatchId: id,
      signal: ac.signal,
      sink: (e) => {
        events.push(slimEvent(e));
        if (events.length > 400) events.shift();
      },
    })
      .catch(
        (err): MockupResult => ({
          dispatchId: id,
          project: input.project,
          featureSlug: input.featureSlug ?? "",
          screenName: input.screenName ?? "",
          ok: false,
          url: null,
          pagePath: "",
          indexPath: "",
          images: [],
          audit: null,
          composer: null,
          costUsd: 0,
          openQuestions: [],
          summary: `dispatch crashed: ${err instanceof Error ? err.message : String(err)}`,
        }),
      )
      .then((r) => {
        recent.unshift(r);
        if (recent.length > 20) recent.pop();
        current = null;
        const text = r.ok
          ? `Design ready — ${r.project} ${r.featureSlug}/${r.screenName}: ${r.url} (${r.costUsd.toFixed(2)} USD)`
          : `Design dispatch ${r.dispatchId} did not finish cleanly: ${r.summary}`;
        const notice = addNotice("design", text, "loud");
        osNotification(text);
        opts.onNotice?.(notice);
        return r;
      }),
  };
  current = handle;
  return handle;
}
