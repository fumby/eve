// Who orbits the orb, and how server events map onto the constellation.
// Only REAL sub-agents — the mind map refuses to invent any, and so does the
// face. The default roster is a fallback for the demo driver and for a server
// that predates snapshot.agents; the server's roster wins when present.
// Pure module.

export const DEFAULT_ROSTER = Object.freeze([
  { id: "drucker", name: "Drucker", specialty: "Management & Innovation", color: "#67E8F9" },
  { id: "munger", name: "Munger", specialty: "Judgment & Incentives", color: "#A78BFA" },
  { id: "newport", name: "Newport", specialty: "Focus & Career Capital", color: "#5B8BF0" },
  { id: "hormozi", name: "Hormozi", specialty: "Offers & Acquisition", color: "#E88FB3" },
  { id: "design", name: "Head of Design", specialty: "design_dispatch", color: "#F0A6FF", initial: "HD" },
  { id: "research", name: "Researcher", specialty: "deep_research", color: "#7DD3FC" },
]);

export const PHASES = Object.freeze(["dispatch", "working", "done", "error"]);

/** A design_event kind → the constellation phase it implies for the design agent. */
export function designEventToPhase(kind) {
  switch (kind) {
    case "error":
      return "error";
    case "info":
    case "cc_tool":
    case "cc_text":
    case "cc_result":
    case "image":
    case "audit":
    case "warn":
      return "working";
    default:
      return null;
  }
}

/**
 * Validate an agent_event message. Unknown agents are accepted only when the
 * message carries a descriptor (so a brand-new agent can appear at runtime).
 */
export function normalizeAgentEvent(msg, knownIds) {
  if (!msg || typeof msg !== "object") return null;
  const agent = typeof msg.agent === "string" ? msg.agent.trim() : "";
  if (!agent || !PHASES.includes(msg.phase)) return null;
  const known = knownIds instanceof Set ? knownIds.has(agent) : Array.isArray(knownIds) && knownIds.includes(agent);
  const d = msg.descriptor;
  const descriptor =
    d && typeof d === "object" && typeof d.name === "string"
      ? { id: agent, name: d.name, specialty: String(d.specialty ?? ""), color: d.color, avatarUrl: d.avatarUrl }
      : null;
  if (!known && !descriptor) return null;
  const out = { agent, phase: msg.phase };
  if (typeof msg.label === "string" && msg.label) out.label = msg.label;
  if (msg.detail && typeof msg.detail === "object") out.detail = msg.detail;
  if (descriptor) out.descriptor = descriptor;
  return out;
}

/** Merge a server roster over the defaults: server entries win by id, order preserved. */
export function mergeRoster(serverList, defaults = DEFAULT_ROSTER) {
  const list = Array.isArray(serverList) ? serverList.filter((a) => a && typeof a.id === "string" && a.name) : [];
  if (list.length === 0) return defaults.map((a) => ({ ...a }));
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const dflt = defaults.find((d) => d.id === a.id);
    out.push({ ...(dflt || {}), ...a, color: a.color || dflt?.color || colorFor(a.id) });
  }
  return out;
}

/** A stable cool-palette colour for an id we have no colour for. */
export function colorFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = 170 + (h % 90); // 170..260: teal → blue → violet, never amber
  return hslToHex(hue, 0.75, 0.68);
}

function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}
