// The app controller for EVE's approved face. One brain, this is its
// browser-shaped edge: WebSocket to the face server (:3939), the accepted
// Quiet/Working/Review interface, the prompt bar (typed turns + the mic),
// the approval rail, and the orb renderer from the handoff package.
//
// State mapping — real protocol → Jarvis states:
//   idle                          → Quiet (ambient presence; the orb)
//   listening/processing/speaking → Working (the live turn)
//   confirm_request, factory pending, notices → Review (needs Umberto)
// A live turn always wins over a user-picked tab; after it lands, the
// interface returns to Quiet unless something needs him.
import { MicCapture, SegmentPlayer } from "./audio.js";
import { mountOrb } from "./orb/eve-orb.js";

const $ = (sel) => document.querySelector(sel);
const els = {
  stateLabel: $("#eve-state-label"),
  connMeta: $("#eve-conn-meta"),
  kicker: $("#eve-kicker"),
  view: $("#eve-view"),
  scroll: $(".eve-stage-scroll"),
  air: $("#eve-orb-air"),
  layout: $("#eve-layout"),
  focusBtn: $("#eveFocusBtn"),
  tabReview: $("#eveTabReview"),
  tabQuiet: $('button[data-state="quiet"]'),
  tabWorking: $('button[data-state="working"]'),
  prompt: $("#eve-prompt"),
  input: $("#eve-input"),
  send: $("#eveSend"),
  mic: $("#eveMic"),
  sNeeds: $("#eveSNeeds"),
  sHandling: $("#eveSHandling"),
  sNotices: $("#eveSNotices"),
  sRem: $("#eveSRem"),
  sAgents: $("#eveSAgents"),
  cNeeds: $("#eveCNeeds"),
  cHandling: $("#eveCHandling"),
  cNotices: $("#eveCNotices"),
  cRem: $("#eveCRem"),
  usage: $("#eve-usage"),
  app: $("#eve-app"),
};

let ws = null;
let micOn = false;
let capture = null;
let serverState = "idle"; // idle | listening | processing | speaking
let paused = false;
let sandboxed = true;
let tabOverride = null; // "review": stay on Review after a turn/error
let pendingConfirm = null; // { id, intent } while the gate is asking
let factoryPending = []; // manifests awaiting approval
let notices = [];
let reminders = [];
let roster = []; // real sub-agents from the snapshot
let agentPhase = new Map(); // id → "working" | "done" | "error"
let designDispatch = new Map(); // dispatchId → { text, at }
let turnReply = ""; // the live turn's reply text

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const timeAgo = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
const fmtDue = (due) => {
  if (!due) return "";
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return due;
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `today · ${t}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} · ${t}`;
};

const quietGreeting = () => {
  const h = new Date().getHours();
  if (h < 6) return ["Up late, Umberto.", "I'm keeping watch. Nothing urgent."];
  if (h < 12) return ["Good morning, Umberto.", "Nothing urgent. I'm here when you need me."];
  if (h < 18) return ["Good afternoon, Umberto.", "Nothing urgent. I'm here when you need me."];
  return ["Good evening, Umberto.", "Nothing urgent. I'm keeping an eye on things while you work."];
};

// What she's doing, in words. The wire carries tool ids (`get_food_history`);
// the face shows Umberto a human line. Anything unmapped falls back to a
// cleaned-up version of the id — never raw snake_case on screen.
const TOOL_WORDS = {
  get_food_preferences: "checking what you like to eat",
  set_food_preferences: "saving your food preferences",
  get_food_history: "reading your food history",
  set_food_preferences_save: "saving your food preferences",
  search_conversations: "searching past conversations",
  read_conversation: "re-reading an earlier conversation",
  list_reminders: "checking your reminders",
  add_reminder: "setting a reminder",
  complete_reminder: "completing a reminder",
  list_commitments: "checking open commitments",
  update_commitment: "updating a commitment",
  list_decisions: "reviewing past decisions",
  read_note: "reading a note",
  search_notes: "searching your notes",
  add_note: "writing a note",
  list_projects: "looking at your projects",
  search_project: "searching a project folder",
  read_project_file: "reading a project file",
  set_project_dir: "linking a project folder",
  get_calendar: "checking your calendar",
  add_event: "adding an event",
  find_free_slots: "finding free time",
  get_inbox: "checking your inbox",
  check_unread: "checking unread mail",
  list_messages: "checking your messages",
  send_message: "sending a message",
  send_email: "sending an email",
  get_weather: "checking the weather",
  recall_memories: "recalling things she remembers",
  save_memory: "saving a memory",
  update_memory: "updating a memory",
  forget_memory: "forgetting a memory",
  deep_research: "researching in depth",
  research: "researching",
  research_status: "checking research progress",
  perplexity_search: "searching the web",
  delegate_to_ai: "delegating to another AI",
  delegate: "delegating to another AI",
  fetch_url: "opening a web page",
  run_command: "running a command",
  open_options_window: "preparing options for you",
  open_report_window: "preparing a report for you",
  log_expense: "logging an expense",
  ledger_write: "writing to the ledger",
  view_skill: "reading a skill",
  save_skill: "saving a skill",
  update_skill: "updating a skill",
  forget_skill: "removing a skill",
  set_model: "switching model",
  list_models: "listing models",
  set_location: "setting your location",
  set_studies_dir: "linking your studies folder",
  set_food_pr: "saving your food preferences",
  run_shortcut: "running a shortcut",
  list_shortcuts: "listing shortcuts",
  essec_browse: "browsing ESSEC",
  essec_knowledge: "reading ESSEC notes",
  list_tables: "listing ledger tables",
  board_minutes: "attending the board",
  meeting_prep: "preparing for a meeting",
  confirm_order: "placing the order",
  phone: "placing a call",
  facetime: "placing a call",
  vision: "looking at an image",
  shell: "running a command",
  web: "browsing",
};
function toolWords(name) {
  const w = TOOL_WORDS[name];
  if (w) return w;
  return String(name).replace(/_/g, " ").trim();
}

const player = new SegmentPlayer(
  () => updateHeader(),
  // Never fail silently: if playback falls back or breaks, say so where the
  // user can see it — the rail's "EVE is handling" column carries a persistent
  // line until the next snapshot clears it.
  (mode, err) => {
    if (mode === "element") {
      const r = railItem({
        tag: "audio",
        status: "fallback",
        title: `Audio fell back to element playback${err ? ` (${err})` : ""}`,
        body: "She should still be audible — tell me if she isn't.",
        key: "audio-fallback",
      });
      els.sHandling.prepend(r);
    }
    console.info(`[eve] audio path: ${mode}${err ? ` — ${err}` : ""}`);
  },
);

// ---------------------------------------------------------------- websocket
function connect() {
  // Same scheme as the page: plain http on the Mac, wss behind HTTPS on the tailnet.
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
  ws.onclose = () => {
    setTimeout(connect, 1500);
    els.stateLabel.textContent = "Connecting";
    els.stateLabel.classList.add("eve-hiccup");
  };
  ws.onopen = () => {
    els.stateLabel.classList.remove("eve-hiccup");
    sendClientInfo();
    // Position can arrive later than the socket; re-send when it does.
    requestPlace((place) => sendClientInfo(place));
  };
}

// Who we are and roughly where — once per connection. Device from the user
// agent; place only if the user granted geolocation (city level via reverse
// geocode from Apple's free service — no key, no tracking beyond that one lookup).
function sendClientInfo(place) {
  const isPhone = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const msg = { type: "client_info", device: isPhone ? "phone" : "mac" };
  if (place) msg.place = place;
  send(msg);
}

function requestPlace(cb) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${pos.coords.latitude}&lon=${pos.coords.longitude}`,
          { headers: { Accept: "application/json" } },
        );
        const j = await r.json();
        // zoom=10 → city/town level only. Never the street.
        const place = [j.address?.city || j.address?.town || j.address?.village, j.address?.country].filter(Boolean).join(", ");
        if (place) cb(place);
      } catch { /* offline or blocked: no place, EVE asks or assumes nothing */ }
    },
    () => { /* denied: no place reported */ },
    { timeout: 8000, maximumAge: 10 * 60 * 1000 },
  );
}
const send = (msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};
// Console hook: feed a server message by hand (e.g. an agent_event) to watch
// the face react without a real turn. Same contract as the previous face.
// voice(fn): replace her level source (fn() → {loud, bass, live, playing})
// to watch the veil move without playing audio; voice(null) restores it.
window.EveShell = { onMsg: (m) => onMsg(m), send, voice: (fn) => orb.ctl?.setLevelSource(fn ?? defaultLevels) };

function onMsg(msg) {
  switch (msg.type) {
    case "snapshot":
      renderSnapshot(msg.snapshot);
      break;
    case "open_url":
      // A tool opened a window for us (options/report). Same-origin path only,
      // enforced server-side; on the phone this is THE way it ever shows up.
      if (typeof msg.url === "string" && msg.url.startsWith("/")) location.href = msg.url;
      break;
    case "state":
      serverState = msg.state;
      if (serverState !== "idle") stateSwitch("working");
      else if (!tabOverride && currentState === "working") stateSwitch(needsReview() ? "review" : "quiet");
      updateHeader();
      break;
    case "heard":
      stateSwitch("working");
      turnReply = "";
      // One step for the whole utterance: interim transcripts update the
      // first step's text in place; the final transcript closes it.
      if (msg.interim) updateStepText(msg.text, "listening…", false);
      else updateStepText(msg.text, "voice turn", true);
      kicker(`heard / “${trunc(msg.text, 42)}”`);
      break;
    case "reply_delta": {
      stateSwitch("working");
      const r = ensureWorkingPanel().querySelector(".eve-work-reply");
      turnReply += msg.text;
      r.textContent = turnReply;
      r.scrollTop = r.scrollHeight;
      break;
    }
    case "tool_call": {
      stateSwitch("working");
      const words = toolWords(msg.name);
      addStep(words, "running");
      kicker(`doing / ${words}`);
      break;
    }
    case "design_event": {
      // Background design work narrates itself: one line per event, kept in
      // the rail (both columns) — the Head of Design is a real sub-agent.
      const e = msg.event;
      const d = designDispatch.get(e.dispatchId) ?? { text: "", at: Date.now() };
      if (e.kind === "info") d.text = e.text;
      else if (e.kind === "cc_tool") d.text = `Claude Code · ${e.text}`;
      else if (e.kind === "audit") d.text = `audit · ${e.text}`;
      else d.text = `${e.kind} · ${e.text}`;
      if (e.kind === "error") d.error = true;
      designDispatch.set(e.dispatchId, d);
      renderSide();
      renderReview();
      agentPhase.set("design", e.kind === "error" ? "error" : "working");
      renderAgents();
      break;
    }
    case "agent_event": {
      const known = new Map(roster.map((a) => [a.id, a]));
      if (msg.descriptor) known.set(msg.agent, { ...(known.get(msg.agent) ?? {}), ...msg.descriptor });
      if (known.has(msg.agent)) {
        roster = [...known.values()];
      }
      agentPhase.set(msg.agent, msg.phase === "dispatch" || msg.phase === "working" ? "working" : msg.phase);
      if (msg.phase === "done" || msg.phase === "error") {
        // keep the last label for the done/error row
      }
      renderAgents();
      if (msg.phase === "dispatch" || msg.phase === "working") {
        renderSide();
        kicker(`sub-agent / ${msg.agent}${msg.label ? ` · ${trunc(msg.label, 30)}` : ""}`);
      }
      break;
    }
    case "speak_segment":
      player.push(msg);
      stateSwitch("working");
      if (serverState === "speaking") kicker("replying / she is speaking");
      break;
    case "chat_queued":
      // A follow-up sent while she was mid-turn: kept, shown, and fed to her
      // the moment the live turn lands. Never lost, never interrupting.
      stateSwitch("working");
      addStep(msg.text, "queued");
      kicker(`queued / next after this turn${msg.position > 1 ? ` · #${msg.position}` : ""}`);
      break;
    case "chat_turn":
      stateSwitch("working");
      turnReply = "";
      resetWorkspace();
      addStep(msg.text, "typed");
      kicker("heard / typed turn");
      break;
    case "chat_delta": {
      stateSwitch("working");
      const r = ensureWorkingPanel().querySelector(".eve-work-reply");
      turnReply += msg.text;
      r.textContent = turnReply;
      r.scrollTop = r.scrollHeight;
      break;
    }
    case "chat_done":
      // Text of the finished turn is already in the workspace reply; this
      // just ends the input lock. Orb state returns via turn_done.
      resetChat();
      break;
    case "turn_done":
      player.markDone(msg.baseTurnId);
      doneSteps();
      tabOverride = null;
      stateSwitch(needsReview() ? "review" : "quiet");
      kicker("done / turn complete");
      send({ type: "refresh" });
      resetChat();
      break;
    case "turn_error":
      tabOverride = "review";
      stateSwitch("review"); // build the panel FIRST, then the error lands in it
      errorCard(msg.message);
      kicker("hiccup / see Review");
      send({ type: "refresh" });
      resetChat();
      break;
    case "latency":
      break; // the timing line is internal; the Jarvis face doesn't show it
    case "notice":
      // Notices land in the rail (rendered from the refreshed snapshot) and
      // as an OS banner when the tab is hidden — a transient card would fight
      // the Jarvis layout, and the rail + Review already own notices.
      osBanner(msg.notice);
      send({ type: "refresh" });
      break;
    case "confirm_request":
      pendingConfirm = { id: msg.id, intent: msg.intent };
      stateSwitch("review"); // build the panel FIRST, then the card lands in it
      confirmCard();
      kicker("decision surface / approval needed");
      break;
    case "confirm_resolved":
      document.querySelectorAll(`[data-confirm="${CSS.escape(msg.id)}"]`).forEach((el) => el.remove());
      if (pendingConfirm?.id === msg.id) pendingConfirm = null;
      renderSide();
      renderReview();
      updateHeader();
      if (currentState === "review" && !needsReview()) stateSwitch("quiet");
      break;
  }
}

// ---------------------------------------------------------------- motion
// One clock for every switch animation. ?motion=4 plays the whole choreography
// four times slower — verification only, the same idea as the old scene's
// ?nopause=1 — and prefers-reduced-motion collapses it to the instant swap.
// The CSS side (panel visibility/height delays) reads the same knob.
const MOTION = (() => {
  const v = Number(new URLSearchParams(location.search).get("motion"));
  return Number.isFinite(v) && v > 0 ? v : 1;
})();
els.app.style.setProperty("--eve-motion", String(MOTION));
const ms = (n) => n * MOTION;
const motionOk = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE_OUT = "cubic-bezier(.2,.7,.2,1)";
const EASE_IN = "cubic-bezier(.4,0,1,1)";
const cancelAnims = (el) => el.getAnimations().forEach((a) => a.cancel());

/** Set an element's text with a small rise-in when it actually changes —
 *  the header label and the kicker, which otherwise flip mid-sentence. */
function swapText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  if (!motionOk()) return;
  cancelAnims(el);
  el.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: ms(320), easing: EASE_OUT });
}

// The text of a panel enters and leaves block by block ([data-anim]),
// staggered top to bottom: out fast and slightly upward, in slower and from
// below, after the orb has already left — so what you read is her moving
// first and the words following her, never a page that popped.
const blocksOf = (panel) => [...panel.querySelectorAll("[data-anim]")];
function exitBlocks(panel) {
  blocksOf(panel).forEach((b, i) => {
    cancelAnims(b);
    // fill: forwards — the block stays gone until the CSS visibility delay
    // hides its panel (that delay outlasts this); without it a finished
    // exit would pop back for a frame or two.
    b.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px)" }], { duration: ms(170), delay: ms(i * 20), easing: EASE_IN, fill: "forwards" });
  });
}
function enterBlocks(panel, offset = 0) {
  blocksOf(panel).forEach((b, i) => {
    cancelAnims(b);
    // fill: backwards — invisible through its own delay, so the stagger
    // reads as a sequence and not as a panel that appeared and then rippled.
    b.animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: ms(460), delay: ms(offset + 180 + i * 60), easing: EASE_OUT, fill: "backwards" });
  });
}

// ---------------------------------------------------------------- the orb
// ONE orb — the Quiet one — for every state, mounted once and never
// re-created. Each state that shows her has an empty slot ([data-orb-slot])
// reserving her place; on a switch she is lifted into the air layer, flown
// to the new slot, and dropped back into the layout there. Two things this
// protects: continuity (she moves — she does not vanish here and reappear
// there) and identity (the Working orb used to be a second, smaller render,
// and the particle veil, sized in device pixels, made it a visibly different
// orb; now she is always drawn at her Quiet size and only scaled on screen).
const orb = { el: null, canvas: null, ctl: null, slot: null, shown: false, flight: 0 };
// Her veil moves with her voice — and with yours while the mic is open. The
// renderer polls this every frame; the analysers are sinks that never touch
// what is played or sent.
const defaultLevels = () => (micOn && capture ? capture.levels() : player.active ? player.levels() : null);

function createOrbEl() {
  const el = document.createElement("div");
  el.className = "eve-orb";
  el.innerHTML = `<canvas class="eve-orb-canvas" role="img" aria-label="EVE's rotating triangular globe, concentric blue bands, and continuously breathing teal particle veil"></canvas><p class="eve-orb-error" role="status" hidden></p>`;
  orb.el = el;
  orb.canvas = el.querySelector("canvas");
}

/** Her drawing size: the Quiet slot's width, whatever the window makes it. */
function orbRenderSize() {
  const q = panels.get("quiet")?.querySelector("[data-orb-slot]");
  return Math.max(1, q?.clientWidth || 500);
}

/** Rest pose: in `slot`, drawn at Quiet size, scaled to the slot. */
function settleOrb(slot) {
  const R = orbRenderSize();
  orb.el.style.width = orb.el.style.height = `${R}px`;
  orb.el.style.transform = `scale(${slot.clientWidth / R})`;
  if (orb.el.parentElement !== slot) slot.appendChild(orb.el);
  orb.slot = slot;
}

/** A viewport rect in the air layer's coordinates (it scrolls with the stage). */
function toAir(r) {
  const c = els.scroll.getBoundingClientRect();
  return { x: r.left - c.left + els.scroll.scrollLeft, y: r.top - c.top + els.scroll.scrollTop, w: r.width };
}

function cancelFlight() {
  if (orb.flight) cancelAnimationFrame(orb.flight);
  orb.flight = 0;
}

/** Fly from where she visibly is (`from`, a viewport rect — mid-flight
 *  included, so a switch back mid-way turns her around) to `slot`'s final
 *  place, which is measured now: the panels have swapped and the container
 *  is pinned at the incoming height, so the layout is already the one she
 *  will land in. */
function flyOrb(slot, from) {
  cancelFlight();
  const R = orbRenderSize();
  orb.el.style.width = orb.el.style.height = `${R}px`;
  if (orb.el.parentElement !== els.air) els.air.appendChild(orb.el);
  orb.slot = slot;
  const a = toAir(from);
  const b = toAir(slot.getBoundingClientRect());
  // A gentle arc: the control point sits above the straight line, so she
  // lifts a little before settling — travel, not a slide along a rail.
  const dx = b.x - a.x, dy = b.y - a.y;
  const lift = Math.min(90, Math.hypot(dx, dy) * 0.14);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2 - lift;
  const D = ms(720);
  const t0 = performance.now();
  const pose = (x, y, w) => { orb.el.style.transform = `translate(${x}px, ${y}px) scale(${w / R})`; };
  pose(a.x, a.y, a.w);
  const frame = (now) => {
    const p = Math.min(1, (now - t0) / D);
    const e = 1 - Math.pow(1 - p, 5); // ease-out-quint: away fast, a long settle
    const u = 1 - e;
    pose(u * u * a.x + 2 * u * e * cx + e * e * b.x, u * u * a.y + 2 * u * e * cy + e * e * b.y, a.w + (b.w - a.w) * e);
    if (p < 1) { orb.flight = requestAnimationFrame(frame); return; }
    orb.flight = 0;
    landOrb(slot);
  };
  orb.flight = requestAnimationFrame(frame);
}

/** Drop into the slot. If the slot moved while she was in the air (a step
 *  landed mid-turn and re-centred the workspace), close the gap with a short
 *  correction instead of a jump. */
function landOrb(slot) {
  const before = orb.el.getBoundingClientRect();
  settleOrb(slot);
  const after = orb.el.getBoundingClientRect();
  const dx = before.left - after.left, dy = before.top - after.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(before.width - after.width) < 1) return;
  const k = slot.clientWidth / orbRenderSize();
  const s = after.width > 0 ? before.width / after.width : 1;
  orb.el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${k * s})` }, { transform: `scale(${k})` }], { duration: ms(260), easing: EASE_OUT });
}

/** Put her where `panel` wants her — flown from `from`, faded, or simply placed. */
function placeOrb(panel, from, animate) {
  const slot = panel.querySelector("[data-orb-slot]");
  if (!slot) {
    // Review has no place for her: she fades where she stands (mid-flight
    // included) and stops drawing until a state wants her back.
    // Once she is invisible she goes back into her slot. If the fade caught
    // her mid-flight she is in #eve-orb-air, and the air layer is the one box
    // nothing clips: a 500px ghost left parked in it keeps padding the stage's
    // scroll range, and its transform is a fixed offset that no longer matches
    // anything after a resize — Review would scroll into black under a card,
    // which is the whole bug this pass is about. Her slot is inside a panel,
    // and an inactive panel clips.
    if (!orb.shown) return;
    orb.shown = false;
    cancelFlight();
    cancelAnims(orb.el);
    const park = () => { if (orb.slot) settleOrb(orb.slot); };
    if (!animate) { orb.el.style.opacity = "0"; orb.ctl?.setVisible(false); park(); return; }
    const fade = orb.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms(240), easing: EASE_IN, fill: "forwards" });
    fade.onfinish = () => { if (!orb.shown) { orb.ctl?.setVisible(false); park(); } };
    return;
  }
  const wasShown = orb.shown;
  orb.shown = true;
  cancelAnims(orb.el);
  orb.el.style.opacity = "";
  if (!orb.ctl) {
    // First time (boot, Quiet): mount once. The renderer lives on this canvas
    // for the life of the page, through every slot it is dropped into.
    settleOrb(slot);
    orb.ctl = mountOrb(orb.canvas, { intro: motionOk() });
    orb.ctl.setLevelSource(defaultLevels);
    return;
  }
  orb.ctl.setVisible(true);
  if (!animate) { cancelFlight(); settleOrb(slot); return; }
  if (!wasShown || !from) {
    // Back from Review: nothing to fly from, so she arrives in place.
    cancelFlight();
    settleOrb(slot);
    const k = slot.clientWidth / orbRenderSize();
    orb.el.animate([{ opacity: 0, transform: `scale(${k * 0.94})` }, { opacity: 1, transform: `scale(${k})` }], { duration: ms(480), delay: ms(120), easing: EASE_OUT, fill: "backwards" });
    return;
  }
  flyOrb(slot, from);
}

// Slots change size with the window (the Quiet one is min(100%, 500px), the
// Working one flips at the phone breakpoint); her rest pose follows.
const slotWatch = new ResizeObserver(() => { if (!orb.flight && orb.slot && orb.el.parentElement === orb.slot) settleOrb(orb.slot); });

// ---------------------------------------------------------------- state panel
// The three states keep separate persistent panels; switching hides/unhides.
// The orb is mounted ONCE and travels between the panels' slots — its canvas
// and animation timeline survive every switch and rail toggle (handoff rule).
const panels = new Map();
let currentState = null;

function panelFor(state) {
  let p = panels.get(state);
  if (!p) {
    p = document.createElement("div");
    p.className = "eve-state-panel";
    p.setAttribute("role", "tabpanel");
    p.setAttribute("aria-label", state);
    if (state === "quiet") p.innerHTML = quietHtml();
    else if (state === "working") p.innerHTML = workingHtml();
    else p.innerHTML = reviewHtml();
    // Every panel lives in the same grid cell; the CSS default (hidden,
    // height 0) keeps a panel built after init out of the way until its
    // first switch. Never `hidden` — display:none would kill the orb canvas
    // and any exit still playing.
    p.classList.toggle("is-active", state === currentState);
    panels.set(state, p);
    els.view.appendChild(p);
    const slot = p.querySelector("[data-orb-slot]");
    if (slot) slotWatch.observe(slot);
  }
  return p;
}

const quietHtml = () => `
  <div class="eve-orb-wrap eve-orb-slot" data-orb-slot></div>
  <div class="eve-greeting"><h1 data-anim>${esc(quietGreeting()[0])}</h1><p class="eve-sub" data-anim>${esc(quietGreeting()[1])}</p></div>
`;

const workingHtml = () => `
  <div class="eve-workspace">
    <div class="eve-working-grid">
      <div>
        <div class="eve-badge" id="eveWorkingBadge" data-anim>working</div>
        <div class="eve-title-row" data-anim><h2>On it</h2></div>
        <div class="eve-progress" id="eveProgress" data-anim></div>
        <div class="eve-sub" style="margin-bottom:14px" data-anim>She'll ask before anything leaves this Mac.</div>
        <div class="eve-work-reply" style="color:var(--eve-muted)" data-anim></div>
      </div>
      <div class="eve-mini-orb-wrap eve-orb-slot" data-orb-slot></div>
    </div>
  </div>
`;

const reviewHtml = () => `
  <div class="eve-review"><div class="eve-review-stack" id="eveReviewStack" data-anim></div></div>
`;

function ensureWorkingPanel() {
  stateSwitch("working");
  const p = panelFor("working");
  return p;
}

/** Clear the progress steps + reply for the next turn, reusing the same panel
 *  (and the same DOM node — never orphaned in #eve-view). */
function resetWorkspace() {
  const p = panels.get("working");
  if (!p) return;
  p.querySelector("#eveProgress").replaceChildren();
  const r = p.querySelector(".eve-work-reply");
  if (r) r.textContent = "";
}

function stateSwitch(state) {
  if (currentState === state) return;
  const prevPanel = currentState ? panels.get(currentState) : null;
  currentState = state;
  document.querySelectorAll(".eve-tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.state === state)));
  const labels = { quiet: "Quiet", working: "Working", review: "Needs you" };
  const kicking = { quiet: "ambient presence / nothing urgent", working: "active task / follow-through", review: "decision surface / exact action" };
  const p = panelFor(state);
  // The switch is a choreography, not a crossfade. FIRST, note where she is
  // and how tall the stage content is; then swap the panels; then fly her to
  // her new slot while the outgoing text leaves and the incoming text rises
  // in behind her. Nothing is display:none'd — the outgoing panel keeps its
  // layout for the length of the exit (CSS delays its visibility/height), so
  // the words leave from where they stood and her canvas renders throughout.
  const animate = Boolean(prevPanel) && motionOk();
  const from = animate && orb.shown ? orb.el.getBoundingClientRect() : null;
  const prevH = els.view.offsetHeight;
  panels.forEach((node, key) => { node.classList.toggle("is-active", key === state); });
  // #eve-view's height is the union of every stacked panel — a tall ghost
  // would stretch it for the length of its exit. Pin it at the incoming
  // panel's height, ease from the old one, and let go (auto) once the ghost
  // has collapsed, so a step or a streamed reply then grows it like normal
  // flow. Pinning first also makes the slot measurement below final.
  cancelAnims(els.view);
  const nextH = p.offsetHeight;
  els.view.style.height = `${nextH}px`;
  if (animate && prevH !== nextH) {
    const h = els.view.animate([{ height: `${prevH}px` }, { height: `${nextH}px` }], { duration: ms(420), easing: EASE_OUT });
    h.onfinish = () => { els.view.style.height = ""; };
  } else {
    els.view.style.height = "";
  }
  if (animate) {
    exitBlocks(prevPanel);
    enterBlocks(p);
  } else {
    for (const b of blocksOf(p)) cancelAnims(b); // a lingering exit would keep it invisible
  }
  placeOrb(p, from, animate);
  els.stateLabel.textContent = labels[state] ?? state;
  kicker(kicking[state] ?? "");
  updateHeader();
}

function addStep(label, kind) {
  const p = ensureWorkingPanel();
  const steps = p.querySelector("#eveProgress");
  // Mark the previous running step as done.
  steps.querySelectorAll(".eve-step.running").forEach((s) => s.classList.replace("running", "done"));
  const div = document.createElement("div");
  div.className = "eve-step" + (kind === "typed" || kind === "heard" ? " done" : kind === "running" ? " running" : "");
  div.innerHTML = `<strong>${esc(label)}</strong><span>${kind === "typed" ? "your turn" : kind === "heard" ? "voice turn" : kind === "queued" ? "queued · she'll take it next" : kind === "interim" ? "listening…" : "in progress"}</span>`;
  steps.appendChild(div);
}
/** Replace the FIRST step's text (the utterance) as the interim transcript grows.
 *  `final` closes the step (done) once the recognizer is sure. */
function updateStepText(text, sub, final = false) {
  const p = ensureWorkingPanel();
  let first = p.querySelector(".eve-step");
  if (!first) {
    addStep(`“${text}”`, "heard");
    return;
  }
  first.querySelector("strong").textContent = `“${text}”`;
  first.querySelector("span").textContent = sub;
  if (final) first.classList.add("done");
}
function doneSteps() {
  const p = panels.get("working");
  if (!p) return;
  p.querySelectorAll(".eve-step.running").forEach((s) => s.classList.replace("running", "done"));
  p.querySelectorAll(".eve-step").forEach((s) => s.classList.add("done"));
}

// ---------------------------------------------------------------- header/meta
function updateHeader() {
  const label = els.stateLabel;
  const busy = micOn || player.active || serverState === "processing" || serverState === "listening" || serverState === "speaking";
  if (label && currentState) {
    swapText(label, micOn ? "Listening" : player.active ? "Speaking" : serverState === "processing" ? "Working" : currentState === "review" ? "Needs you" : busy ? "Working" : currentState === "quiet" ? "Connected" : "Working");
  }
  const n = (pendingConfirm ? 1 : 0) + factoryPending.length;
  const cnt = els.tabReview.querySelector(".cnt");
  if (cnt) {
    cnt.hidden = n === 0;
    cnt.textContent = n > 0 ? ` ${n}` : "";
  }
  const parts = [];
  parts.push(paused ? "proactivity OFF" : "proactivity on");
  parts.push(sandboxed ? "" : "· live data");
  parts.push(micOn ? "· mic on" : "· mic off");
  els.connMeta.textContent = parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- snapshot
function renderSnapshot(s) {
  paused = s.paused;
  sandboxed = s.sandboxed;
  serverState = s.state;
  notices = s.notices ?? [];
  reminders = (s.reminders ?? []).filter((r) => !r.done);
  factoryPending = s.factoryPending ?? [];
  roster = s.agents ?? [];
  if (s.usage) els.usage.textContent = `usage · ${s.usage.turns} turns · ${(s.usage.inputTokens / 1000).toFixed(1)}k in / ${(s.usage.outputTokens / 1000).toFixed(1)}k out · $${s.usage.cost.toFixed(3)}`;
  // Build the Review panel BEFORE rendering into it — the first snapshot
  // arrives before any state switch, and rendering into a missing panel
  // silently drops everything (the empty-Review bug).
  //
  // The snapshot is also the reconnection moment, and the server's state
  // is the truth a reconnecting client must obey: on 2026-09-06 the "ho
  // fame" turn died server-side, the turn_error went to a half-dead
  // socket, and the phone reconnected to THIS snapshot carrying
  // state:"idle" — which the old line answered with
  // stateSwitch(currentState): the stale "working" panel stayed up,
  // "preparing options for you / in progress", for two hours. The same
  // reconciliation the live `state` message uses, applied here.
  if (serverState !== "idle") stateSwitch("working");
  else if (!tabOverride && currentState === "working") stateSwitch(needsReview() ? "review" : "quiet");
  else stateSwitch(currentState ?? "quiet");
  // A turn that ended without the client hearing it (dead socket, missed
  // turn_done) leaves its last step "running" in the working panel — the
  // same two-hour lie in miniature. Close what the server says is over.
  if (serverState === "idle") doneSteps();
  renderSide();
  renderReview();
  renderAgents();
  renderPause();
  updateHeader();
}

// ---------------------------------------------------------------- side rail
// The rail's two lists: what needs him, what she's handling.
function railItem({ tag, status, title, body, sub, dismiss, onDismiss, buttons }) {
  const el = document.createElement("article");
  el.className = "eve-item";
  const btns = (buttons ?? [])
    .map((b) => `<button class="${b.primary ? "eve-primary" : "eve-secondary"}" type="button" data-act="${b.act}">${esc(b.label)}</button>`)
    .join("");
  el.innerHTML = `
    <div class="eve-item-head"><b>${esc(tag)}</b><span>${esc(status)}</span></div>
    <p>${esc(title)}</p>
    ${body ? `<small>${esc(body)}</small>` : ""}
    ${sub ? `<small class="eve-foot">${esc(sub)}</small>` : ""}
    ${btns ? `<div class="eve-review-actions">${btns}</div>` : ""}
    ${dismiss ? `<button class="eve-x" type="button" title="Dismiss">✕</button>` : ""}
  `;
  el.querySelectorAll("[data-act]").forEach((b) => {
    const def = (buttons ?? []).find((x) => x.act === b.dataset.act);
    if (def?.onClick) b.addEventListener("click", def.onClick);
  });
  if (dismiss && onDismiss) {
    const x = el.querySelector(".eve-x");
    if (x) x.addEventListener("click", onDismiss);
  }
  return el;
}

function renderSide() {
  // Needs you: the gate's live question + factory manifests.
  const needs = [];
  if (pendingConfirm) needs.push({ key: "confirm", item: railItem({ tag: "approval", status: "live", title: `EVE wants to run: ${pendingConfirm.intent}`, body: "The 60-second gate is ticking — answer in Review.", buttons: [{ act: "a", label: "Open Review", primary: true, onClick: () => stateSwitch("review") }] }) });
  for (const f of factoryPending) {
    needs.push({ key: `f-${f.taskId}`, item: railItem({ tag: "factory", status: `round ${f.round}`, title: `Approve a new agent: ${f.name} — ${f.specialty}`, body: `slug ${f.slug} · ${f.model} · tools: ${f.tools.join(", ") || "none"}`, buttons: [{ act: "v", label: "Open Review", primary: true, onClick: () => stateSwitch("review") }] }) });
  }
  for (const n of notices.slice(0, 4)) {
    needs.push({ key: `n-${n.id}`, item: railItem({ tag: "notice", status: timeAgo(n.createdAt), title: trunc(n.text, 120), body: n.loudness === "loud" ? "loud notice" : "", dismiss: true, onDismiss: () => send({ type: "dismiss", noticeId: n.id }) }) });
  }
  fillRail(els.sNeeds, needs);
  els.cNeeds.textContent = needs.length;

  // EVE is handling: live sub-agent activity + design dispatches.
  const handling = [];
  for (const [id, ph] of agentPhase) {
    if (ph !== "working") continue;
    const a = roster.find((x) => x.id === id) ?? { name: id, specialty: "" };
    handling.push({ key: `a-${id}`, item: railItem({ tag: "sub-agent", status: "active", title: `${a.name}${a.specialty ? ` · ${a.specialty}` : ""}`, body: "" }) });
  }
  for (const [did, d] of designDispatch) {
    handling.push({ key: `d-${did}`, item: railItem({ tag: "design", status: d.error ? "error" : "working", title: d.text || `dispatch ${did}`, sub: `Head of Design · ${timeAgo(new Date(d.at).toISOString())}` }) });
  }
  fillRail(els.sHandling, handling);
  els.cHandling.textContent = handling.length;

  // Notices column: same list, no dismiss buttons (Review owns acting).
  fillRail(els.sNotices, notices.slice(0, 4).map((n) => ({ key: `n-${n.id}`, item: railItem({ tag: "notice", status: timeAgo(n.createdAt), title: trunc(n.text, 120) }) })));
  els.cNotices.textContent = notices.length;

  // Reminders: due items, the same content the old panel showed.
  fillRail(els.sRem, reminders.slice(0, 5).map((r) => ({ key: `r-${r.id}`, item: railItem({ tag: "reminder", status: r.due ? fmtDue(r.due) : "no time", title: r.text }) })));
  els.cRem.textContent = reminders.length;
}

function fillRail(target, list) {
  target.replaceChildren(...list.map((x) => x.item));
  if (list.length === 0) {
    const d = document.createElement("div");
    d.className = "eve-empty";
    d.textContent = "nothing pending";
    target.appendChild(d);
  }
}

function renderAgents() {
  const rows = roster.map((a) => {
    const ph = agentPhase.get(a.id) ?? "idle";
    return `<article class="eve-item"><div class="eve-item-head"><b>${esc(a.name)}</b><span>${esc(ph)}</span></div><p>${esc(a.specialty ?? "")}</p></article>`;
  });
  els.sAgents.innerHTML = rows.join("") || `<div class="eve-empty">no sub-agents</div>`;
}
// ---------------------------------------------------------------- review tab
function renderReview() {
  const stack = document.querySelector("#eveReviewStack");
  if (!stack) return;
  // Never rebuild under a user who is typing feedback — the rebuild would
  // erase the textarea. A re-render keeps nodes whose id is still live.
  const focus = document.activeElement;
  const typing =
    focus && (focus.tagName === "TEXTAREA" || focus.tagName === "INPUT") && stack.contains(focus);
  if (typing) return;
  const cards = [];
  if (pendingConfirm) {
    const c = confirmCardEl(pendingConfirm);
    cards.push(c);
  }
  for (const f of factoryPending) {
    cards.push(factoryCardEl(f));
  }
  const small = matchMedia("(max-width: 720px)").matches;
  for (const n of notices.slice(0, small ? 3 : 5)) {
    cards.push(railItem({ tag: "notice", status: timeAgo(n.createdAt), title: trunc(n.text, 180), dismiss: true, onDismiss: () => send({ type: "dismiss", noticeId: n.id }) }));
  }
  if (cards.length === 0) {
    const d = document.createElement("div");
    d.className = "eve-review-shell";
    d.innerHTML = `<div class="eve-title-row"><h2>Nothing needs you</h2></div><p class="eve-sub">EVE is cruising. Approvals, decisions and notices land here.</p>`;
    cards.push(d);
  }
  stack.replaceChildren(...cards);
}

function confirmCardEl(pc) {
  const root = railItem({
    tag: "approval",
    status: "live gate · 60s",
    title: "Approve this once?",
    body: `EVE wants to run: ${pc.intent}`,
    buttons: [
      { act: "allow", label: "Allow once", primary: true, onClick: () => { send({ type: "confirm_response", id: pc.id, ok: true }); pendingConfirm = null; renderSide(); renderReview(); updateHeader(); if (!needsReview()) stateSwitch("quiet"); } },
      { act: "deny", label: "Refuse", onClick: () => { send({ type: "confirm_response", id: pc.id, ok: false }); pendingConfirm = null; renderSide(); renderReview(); updateHeader(); if (!needsReview()) stateSwitch("quiet"); } },
    ],
  });
  root.querySelector("div.eve-review-actions").classList.add("confirm-actions");
  root.dataset.confirm = pc.id;
  return root;
}

function factoryCardEl(f) {
  const root = document.createElement("article");
  root.className = "eve-item";
  root.dataset.factory = f.taskId;
  root.innerHTML = `
    <div class="eve-item-head"><b>factory · round ${f.round}</b><span>${esc(f.model)}</span></div>
    <p>Approve a new agent: <strong>${esc(f.name)}</strong> — ${esc(f.specialty)}</p>
    <p class="eve-item-meta">slug ${esc(f.slug)} · tools: ${esc(f.tools.join(", ") || "none")} · spec: ${esc(f.specPath)}</p>
    <details><summary>system prompt</summary><pre>${esc(f.systemPrompt)}</pre></details>
    <textarea class="eve-draft ffeedback" rows="2" placeholder="feedback for a revision (leave empty to reject outright)"></textarea>
    <div class="eve-review-actions">
      <button class="eve-primary" type="button" data-act="allow">Approve — go live</button>
      <button class="eve-secondary" type="button" data-act="deny">Reject</button>
    </div>
    <div class="eve-receipt" role="status"></div>
  `;
  const receipt = root.querySelector(".eve-receipt");
  const allow = root.querySelector('[data-act="allow"]');
  const deny = root.querySelector('[data-act="deny"]');
  allow.addEventListener("click", () => {
    root.querySelectorAll("button").forEach((b) => (b.disabled = true));
    receipt.textContent = "Approving — the agent goes live and joins the roster…";
    send({ type: "factory_approve", taskId: f.taskId });
  });
  deny.addEventListener("click", () => {
    const feedback = root.querySelector(".ffeedback").value.trim() || null;
    root.querySelectorAll("button").forEach((b) => (b.disabled = true));
    receipt.textContent = feedback ? "Sending your feedback — a revision is coming…" : "Rejected. The manifest stays on file.";
    send({ type: "factory_reject", taskId: f.taskId, feedback });
  });
  return root;
}

function confirmCard() {
  // The gate asks: make the Review tab the obvious place to answer.
  renderReview();
}


function errorCard(message) {
  const stack = document.querySelector("#eveReviewStack");
  if (!stack) return;
  const el = document.createElement("article");
  el.className = "eve-item";
  el.innerHTML = `<div class="eve-item-head"><b class="eve-kind-error">hiccup</b><span>turn error</span></div><p>${esc(message)}</p>`;
  stack.prepend(el);
}

// ---------------------------------------------------------------- needsReview
function needsReview() {
  return Boolean(pendingConfirm) || factoryPending.length > 0;
}

// ---------------------------------------------------------------- OS banner
function osBanner(n) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return; // the rail already shows it
    new Notification("EVE noticed", { body: n.text, tag: `eve-notice-${n.id}` });
  } catch {
    /* best effort */
  }
}
function askBannerPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------- mic
async function micToggle() {
  if (micOn) {
    micOn = false;
    els.mic.classList.remove("listening");
    await capture?.stop();
    capture = null;
    send({ type: "mic", on: false });
    updateHeader();
    return;
  }
  if (player.active) {
    // barge-in: silence her, then immediately listen
    player.stop();
    send({ type: "interrupt" });
  }
  send({ type: "mic", on: true });
  askBannerPermission();
  try {
    // Wake the playback graph on this click — the one moment a browser
    // reliably lets an AudioContext start.
    await player.prime();
    capture = new MicCapture(ws);
    await capture.start();
    micOn = true;
    els.mic.classList.add("listening");
  } catch {
    send({ type: "mic", on: false });
    errorCard("I couldn't open your microphone — your browser may be waiting for permission (check the address bar).");
  }
  updateHeader();
}
els.mic.addEventListener("click", () => void micToggle());
els.mic.dispatchEvent(new CustomEvent("eve:ready")); // parity with the old face's custom-event pattern

// ---------------------------------------------------------------- text chat
els.prompt.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  // The input never locks: a second message while she is working is a
  // FOLLOW-UP — the server queues it and runs it the moment the live turn
  // lands. (It used to disable and even interrupt her; both gone.)
  els.input.value = "";
  // This submit IS the user gesture a browser needs to start audio — without
  // priming here, a text turn's spoken reply hits a suspended AudioContext.
  void player.prime();
  send({ type: "chat", text });
});
const resetChat = () => {
  els.input.focus();
};

// ---------------------------------------------------------------- tabs + rail
document.querySelectorAll(".eve-tab").forEach((t) => t.addEventListener("click", () => {
  tabOverride = t.dataset.state === "review" ? "review" : null;
  stateSwitch(t.dataset.state);
}));
els.focusBtn.addEventListener("click", () => {
  const focused = els.layout.classList.toggle("orb-only");
  els.focusBtn.setAttribute("aria-pressed", String(focused));
  els.focusBtn.textContent = focused ? "Show rail" : "Focus";
});

// Pause proactivity — the kill switch from the old face, same wire.
const pauseBtn = $("#evePauseBtn");
pauseBtn.addEventListener("click", () => send({ type: "set_paused", paused: !paused }));
function renderPause() {
  pauseBtn.setAttribute("aria-pressed", String(paused));
  pauseBtn.textContent = paused ? "Paused" : "Pause";
  pauseBtn.title = paused ? "Proactivity PAUSED — click to resume" : "Pause all proactive behavior";
}

function kicker(text) {
  swapText(els.kicker, text);
}
const trunc = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : s);

// ---------------------------------------------------------------- go
createOrbEl();
stateSwitch("quiet");
// First open: she builds up (the renderer's intro) and the greeting follows
// her — it rises in as the veil forms, not before she exists.
if (motionOk()) enterBlocks(panels.get("quiet"), 1500);
// All three panels exist from the start — a snapshot arriving before any
// interaction must find Review ready to render into (the empty-Review bug).
panelFor("review");
panelFor("working");
connect();
updateHeader();
