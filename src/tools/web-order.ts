// web_order — EVE orders food for Umberto through the delivery platforms,
// in HIS logged-in Chrome (dedicated profile), stopping at the last step for
// his yes. This is the end-to-end he asked for: "voglio una pizza margherita
// napoletana → trovami chi la fa meglio → ok, ordinamela tu".
//
// Design, in the order it matters:
// 1. The RESEARCH stays where it is (perplexity_search / the options
//    window): EVE picks the platform+item, this tool executes.
// 2. The tool takes a PLATFORM URL + item, drives Chrome via CDP: search,
//    open the item, add to cart, read the cart back.
// 3. Tier 6 gate fires on the ORDER action with the FULL cart content:
//    dishes, prices, total, platform. No confirm = no order. Ever.
// 4. Honest failure: DOM selectors on Uber Eats/Deliveroo change often; every
//    step reports what it saw, and a failed selector is an ERROR, never a
//    guess. Better "non ci sono riuscita, ecco il carrello aperto" than a
//    wrong order.
//
// The card-building is selector-agnostic where possible (text search on
// buttons/links via XPath on text content) — more robust than CSS classes
// that change per deploy.

import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { ensureChrome, getWsUrl, Cdp, sleep } from "./cdp.js";
import { audit } from "../core/audit.js";

const MAX_WAIT_MS = 90_000;

// Click the first element whose textContent matches (case-insensitive
// substring). Returns true if found+clicked.
async function clickByText(cdp: Cdp, text: string): Promise<boolean> {
  const escaped = JSON.stringify(text);
  return await cdp.eval(`(() => {
    const want = ${escaped}.toLowerCase();
    const nodes = document.querySelectorAll('button, a, [role="button"], div[tabindex]');
    for (const n of nodes) {
      const t = (n.innerText || n.textContent || "").trim().toLowerCase();
      if (t && (t.includes(want) || want.includes(t)) && t.length < 40) {
        n.scrollIntoView({ block: "center" });
        n.click();
        return true;
      }
    }
    return false;
  })()`);
}

// Type into the platform's search. Uber Eats' feed has NO real <input> —
// "Rechercher dans Uber Eats" is a button that opens the search page, where
// the real input appears. So: click any search-looking button/div first,
// wait for the input, then type.
async function typeSearch(cdp: Cdp, query: string): Promise<boolean> {
  // 1. If a real input is already there, use it.
  if (await hasSearchInput(cdp)) return fillSearch(cdp, query);
  // 2. Click the fake input (button/div with "rechercher"/"search" text).
  const escaped = JSON.stringify(query);
  const clicked = await cdp.eval(`(() => {
    const nodes = document.querySelectorAll('button, a, div[role="button"], div, span');
    for (const n of nodes) {
      const t = (n.innerText || n.textContent || "").trim().toLowerCase();
      if ((t.includes("rechercher") || t.includes("search") || t.includes("cerca")) && t.length < 60) {
        n.scrollIntoView({ block: "center" });
        n.click();
        return true;
      }
    }
    return false;
  })()`);
  if (!clicked) return false;
  // 3. Wait for the real input to appear on the search page (up to 10s).
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await hasSearchInput(cdp)) return fillSearch(cdp, query);
  }
  return false;
}

async function hasSearchInput(cdp: Cdp): Promise<boolean> {
  return await cdp.eval(`!!document.querySelector('input[type="search"], input[aria-label*="earch" i], input[name*="search" i], input[placeholder*="earch" i], input[placeholder*="echercher" i], input[aria-label*="echercher" i]')`);
}

async function fillSearch(cdp: Cdp, query: string): Promise<boolean> {
  const escaped = JSON.stringify(query);
  return await cdp.eval(`(() => {
    const inputs = document.querySelectorAll('input[type="search"], input[aria-label*="earch" i], input[name*="search" i], input[placeholder*="earch" i], input[placeholder*="echercher" i], input[aria-label*="echercher" i]');
    const inp = inputs[0];
    if (!inp) return false;
    inp.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(inp, ${escaped});
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
}

async function readCart(cdp: Cdp): Promise<string> {
  // Best-effort cart read: Uber Eats and Deliveroo both render cart items
  // with prices in a right-side panel. We grab the whole panel text.
  const raw = await cdp.eval(`(() => {
    const sels = ['[data-testid*="cart"]', 'main + aside', '[class*="cart" i]'];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.innerText && el.innerText.length > 10) return el.innerText.slice(0, 1200);
    }
    return "";
  })()`);
  return typeof raw === "string" ? raw : "";
}

async function findItemAndAdd(cdp: Cdp, search: string, item: string): Promise<string> {
  // Search results on Uber Eats/Deliveroo are RESTAURANTS (and store cards),
  // not products. So the flow is two-phase: open the first restaurant that
  // looks open, THEN find the item in its menu.
  // Phase 1: open a restaurant. Results render as links/cards; "open" ones
  // are clickable. EXCLUDE everything that isn't a restaurant page — the live
  // failure: a "become a partner" card (merchants.ubereats.com) matched the
  // broad selector and the turn ended on a signup page while reporting
  // success. Hard exclusions: merchants/signup/login/marketing.
  const qEsc = JSON.stringify(search);
  const opened = await cdp.eval(`(() => {
    const q = ${qEsc}.toLowerCase().split(/\\s+/);
    const links = [...document.querySelectorAll('a[href]')];
    let best = null, bestScore = -1;
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (/merchants|signup|connexion|inscription|\\/brand\\/|about|help/i.test(href)) continue;
      if (!a.querySelector('h2, h3, h4') || a.innerText.trim().length < 10) continue;
      // only store pages look like /store/<name>/<id>
      if (!/\\/store\\//.test(href)) continue;
      const t = (a.innerText || "").toLowerCase();
      let score = 0;
      for (const w of q) if (w.length > 3 && t.includes(w)) score += 2;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (best) { best.scrollIntoView({ block: "center" }); best.click(); return true; }
    return false;
  })()`);
  if (!opened) return `Non trovo ristoranti nei risultati — la pagina è aperta, guarda tu.`;
  await sleep(4000);
  // Phase 2: inside the restaurant page, find the item in the menu.
  const escaped = JSON.stringify(item);
  const found = await cdp.eval(`(() => {
    const want = ${escaped}.toLowerCase();
    const nodes = document.querySelectorAll('h2, h3, h4, li, [role="button"], div');
    for (const n of nodes) {
      const t = (n.innerText || "").trim().toLowerCase();
      if (t && t.includes(want) && t.length < 120) {
        n.scrollIntoView({ block: "center" });
        n.click();
        return true;
      }
    }
    return false;
  })()`);
  if (!found) return `Ho aperto un ristorante ma non vedo "${item}" nel menu — la pagina è aperta, dimmi cosa vedi.`;
  await sleep(2500);
  // Item dialog: an add-to-cart button (Uber Eats: "Add to cart" / "Aggiungi";
  // Deliveroo: "Add" / "Aggiungi al carrello").
  for (const label of ["aggiungi al carrello", "aggiungi", "add to cart", "add", "aggiungi all'ordine"]) {
    if (await clickByText(cdp, label)) {
      await sleep(1500);
      // Options dialog (size, extras) may need a second confirm.
      for (const l2 of ["aggiungi al carrello", "aggiungi", "add to order", "conferma"]) {
        await clickByText(cdp, l2); // idempotent: no-op if absent
      }
      await sleep(1500);
      const cart = await readCart(cdp);
      return `Aggiunto al carrello.\n\nCARRELLO:\n${cart || "(non riesco a leggere il carrello, ma la pagina è aperta)"}`;
    }
  }
  return `Ho aperto "${item}" ma non trovo il bottone per aggiungerlo — la finestra è aperta, dimmi cosa vedi.`;
}

async function placeOrder(cdp: Cdp): Promise<string> {
  // Go to checkout, then STOP: the order button is NEVER clicked here —
  // that's the gated action. This function only reaches the payment page
  // and reads back what it sees.
  for (const label of ["vai al checkout", "checkout", "continua", "procedi"]) {
    if (await clickByText(cdp, label)) { await sleep(3000); break; }
  }
  const page = await cdp.eval(`document.body.innerText.slice(0, 1500)`);
  return typeof page === "string" ? page : "";
}

export const webOrderTools: EveTool[] = [
  {
    name: "web_order",
    description:
      "Order food through a delivery platform in Umberto's Chrome (his own login, dedicated profile). Steps: navigate to the platform, search the item, add it to the cart, and STOP at checkout — the final order is a SEPARATE gated action (confirm_order) that requires his explicit yes with the full cart shown. Use after you've already chosen WHAT and WHERE via research. Honest failures: if a button or item isn't found, say so and leave the page open — never guess. First use on a platform may need him to log in once in the EVE Chrome window.",
    schema: z.object({
      url: z.string().url().describe("Platform URL, e.g. https://www.ubereats.com/fr or a restaurant's page."),
      search: z.string().min(1).max(120).describe("What to search on the platform, e.g. 'pizza margherita'."),
      item: z.string().min(1).max(120).describe("The exact item name to add to the cart, as listed."),
    }),
    needsConfirmation: false, // building the cart is reversible (no money, no order)
    factoryAllowed: false, // an agent must not build orders unattended
    run: async (input: { url: string; search: string; item: string }) => {
      await ensureChrome();
      const cdp = new Cdp();
      await cdp.connect(await getWsUrl());
      try {
        await cdp.send("Page.navigate", { url: input.url });
        await sleep(4000);
        // dismiss cookie walls, common on FR platforms
        for (const b of ["accetta", "accept", "accetto", "tout accepter"]) await clickByText(cdp, b);
        if (!(await typeSearch(cdp, input.search))) {
          return `Non trovo il campo di ricerca su ${input.url} — la pagina è aperta nel Chrome di EVE; dimmi cosa vedi e riprovo.`;
        }
        await sleep(1200);
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await sleep(4000);
        const result = await findItemAndAdd(cdp, input.search, input.item);
        audit("web_order", { platform: input.url, search: input.search, item: input.item, ok: result.startsWith("Aggiunto") });
        return result;
      } finally {
        cdp.close();
      }
    },
  },
  {
    name: "confirm_order",
    description:
      "Place the order that is sitting in the cart (built with web_order). NEVER call this without having shown Umberto the full cart and his explicit go-ahead in the conversation. This is the money action: the Tier 6 gate shows the cart total and platform before it runs.",
    schema: z.object({
      platform: z.string().min(1).max(80).describe("Platform name for the confirmation card, e.g. 'Uber Eats'."),
      summary: z.string().min(1).max(2000).describe("The full cart: dishes, quantities, prices, total, address."),
    }),
    needsConfirmation: true,
    confirmIntent: (input) => ({
      human:
        `Place this order NOW?\n\n` +
        `Piattaforma: ${input.platform}\n\n${input.summary}\n\n` +
        `(Confermi: EVE cliccherà l'ordine nel Chrome aperto.)`,
      log: "confirm_order (cart content withheld)",
    }),
    factoryAllowed: false,
    run: async (input: { platform: string; summary: string }) => {
      await ensureChrome();
      const cdp = new Cdp();
      await cdp.connect(await getWsUrl());
      try {
        // Reach the payment page if we're still on the menu.
        await placeOrder(cdp);
        // The final button. Multi-language, deliberately broad — but the
        // cart was already approved verbatim above.
        for (const label of ["effettua il pagamento", "passa al pagamento", "place order", "pay now", "payer maintenant", "conferma e paga"]) {
          if (await clickByText(cdp, label)) {
            await sleep(6000);
            const after = await cdp.eval(`document.body.innerText.slice(0, 600)`);
            audit("confirm_order", { platform: input.platform, clicked: label });
            return `Ordine confermato su ${input.platform}. Pagina dopo il click:\n${typeof after === "string" ? after : "(unreadable)"}`;
          }
        }
        const page = await cdp.eval(`document.body.innerText.slice(0, 600)`);
        return `Non trovo il bottone di pagamento — la finestra è aperta al checkout, hai già il carrello pronto. Pagina:\n${typeof page === "string" ? page : ""}`;
      } finally {
        cdp.close();
      }
    },
  },
];
