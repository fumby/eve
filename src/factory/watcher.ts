// Keeps the live tool registry in step with data/factory/agents.json without a
// restart: an approved agent gets its dispatch tool the next tick, an archived
// one loses it. Diffing by slug against what we last saw keeps this cheap
// enough to run on every heartbeat — one small file read, no model calls.
import type { Registry } from "../core/registry.js";
import { audit } from "../core/audit.js";
import { activeAgents } from "./store.js";
import { dispatchToolName, type SpawnedAgent } from "./types.js";
import { buildDispatchTool } from "./runtime.js";
import { SLUG_RE } from "./generate.js";

// agents.json is hand-editable, so every row is checked before it becomes a
// tool. A bad row loses ITS tool and gets an audit line — it must never throw
// out of refresh() (which would skip revocations, or crash the tick loop) or
// ship an invalid tool name in every one of EVE's requests.
function isSaneRow(row: unknown): row is SpawnedAgent {
  const r = row as Partial<SpawnedAgent> | null;
  return (
    !!r &&
    typeof r.slug === "string" &&
    SLUG_RE.test(r.slug) &&
    typeof r.system_prompt === "string" &&
    r.system_prompt.length > 0 &&
    typeof r.model === "string" &&
    Array.isArray(r.tool_allowlist) &&
    r.tool_allowlist.every((t) => typeof t === "string")
  );
}

export class RegistryWatcher {
  private known = new Set<string>();

  // `loadActive` is a seam for tests (a stubbed agents list); production
  // reads the store.
  constructor(
    private registry: Registry,
    private loadActive: () => SpawnedAgent[] = activeAgents,
  ) {}

  refresh(): { registered: string[]; unregistered: string[] } {
    let loaded: SpawnedAgent[] = [];
    try {
      loaded = this.loadActive();
    } catch (err) {
      audit("factory_registry", { error: `load failed: ${String(err)}` });
      return { registered: [], unregistered: [] }; // keep what we have
    }
    const active = loaded.filter((row) => {
      if (isSaneRow(row)) return true;
      audit("factory_registry", { skipped: (row as { slug?: unknown })?.slug ?? "?", reason: "malformed row" });
      return false;
    });
    const activeSlugs = new Set(active.map((a) => a.slug));
    const registered: string[] = [];
    const unregistered: string[] = [];

    for (const row of active) {
      if (this.known.has(row.slug)) continue;
      try {
        this.registry.register(buildDispatchTool(row, this.registry));
        this.known.add(row.slug);
        registered.push(row.slug);
      } catch (err) {
        audit("factory_registry", { skipped: row.slug, reason: String(err) });
      }
    }
    // Archived or vanished (hand-deleted from the file) — either way the tool
    // must go, or EVE keeps offering a specialist that no longer exists.
    for (const slug of this.known) {
      if (activeSlugs.has(slug)) continue;
      this.registry.unregister(dispatchToolName(slug));
      this.known.delete(slug);
      unregistered.push(slug);
    }

    if (registered.length > 0 || unregistered.length > 0) {
      audit("factory_registry", { registered, unregistered });
    }
    return { registered, unregistered };
  }
}

// One call at boot: registers everything already active, hands back the
// watcher for the tick loop to keep calling. `loadActive` is the same test
// seam the watcher takes.
export function installWatcher(
  registry: Registry,
  loadActive: () => SpawnedAgent[] = activeAgents,
): RegistryWatcher {
  const w = new RegistryWatcher(registry, loadActive);
  w.refresh();
  return w;
}
