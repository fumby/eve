// Lazy per-node detail. The skeleton stays small; bodies load only when a node
// is clicked. Ids are namespaced, so routing is just a prefix split.
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadConfig } from "../core/config.js";
import { listMemories } from "../memory/store.js";
import { loadReminders } from "../tools/reminders.js";
import { getConversation } from "../core/conversations.js";
import { embed, nearestNeighbors } from "./embed.js";
import { KNOWLEDGE_MANIFEST } from "./skeleton.js";

export interface NodeDetail {
  id: string;
  type: string;
  title: string;
  body: string;
  fields: { label: string; value: string }[];
  neighbors?: { id: string; label: string; sim: number }[];
}

export async function nodeDetail(id: string): Promise<NodeDetail | null> {
  const sep = id.indexOf(":");
  if (sep < 0) return null;
  const kind = id.slice(0, sep);
  const rest = id.slice(sep + 1);

  if (kind === "core") {
    const cfg = loadConfig();
    return {
      id,
      type: "agent",
      title: "EVE",
      body: "The agent itself — brain, tools, memory and voice.",
      fields: [
        { label: "model", value: cfg.model },
        { label: "effort", value: cfg.effort },
        { label: "voice", value: cfg.voice.ttsModel },
        { label: "recogniser", value: `${cfg.stt.scribeModel} (ElevenLabs Scribe)` },
      ],
    };
  }

  if (kind === "mem") {
    const memories = listMemories();
    const me = memories.find((m) => m.name === rest);
    if (!me) return null;
    const items = memories.map((m) => ({
      id: `mem:${m.name}`,
      text: `${m.hook}. ${m.body.slice(0, 300)}`,
    }));
    let vectors = new Map<string, number[]>();
    try {
      vectors = (await embed(items)).vectors;
    } catch {
      // lexical fallback below
    }
    const near = nearestNeighbors(id, items, vectors)
      .filter((n) => n.sim > 0)
      .map((n) => ({
        id: n.id,
        label: memories.find((m) => `mem:${m.name}` === n.id)?.hook ?? n.id,
        sim: Number(n.sim.toFixed(3)),
      }));
    return {
      id,
      type: "memory",
      title: me.hook,
      body: me.body || me.hook,
      fields: [
        { label: "type", value: me.type },
        { label: "created", value: me.created || "unknown" },
        { label: "name", value: me.name },
      ],
      neighbors: near,
    };
  }

  if (kind === "thread") {
    const conv = getConversation(rest);
    if (!conv) return null;
    return {
      id,
      type: "thread",
      title: "Conversation",
      body: conv.turns
        .map((t) => `${t.role === "user" ? "Umberto" : "EVE"}: ${t.text}`)
        .join("\n\n"),
      fields: [
        { label: "started", value: new Date(conv.startedAt).toLocaleString() },
        { label: "turns", value: String(conv.turns.length) },
        { label: "via", value: conv.source },
      ],
    };
  }

  if (kind === "task") {
    const r = loadReminders().find((x) => x.id === rest);
    if (!r) return null;
    return {
      id,
      type: "reminder",
      title: "Reminder",
      body: r.text,
      fields: [
        { label: "due", value: r.due ?? "no deadline" },
        { label: "created", value: new Date(r.createdAt).toLocaleString() },
        { label: "done", value: r.done ? "yes" : "no" },
      ],
    };
  }

  if (kind === "know") {
    // Manifest paths only. Serving an arbitrary path here would be a directory
    // traversal straight out of the repo.
    if (!(KNOWLEDGE_MANIFEST as readonly string[]).includes(rest)) return null;
    const full = path.join(ROOT, rest);
    if (!fs.existsSync(full)) return null;
    const text = fs.readFileSync(full, "utf8");
    return {
      id,
      type: "knowledge",
      title: rest,
      body: text.length > 4000 ? text.slice(0, 4000) + "\n…(truncated)" : text,
      fields: [{ label: "bytes", value: String(fs.statSync(full).size) }],
    };
  }

  if (kind === "tool" || kind === "cat" || kind === "integ") {
    return {
      id,
      type: kind === "tool" ? "tool" : kind === "cat" ? "category" : "integration",
      title: rest,
      body:
        kind === "tool"
          ? "A capability EVE can invoke during a turn."
          : kind === "cat"
            ? "A group of related tools."
            : "An external service EVE depends on.",
      fields: [],
    };
  }

  return null;
}
