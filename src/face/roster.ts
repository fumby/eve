// The constellation's roster: who orbits the orb. Only real sub-agents — the
// board's seats as they exist in board/*.md, the Head of Design, and the
// Researcher. Delivered in the face snapshot; the client falls back to a
// built-in list only when a server predates this.
import type { AgentDescriptor } from "../core/agent-events.js";
import { loadSeats, type Seat } from "../board/dossier.js";

const SEAT_COLORS: Record<string, string> = {
  drucker: "#67E8F9",
  munger: "#A78BFA",
  newport: "#5B8BF0",
  hormozi: "#E88FB3",
};

/** A stable cool-palette colour (teal→blue→violet, never amber) for an unknown id. */
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = 170 + (h % 90);
  return hslToHex(hue, 0.75, 0.68);
}

function hslToHex(h: number, s: number, l: number): string {
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
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** Pure: seats first (in dossier order), then the two built-in agents. */
export function buildRoster(seats: Seat[]): AgentDescriptor[] {
  const out: AgentDescriptor[] = seats.map((s) => ({
    id: s.id,
    name: s.name,
    specialty: s.seat,
    color: SEAT_COLORS[s.id] ?? colorFor(s.id),
  }));
  out.push({ id: "design", name: "Head of Design", specialty: "design_dispatch", color: "#F0A6FF", initial: "HD" });
  out.push({ id: "research", name: "Researcher", specialty: "deep_research", color: "#7DD3FC" });
  return out;
}

let cached: AgentDescriptor[] | null = null;
export function agentRoster(): AgentDescriptor[] {
  if (cached) return cached;
  try {
    cached = buildRoster(loadSeats().seats);
  } catch {
    cached = buildRoster([]);
  }
  return cached;
}
