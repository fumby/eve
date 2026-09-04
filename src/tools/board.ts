import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { convene, loadMeetings } from "../board/meeting.js";

export const boardTools: EveTool[] = [
  {
    name: "convene_board",
    description:
      "Convene Umberto's board of advisors (Drucker, Munger, Newport, Hormozi) on a real decision — ventures, business ideas, offers, pricing, money, career, studies trade-offs. Use when he says 'ask the board', 'chiedi al consiglio', names an advisor, or wants genuinely different expert reads on a decision. Costs real money (up to ~$0.35), takes ~30s, so not for casual questions you can answer yourself. The result tells you exactly which part to say aloud.",
    schema: z.object({
      question: z
        .string()
        .min(10)
        .describe(
          "The decision or question, self-contained with the context that matters — the seats cannot see this conversation.",
        ),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const result = await convene(String(input.question));
      return result.message;
    },
  },
  {
    name: "board_minutes",
    description:
      "List recent board meetings (question, verdict, who abstained, cost). Use when Umberto asks what the board said previously or wants to revisit a past meeting.",
    schema: z.object({}),
    needsConfirmation: false,
    run: async () => {
      const meetings = loadMeetings().slice(0, 8);
      if (meetings.length === 0) return "The board has never met.";
      return meetings
        .map((m) => {
          const seats = m.opinions
            .map((o) => `${o.name}${o.abstained ? " (abstained)" : o.failed ? " (failed)" : ""}`)
            .join(", ");
          return `[${m.at.slice(0, 10)}${m.unprompted ? ", unprompted" : ""}] "${m.question.slice(0, 90)}" — ${seats}. ${m.spoken} (cost $${m.costUSD.toFixed(2)})`;
        })
        .join("\n");
    },
  },
];
