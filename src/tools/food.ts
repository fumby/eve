// EVE's food & nutrition module — the "I'm hungry" moment.
//
// When Umberto says "ho fame / I'm hungry", EVE:
//   1. Reads his food preferences from memory (healthy focus, dislikes,
//      budget) — collected once, applied always.
//   2. Researches real options near him: delivery restaurants (via web
//      search), simple healthy recipes, and grocery items for cooking.
//   3. Opens a dedicated OPTIONS WINDOW (served by the face at /options)
//      with cards: each option is titled, described, priced, and carries an
//      "Order" button that deep-links Uber Eats (or the right app) with the
//      restaurant pre-selected — the actual ordering stays in his hands.
//
// The window is composed by the server from a structured payload the tool
// produces — EVE fills a real schema, the window renders it. Research is
// real (perplexity_search / web fetch), never invented restaurants.
import { z } from "zod";
import { STATE_ROOT } from "../core/config.js";
import { readJson, writeJson } from "../core/store.js";
import { audit } from "../core/audit.js";
import { emitUiWindow } from "../core/ui-bus.js";
import type { EveTool } from "../core/registry.js";

// ── His food profile: stored once, edited by him (or via update by EVE on
// his explicit say-so). This is preference state, not a memory — task-shaped
// and current, the same doctrine as commitments/decisions.
export interface FoodProfile {
  style: "healthy" | "balanced" | "indulgent";
  diet: string[]; // e.g. ["no fried", "high protein"]
  dislikes: string[];
  allergies: string[];
  budgetEur: number | null; // per meal
  cuisines: string[]; // favourites first
  city: string; // where he is (delivery area)
  updatedAt: string;
}

const PROFILE_FILE = "food-profile.json";

export function loadFoodProfile(): FoodProfile | null {
  return readJson<FoodProfile | null>(PROFILE_FILE, null);
}

function saveFoodProfile(p: FoodProfile): void {
  writeJson(PROFILE_FILE, p);
}

// ── The options window payload. One card per option; the window renders
// whatever arrives. Written to data/options-window.json; the face serves
// /options which reads it live (and the phone can open the same page).
export interface FoodOption {
  kind: "restaurant" | "recipe" | "grocery";
  title: string;
  subtitle: string; // one line: what it is
  why: string; // why it fits HIM (healthy, liked cuisine, price)
  price: string; // display string
  eta: string; // "25-35 min" or "cooking: 15 min"
  orderUrl: string | null; // Uber Eats deep link / supermarket link
  healthy: boolean;
  tags: string[];
}

interface OptionsWindow {
  openedAt: string;
  title: string;
  intro: string;
  options: FoodOption[];
}

const OPTIONS_FILE = "options-window.json";

function saveOptionsWindow(w: OptionsWindow): void {
  writeJson(OPTIONS_FILE, w);
}

// Uber Eats deep links: ubereats:// opens the app; the https fallback works
// in a browser. Restaurant URLs from real search results pass through.
function uberEatsLink(restaurantUrl: string): string {
  // If the search result is already a ubereats.com URL, use it as-is;
  // otherwise a search deep link on the cuisine in his city.
  if (restaurantUrl.includes("ubereats.com") || restaurantUrl.includes("ubere")) return restaurantUrl;
  return restaurantUrl; // external link passed verbatim — it came from real search
}

// ── The learning loop: every order/choice and how it went. EVE reads this
// BEFORE researching (so past errors and wins shape the search) and appends
// AFTER the outcome is known. This is what makes her faster and better over
// time: the second "I'm hungry" starts from the first one's lessons.
export interface FoodMemoryEntry {
  id: string;
  at: string;
  moment: string; // what he asked, e.g. "dinner, hungry, healthy"
  chosen: string; // what he actually picked/ordered
  platform: string; // where it came from
  outcome: "loved" | "good" | "ok" | "bad" | null; // null = not yet rated
  note: string; // one line: why it worked or didn't
}

const FOOD_MEMORY_FILE = "food-history.json";

export function loadFoodHistory(): FoodMemoryEntry[] {
  return readJson<FoodMemoryEntry[]>(FOOD_MEMORY_FILE, []);
}

function saveFoodHistory(list: FoodMemoryEntry[]): void {
  // Bounded: the newest 200 — this is working memory for suggestions, not
  // an archive; the patterns live in the last months of choices.
  writeJson(FOOD_MEMORY_FILE, list.slice(-200));
}

export const foodTools: EveTool[] = [
  {
    name: "get_food_history",
    description:
      "Read Umberto's food history — what he chose in past 'I'm hungry' moments, from which platform, and how each went (loved/good/ok/bad). READ THIS BEFORE researching new food options: past wins deserve to be suggested again (he picks them for real reasons), past 'bad' outcomes get avoided or warned about, and patterns ('always picks poke on Fridays', 'never finishes the sushi portions') shape the search. Also use it when he asks 'what did I eat last week' or 'what did I think of that place'.",
    schema: z.object({
      limit: z.number().int().min(1).max(50).default(15).describe("How many recent entries. Default 15."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const all = loadFoodHistory();
      if (all.length === 0)
        return "No food history yet — this is the first round. After he picks something and tells you how it was (or you ask), record it with record_food_outcome.";
      const recent = all.slice(-Number(input.limit ?? 15));
      const lines = recent.map(
        (e) =>
          `[${e.at.slice(0, 10)}] ${e.moment} → ${e.chosen} (${e.platform}) — ${e.outcome ?? "unrated"}${e.note ? `: ${e.note}` : ""}`,
      );
      // Pattern extraction hint: the wins and the fails, in one line each.
      const loved = all.filter((e) => e.outcome === "loved");
      const bad = all.filter((e) => e.outcome === "bad");
      const summary = [
        loved.length ? `He LOVED: ${loved.slice(-5).map((e) => e.chosen).join("; ")}` : "",
        bad.length ? `Avoid/fix: ${bad.slice(-5).map((e) => `${e.chosen} (${e.note})`).join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return `Food history (${all.length} entries, showing ${recent.length}):\n${lines.join("\n")}${summary ? `\n\nPatterns:\n${summary}` : ""}`;
    },
  },
  {
    name: "record_food_outcome",
    description:
      "Record what Umberto chose and how it went — one entry per food moment. Use it (a) when he picks an option from the window ('he ordered the salmon poke'), and (b) when the outcome is known ('it was amazing' / 'arrived cold' / 'portion tiny'). Ask him for the verdict later if he doesn't volunteer it — a short 'com'era?' earns every future suggestion. The history is what makes next time faster and better.",
    schema: z.object({
      moment: z.string().min(3).max(120).describe("What the moment was, e.g. 'dinner, hungry, wanted healthy'"),
      chosen: z.string().min(2).max(120).describe("What he picked/ordered"),
      platform: z.string().max(60).describe("Where it came from: Uber Eats, Deliveroo, restaurant direct, home-cooked…"),
      outcome: z.enum(["loved", "good", "ok", "bad"]).optional().describe("How it went, if known yet. Omit to record the choice now and rate later."),
      note: z.string().max(300).optional().describe("One line worth remembering: why it worked/didn't, portion, price feel"),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const list = loadFoodHistory();
      // Update the most recent unrated entry if this is a verdict on it.
      const last = list[list.length - 1];
      if (input.outcome && last && last.outcome === null && last.chosen === String(input.chosen)) {
        last.outcome = String(input.outcome) as FoodMemoryEntry["outcome"];
        if (input.note) last.note = String(input.note);
        saveFoodHistory(list);
        audit("food_outcome_updated", { chosen: last.chosen, outcome: last.outcome });
        return `Updated: ${last.chosen} → ${last.outcome}${input.note ? ` (${last.note})` : ""}. I'll weigh this next time.`;
      }
      const entry: FoodMemoryEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: new Date().toISOString(),
        moment: String(input.moment),
        chosen: String(input.chosen),
        platform: String(input.platform),
        outcome: input.outcome ? (String(input.outcome) as FoodMemoryEntry["outcome"]) : null,
        note: input.note ? String(input.note) : "",
      };
      list.push(entry);
      saveFoodHistory(list);
      audit("food_choice_recorded", { chosen: entry.chosen, platform: entry.platform });
      return `Noted: ${entry.chosen} from ${entry.platform}${entry.outcome ? ` — ${entry.outcome}` : " (rate it later)"}. This shapes future suggestions.`;
    },
  },
  {
    name: "set_food_preferences",
    description:
      "Save Umberto's food preferences — how he wants to eat. Use it when he tells you anything durable about food: 'mangio salutare', 'no fritto', 'sono allergico alla X', 'budget 15 euro', 'adoro il giapponese'. Stored once and applied to every future food suggestion; update it when he corrects you ('oggi magio quello che voglio' is a one-off, not a change). What's stored is what he SAID, not your inference.",
    schema: z.object({
      style: z.enum(["healthy", "balanced", "indulgent"]).optional().describe("Overall default style. Only set when he says it."),
      diet: z.array(z.string().min(2).max(80)).optional().describe("Dietary rules, e.g. ['high protein', 'no fried', 'vegetarian']"),
      dislikes: z.array(z.string().min(2).max(80)).optional().describe("Foods he doesn't want"),
      allergies: z.array(z.string().min(2).max(80)).optional().describe("Medical allergies — always excluded"),
      budgetEur: z.number().positive().max(200).nullable().optional().describe("Per-meal budget in EUR, or null to clear"),
      cuisines: z.array(z.string().min(2).max(40)).optional().describe("Favourite cuisines, best first"),
      city: z.string().min(2).max(80).optional().describe("City he's in (delivery area). Update when he moves."),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const current = loadFoodProfile() ?? {
        style: "healthy",
        diet: [],
        dislikes: [],
        allergies: [],
        budgetEur: null,
        cuisines: [],
        city: "",
        updatedAt: "",
      };
      const next: FoodProfile = {
        ...current,
        ...(input.style ? { style: String(input.style) as FoodProfile["style"] } : {}),
        ...(input.diet ? { diet: (input.diet as string[]).map(String) } : {}),
        ...(input.dislikes ? { dislikes: (input.dislikes as string[]).map(String) } : {}),
        ...(input.allergies ? { allergies: (input.allergies as string[]).map(String) } : {}),
        ...(input.budgetEur !== undefined ? { budgetEur: input.budgetEur === null ? null : Number(input.budgetEur) } : {}),
        ...(input.cuisines ? { cuisines: (input.cuisines as string[]).map(String) } : {}),
        ...(input.city ? { city: String(input.city) } : {}),
        updatedAt: new Date().toISOString(),
      };
      saveFoodProfile(next);
      audit("food_profile_saved", { style: next.style, city: next.city, rules: next.diet.length });
      const bits = [
        `${next.style}`,
        next.diet.length ? `rules: ${next.diet.join(", ")}` : "",
        next.dislikes.length ? `no: ${next.dislikes.join(", ")}` : "",
        next.allergies.length ? `ALLERGIES: ${next.allergies.join(", ")}` : "",
        next.budgetEur ? `budget €${next.budgetEur}` : "",
        next.cuisines.length ? `loves: ${next.cuisines.join(", ")}` : "",
        next.city ? `city: ${next.city}` : "",
      ].filter(Boolean);
      return `Food preferences saved: ${bits.join(" · ")}. I'll apply these to every suggestion from now on.`;
    },
  },
  {
    name: "get_food_preferences",
    description:
      "Read Umberto's saved food preferences (style, rules, allergies, budget, favourite cuisines, city). Use it before any food suggestion, and when he asks 'what do you know about how I eat'.",
    schema: z.object({}),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async () => {
      const p = loadFoodProfile();
      if (!p)
        return "No food preferences saved yet — ask him a few quick ones (style, allergies, budget, cuisines he loves) and use set_food_preferences. Then every suggestion applies them.";
      return JSON.stringify(p, null, 2);
    },
  },
  {
    name: "open_options_window",
    description:
      "Open the options window — a dedicated window with cards of choices for Umberto, each with a title, a reason it fits him, price, time, and an Order/Open button. Use it after you've RESEARCHED real options for a moment like 'I'm hungry': every option must come from real search results or well-known recipes — never invent restaurants, prices, or links. RESEARCH BROADLY: don't limit to Uber Eats and Deliveroo — search every platform and the open web (Glovo, Just Eat, local restaurants with own delivery, review sites, Google Maps listings) and compare: sometimes a restaurant's own site delivers cheaper than the apps, and sometimes the best option isn't on any app. Use his city (from food preferences or location) to find what's actually available there. The window is served at /options (Mac and phone); he browses and orders himself. Prefer 4-8 options, mixed kinds when it makes sense (restaurants, recipes, groceries), each 'why' referencing his actual preferences and past feedback.",
    schema: z.object({
      title: z.string().min(3).max(80).describe("Window title, e.g. 'What to eat tonight' or 'Grocery run'"),
      intro: z.string().max(300).describe("One line to him above the cards, e.g. 'Healthy, fast, under 15€ — five I'd pick for you'"),
      options: z
        .array(
          z.object({
            kind: z.enum(["restaurant", "recipe", "grocery"]),
            title: z.string().min(2).max(120),
            subtitle: z.string().max(160),
            why: z.string().max(200),
            price: z.string().max(40),
            eta: z.string().max(40),
            orderUrl: z.string().url().nullable().optional().describe("Real link: Uber Eats page for the restaurant, or the recipe page, or the supermarket page. Null = no link."),
            healthy: z.boolean().default(false),
            tags: z.array(z.string().max(30)).max(6).default([]),
          }),
        )
        .min(2)
        .max(10),
    }),
    needsConfirmation: false,
    factoryAllowed: false,
    run: async (input) => {
      const options: FoodOption[] = (input.options as Array<Record<string, unknown>>).map((o) => ({
        kind: String(o.kind) as FoodOption["kind"],
        title: String(o.title),
        subtitle: String(o.subtitle),
        why: String(o.why),
        price: String(o.price),
        eta: String(o.eta),
        orderUrl: o.orderUrl ? uberEatsLink(String(o.orderUrl)) : null,
        healthy: o.healthy === true,
        tags: Array.isArray(o.tags) ? (o.tags as string[]).map(String) : [],
      }));
      const w: OptionsWindow = {
        openedAt: new Date().toISOString(),
        title: String(input.title),
        intro: String(input.intro),
        options,
      };
      saveOptionsWindow(w);
      audit("options_window_opened", { title: w.title, count: options.length });
      // Mac: apre la finestra opzioni subito (popup del browser).
      // Telefono: il browser del telefono non è raggiungibile da `open` —
      // ma il telefono è collegato via WebSocket alla faccia. Emit sul bus
      // UI: la faccia lo inoltra come `open_url` al client attivo, che apre
      // la pagina su sé stesso. La vecchia istruzione manuale ("digli il
      // link") resta come fallback nel testo di ritorno.
      emitUiWindow({ path: "/options", kind: "options_window" });
      // ONE delivery path, decided by the SERVER — the only place that knows
      // who is talking. The tool only emits the event; the face server opens
      // a real tab for a Mac turn (closable) or navigates the phone client.
      // Doing BOTH here (event + raw `open`) opened the window TWICE on the
      // Mac: a browser tab AND the face's own window navigating to /options —
      // which inside EVE.app has no back button, stranding the face. One
      // window, in the place that can close it.
      return (
        `The options window "${w.title}" is live with ${options.length} cards — it just opened in his browser on the Mac. ` +
        `On the PHONE he can't receive a browser-open from you: TELL HIM the link in your reply, in his language, like ` +
        `"te l'ho aperta sul Mac — sul telefono aprila qui: https://eve.tail1234.ts.net/options" — one clear line, the full URL. ` +
        `Then one line about what you found. The cards have the details.`
      );
    },
  },
];
