// Self-knowledge, derived — never hand-written prose that rots. Everything
// here is read from what the system actually exposes: the live tool registry,
// the board's parsed dossiers, the heartbeat's configured checks, the voice
// stack in config. If a capability isn't derivable, EVE doesn't claim it.
import { loadConfig } from "../core/config.js";
import { loadSeats } from "../board/dossier.js";

export interface ToolInfo {
  name: string;
  description?: string;
}

function firstSentence(text: string | undefined): string {
  if (!text) return "";
  const dot = text.indexOf(". ");
  return (dot > 0 ? text.slice(0, dot + 1) : text).trim();
}

export function capabilitiesSection(tools: ToolInfo[]): string {
  const cfg = loadConfig();
  const lines: string[] = [];

  if (tools.length > 0) {
    lines.push(
      "Tools you can call this very turn:",
      ...tools.map((t) => `- ${t.name}: ${firstSentence(t.description)}`),
    );
  }

  lines.push(
    "",
    `Voice: you speak (ElevenLabs ${cfg.voice.ttsModel}) and hear — ElevenLabs Scribe recognises 90+ languages with automatic detection; Deepgram powers the live captions.`,
    "Web: you can search and fetch the live web in any conversation; deep_research runs a thorough sourced investigation (costs real money per run).",
  );

  try {
    const { seats } = loadSeats();
    if (seats.length > 0) {
      lines.push(
        `Board of advisors (convened via convene_board, cap $${cfg.board.maxMeetingUSD}/meeting): ` +
          seats.map((s) => `${s.name} (${s.seat})`).join(", ") +
          ".",
      );
    }
  } catch {
    // no board on disk = no board claimed
  }

  const checks = cfg.heartbeat.checks
    .map((c) => `${c.name} every ${c.intervalMinutes >= 1440 ? `${Math.round(c.intervalMinutes / 1440)}d` : `${c.intervalMinutes}min`}${typeof c.at === "string" ? ` at ${c.at}` : ""}`)
    .join("; ");
  lines.push(
    `Heartbeat: you check in on your own (${checks}), quiet hours ${cfg.quietHours.start}–${cfg.quietHours.end}${cfg.heartbeat.paused ? " — currently PAUSED" : ""}.`,
    `Where Umberto finds you: the EVE desktop app / http://127.0.0.1:${cfg.face.port} (your face; /mind is the live map of this very memory), plus the terminal REPL and voice mode.`,
    "You have no email, calendar, or messaging access at all. Actions that spend, delete, or change settings are gated IN CODE: calling such a tool automatically shows Umberto a confirm prompt, and nothing happens until he approves it there. So when he asks for one, call the tool directly — the gate does the asking. Never substitute your own verbal double-check for that gate, and never claim a declined action happened.",
  );

  return `# What you can do (derived from your real configuration — claim nothing beyond it)
${lines.join("\n")}`;
}
