import { z } from "zod";
import crypto from "node:crypto";
import type { EveTool } from "../core/registry.js";
import { readJson, writeJson } from "../core/store.js";
import { localDate } from "../core/time.js";

export interface Reminder {
  id: string;
  text: string;
  due: string | null; // ISO 8601, local time
  createdAt: string;
  done: boolean;
}

const FILE = "reminders.json";
export const loadReminders = (): Reminder[] => readJson<Reminder[]>(FILE, []);
const save = (r: Reminder[]) => writeJson(FILE, r);

const fmt = (r: Reminder) =>
  `[${r.id}] ${r.text}${r.due ? ` (due ${r.due})` : ""}${r.done ? " ✓done" : ""}`;

export const reminderTools: EveTool[] = [
  {
    name: "add_reminder",
    description:
      "Add a reminder or to-do for Umberto. Use this whenever he asks to be reminded of something or mentions a task he wants tracked. Compute an absolute due date/time from the conversation when he gives one (e.g. 'tomorrow at 9' → an ISO timestamp).",
    schema: z.object({
      text: z.string().min(1).describe("What to remind him about, in his own words"),
      due: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, "ISO date or datetime")
        .optional()
        .describe("When it's due, as ISO 8601 local time (e.g. 2026-08-15T09:00). Omit if no deadline."),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const reminders = loadReminders();
      const r: Reminder = {
        id: crypto.randomBytes(3).toString("hex"),
        text: String(input.text),
        due: (input.due as string | undefined) ?? null,
        createdAt: new Date().toISOString(),
        done: false,
      };
      reminders.push(r);
      save(reminders);
      return `Saved: ${fmt(r)}`;
    },
  },
  {
    name: "list_reminders",
    description:
      "List Umberto's reminders/to-dos. Use this before answering any question about what's on his list, what's due, or what he has to do today — never answer from memory.",
    schema: z.object({
      filter: z
        .enum(["open", "today", "all"])
        .default("open")
        .describe("'open' = not done; 'today' = open and due today or overdue; 'all' = everything"),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const all = loadReminders();
      const today = localDate();
      let picked = all;
      if (input.filter === "open") picked = all.filter((r) => !r.done);
      if (input.filter === "today")
        picked = all.filter((r) => !r.done && r.due !== null && r.due.slice(0, 10) <= today);
      if (picked.length === 0) return "No reminders match.";
      return picked.map(fmt).join("\n");
    },
  },
  {
    name: "complete_reminder",
    description:
      "Mark one of Umberto's reminders as done. Needs the reminder's id — call list_reminders first if you don't have it.",
    schema: z.object({
      id: z.string().min(1).describe("The reminder id, e.g. 'a1b2c3'"),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const reminders = loadReminders();
      const r = reminders.find((x) => x.id === input.id);
      if (!r) throw new Error(`no reminder with id "${String(input.id)}" — list_reminders shows current ids`);
      r.done = true;
      save(reminders);
      return `Done: ${fmt(r)}`;
    },
  },
];
