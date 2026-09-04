// The app controller: WebSocket to the face server, glass-shell rendering,
// turn cards, confirmations, and the mic button. One brain, this is just its
// browser-shaped edge.
import { MicCapture, SegmentPlayer } from "./audio.js";
import { normalizeAgentEvent, designEventToPhase } from "./scene/agent-map.js";

const $ = (id) => document.getElementById(id);
const els = {
  dot: $("statusDot"),
  badge: $("alertBadge"),
  alerts: $("alertsBtn"),
  pause: $("pauseBtn"),
  panel: $("panel"),
  collapse: $("collapseBtn"),
  cards: $("cards"),
  mic: $("micBtn"),
  micIcon: $("micIcon"),
  stopIcon: $("stopIcon"),
  sNotices: $("sNotices"),
  sReminders: $("sReminders"),
  sFacts: $("sFacts"),
  sUsage: $("sUsage"),
  cNotices: $("cNotices"),
  cReminders: $("cReminders"),
  cFacts: $("cFacts"),
};

let ws = null;
let micOn = false;
let capture = null;
let serverState = "idle";
let paused = false;
let turnCard = null; // { root, heard, body, lat, reply }
const designDocked = new Set(); // dispatchIds whose card the design agent already sits beside
const dockSlots = new WeakMap(); // turn card → how many agents are stacked beside it

const player = new SegmentPlayer(
  () => updateDot(),
  // Never fail silently: if playback falls back or breaks, say so on screen.
  (mode, err) => {
    if (mode === "element") {
      errorCard(
        `Audio switched to fallback playback${err ? ` (${err})` : ""} — she should be audible, ` +
          `but tell me if you still hear nothing.`,
      );
    }
    console.info(`[eve] audio path: ${mode}${err ? ` — ${err}` : ""}`);
  },
);

// The orb reads her voice and yours straight from the analysers; when neither
// is flowing it falls back to a synthetic motion on its own.
window.EveOrb?.setLevelSources({
  playback: () => player.levels(),
  mic: () => (capture ? capture.levels() : null),
});

// ---------------------------------------------------------------- websocket
function connect() {
  // Same scheme as the page: plain http on the Mac, wss behind HTTPS on the tailnet.
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
  ws.onclose = () => {
    setTimeout(connect, 1500);
    setDot("idle");
  };
}
const send = (msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};
// Console hook: feed a server message by hand (e.g. an agent_event) to watch
// the face react without a real turn.
window.EveShell = { onMsg: (m) => onMsg(m), send };

function onMsg(msg) {
  switch (msg.type) {
    case "snapshot":
      renderSnapshot(msg.snapshot);
      break;
    case "state":
      serverState = msg.state;
      updateDot();
      break;
    case "heard":
      ensureTurnCard().heard.textContent = `“${msg.text}”`;
      break;
    case "reply_delta": {
      const c = ensureTurnCard();
      c.reply += msg.text;
      c.body.textContent = c.reply;
      c.body.scrollTop = c.body.scrollHeight;
      break;
    }
    case "tool_call": {
      const c = ensureTurnCard();
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = ` [${msg.name}…] `;
      c.body.appendChild(chip);
      window.EveOrb?.fx?.arc(msg.name); // a flick of energy from the orb toward the tool
      break;
    }
    case "design_event": {
      // Background design work narrates itself here: one line per event on
      // a dedicated card (not the turn card — dispatches outlive turns).
      const e = msg.event;
      let card = document.querySelector(`.card[data-design="${e.dispatchId}"]`);
      if (!card) {
        card = document.createElement("div");
        card.className = "card";
        card.dataset.design = e.dispatchId;
        card.innerHTML = `<div class="label">design · ${e.dispatchId}</div><div class="body design-log"></div>`;
        addCard(card);
      }
      const log = card.querySelector(".design-log");
      const line = document.createElement("div");
      line.className = `design-line ${e.kind}`;
      line.textContent = `${e.kind === "cc_tool" ? "▸ " : e.kind === "audit" ? "" : e.kind === "error" ? "✗ " : e.kind === "warn" ? "! " : "· "}${e.text}`;
      log.appendChild(line);
      while (log.children.length > 12) log.firstChild.remove();
      log.scrollTop = log.scrollHeight;
      // The Head of Design settles beside its own card while it works; the
      // server's agent_event (dispatch/done/error) starts and ends the visit.
      const phase = designEventToPhase(e.kind);
      const A = window.EveOrb?.agents;
      if (A && phase === "working") {
        A.working("design", { label: e.text });
        if (!designDocked.has(e.dispatchId)) {
          designDocked.add(e.dispatchId);
          A.dock("design", card, { side: "right", gap: 28, tether: true });
        }
      }
      break;
    }
    case "agent_event": {
      const A = window.EveOrb?.agents;
      if (!A) break;
      const known = new Set(A.list().map((a) => a.id));
      const ev = normalizeAgentEvent(msg, known);
      if (!ev) break;
      if (ev.descriptor && !known.has(ev.agent)) A.add(ev.descriptor);
      const isDesign = ev.agent === "design";
      switch (ev.phase) {
        case "dispatch": {
          A.dispatch(ev.agent, { label: ev.label });
          // Board seats and the researcher gather beside the turn that called them.
          if (!isDesign && turnCard?.root?.isConnected) {
            const slot = dockSlots.get(turnCard.root) ?? 0;
            dockSlots.set(turnCard.root, slot + 1);
            A.dock(ev.agent, turnCard.root, { side: "right", gap: 28, slot, tether: false });
          }
          break;
        }
        case "working":
          A.working(ev.agent, { label: ev.label });
          break;
        case "done":
          A.done(ev.agent);
          if (isDesign) designDocked.clear();
          break;
        case "error":
          A.error(ev.agent, { label: ev.label });
          if (isDesign) designDocked.clear();
          break;
      }
      break;
    }
    case "speak_segment":
      player.push(msg);
      updateDot();
      break;
    case "turn_done":
      player.markDone(msg.baseTurnId);
      // Whoever was gathered beside this turn drifts back to orbit.
      for (const a of window.EveOrb?.agents?.list?.() ?? []) if (a.id !== "design") window.EveOrb.agents.undock(a.id);
      turnCard = null; // next turn gets a fresh card
      send({ type: "refresh" }); // reminders/memory may have changed
      break;
    case "turn_error":
      errorCard(msg.message);
      turnCard = null;
      window.EveOrb?.flash("error", 2500);
      break;
    case "latency": {
      const f = (v) => (v === null ? "—" : `${(v / 1000).toFixed(2)}s`);
      const last = els.cards.querySelector(".card:last-child .lat");
      if (last)
        last.textContent = `⏱ transcript ${f(msg.transcriptMs)} · first token ${f(msg.firstTokenMs)} · first audio ${f(msg.firstSegmentMs)}`;
      break;
    }
    case "notice":
      noticeCard(msg.notice);
      osBanner(msg.notice);
      send({ type: "refresh" });
      break;
    case "confirm_request":
      confirmCard(msg.id, msg.intent);
      break;
    case "confirm_resolved":
      document.querySelector(`[data-confirm="${msg.id}"]`)?.remove();
      break;
  }
}

// ---------------------------------------------------------------- status dot
function setDot(cls) {
  els.dot.className = `status-dot ${cls}`;
  els.dot.title = cls;
  // The orb is the real status indicator; the dot is its footnote.
  window.EveOrb?.setState(cls);
}
function updateDot() {
  if (micOn) setDot("listening");
  else if (player.active) setDot("speaking");
  else if (serverState === "processing") setDot("processing");
  else setDot("idle");
}

// ---------------------------------------------------------------- panel
function entry(html, sub) {
  const div = document.createElement("div");
  div.className = "entry";
  const txt = document.createElement("span");
  txt.className = "txt";
  txt.textContent = html;
  if (sub) {
    const s = document.createElement("span");
    s.className = "sub";
    s.textContent = sub;
    txt.appendChild(s);
  }
  div.appendChild(txt);
  return div;
}

// ---------------------------------------------------------------- factory cards
// One card per manifest awaiting approval, keyed by task id and driven from
// the snapshot — so a reloaded page shows exactly what's still pending, and a
// card resolved from another tab (or the terminal) disappears here too.
function renderFactoryCards(pending) {
  const live = new Set(pending.map((p) => p.taskId));
  for (const el of document.querySelectorAll("[data-factory]")) {
    if (!live.has(el.dataset.factory)) el.remove();
  }
  for (const p of pending) {
    if (document.querySelector(`[data-factory="${p.taskId}"]`)) continue;
    const root = document.createElement("div");
    root.className = "card factory";
    root.dataset.factory = p.taskId;
    root.innerHTML =
      `<div class="label">⚙ factory — approve a new agent (round ${p.round})</div>` +
      `<div class="fname"></div><div class="chip fmeta"></div>` +
      `<details><summary class="chip">system prompt</summary><div class="body fprompt"></div></details>` +
      `<textarea class="ffeedback" rows="2" placeholder="feedback for a revision (leave empty to reject outright)"></textarea>` +
      `<div class="btns"><button class="btn allow">Approve — go live</button><button class="btn deny">Reject</button></div>`;
    root.querySelector(".fname").textContent = `${p.name} — ${p.specialty}`;
    root.querySelector(".fmeta").textContent = `slug ${p.slug} · ${p.model} · tools: ${p.tools.join(", ") || "none"} · spec: ${p.specPath}`;
    root.querySelector(".fprompt").textContent = p.systemPrompt;
    root.querySelector(".allow").onclick = () => {
      root.querySelectorAll("button").forEach((b) => (b.disabled = true));
      send({ type: "factory_approve", taskId: p.taskId });
    };
    root.querySelector(".deny").onclick = () => {
      const feedback = root.querySelector(".ffeedback").value.trim() || null;
      root.querySelectorAll("button").forEach((b) => (b.disabled = true));
      root.querySelector(".label").textContent = feedback ? "⚙ factory — revising with your feedback…" : "⚙ factory — rejected";
      send({ type: "factory_reject", taskId: p.taskId, feedback });
    };
    els.cards.appendChild(root); // not addCard: approval cards must never be evicted by chatter
  }
}

function renderSnapshot(s) {
  paused = s.paused;
  window.EveOrb?.agents?.setRoster(s.agents ?? []);
  renderFactoryCards(s.factoryPending ?? []);
  els.pause.classList.toggle("active", paused);
  els.pause.title = paused ? "Proactivity PAUSED — click to resume" : "Pause all proactive behavior";

  els.cNotices.textContent = s.notices.length;
  els.badge.hidden = s.notices.length === 0;
  els.badge.textContent = s.notices.length;
  els.sNotices.replaceChildren();
  if (s.notices.length === 0) els.sNotices.innerHTML = `<div class="empty">nothing pending</div>`;
  for (const n of s.notices) {
    const e = entry(n.text, new Date(n.createdAt).toLocaleString());
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "✕";
    x.title = "Dismiss";
    x.onclick = () => send({ type: "dismiss", noticeId: n.id });
    e.appendChild(x);
    els.sNotices.appendChild(e);
  }

  els.cReminders.textContent = s.reminders.length;
  els.sReminders.replaceChildren();
  if (s.reminders.length === 0) els.sReminders.innerHTML = `<div class="empty">all clear</div>`;
  for (const r of s.reminders) els.sReminders.appendChild(entry(r.text, r.due ? `due ${r.due}` : ""));

  els.cFacts.textContent = s.facts.length;
  els.sFacts.replaceChildren();
  if (s.facts.length === 0) els.sFacts.innerHTML = `<div class="empty">she's still getting to know you</div>`;
  for (const f of s.facts) els.sFacts.appendChild(entry(f.text));

  els.sUsage.textContent = `${s.usage.turns} turns · ${(s.usage.inputTokens / 1000).toFixed(1)}k in / ${(s.usage.outputTokens / 1000).toFixed(1)}k out · $${s.usage.cost.toFixed(3)}`;
}

// ---------------------------------------------------------------- cards
function addCard(root) {
  els.cards.appendChild(root);
  while (els.cards.children.length > 3) els.cards.firstChild.remove();
}

function ensureTurnCard() {
  if (turnCard) return turnCard;
  const root = document.createElement("div");
  root.className = "card";
  root.innerHTML = `<div class="label">EVE</div><div class="heard"></div><div class="body"></div><div class="lat"></div>`;
  addCard(root);
  turnCard = {
    root,
    heard: root.querySelector(".heard"),
    body: root.querySelector(".body"),
    lat: root.querySelector(".lat"),
    reply: "",
  };
  return turnCard;
}

function errorCard(message) {
  const root = document.createElement("div");
  root.className = "card error";
  root.innerHTML = `<div class="label">hiccup</div><div class="body"></div>`;
  root.querySelector(".body").textContent = message;
  addCard(root);
}

// A system banner for loud notices when this tab is in the background — the
// browser's Notification API stands in for the macOS banner the server used
// to post itself, so a phone or a second Mac on the tailnet still gets
// interrupted. Permission is requested once, on the first mic click (a user
// gesture, which browsers require). Nothing here can throw into the socket.
function osBanner(n) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return; // the card is already on screen
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

function noticeCard(n) {
  const root = document.createElement("div");
  root.className = "card";
  root.innerHTML = `<div class="label">🔔 EVE noticed</div><div class="body"></div><div class="btns"><button class="btn deny">Dismiss</button></div>`;
  root.querySelector(".body").textContent = n.text;
  root.querySelector(".deny").onclick = () => {
    send({ type: "dismiss", noticeId: n.id });
    root.remove();
  };
  addCard(root);
}

function confirmCard(id, intent) {
  const root = document.createElement("div");
  root.className = "card";
  root.dataset.confirm = id;
  root.innerHTML = `<div class="label">⚠ needs your ok</div><div class="body"></div><div class="btns"><button class="btn allow">Allow once</button><button class="btn deny">Refuse</button></div>`;
  root.querySelector(".body").textContent = `EVE wants to run: ${intent}`;
  const done = (ok) => {
    send({ type: "confirm_response", id, ok });
    root.remove();
  };
  root.querySelector(".allow").onclick = () => done(true);
  root.querySelector(".deny").onclick = () => done(false);
  addCard(root);
}

// ---------------------------------------------------------------- mic
async function micToggle() {
  if (micOn) {
    micOn = false;
    els.mic.classList.remove("listening");
    els.micIcon.hidden = false;
    els.stopIcon.hidden = true;
    await capture?.stop();
    capture = null;
    send({ type: "mic", on: false });
    updateDot();
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
    // Wake the playback graph on this click. A user gesture is the only
    // moment a browser reliably lets an AudioContext start, so doing it here
    // means it's already running when her first sentence lands — rather than
    // waking up mid-word, which is heard as a break at the start of speech.
    await player.prime();
    capture = new MicCapture(ws);
    await capture.start();
    micOn = true;
    els.mic.classList.add("listening");
    els.micIcon.hidden = true;
    els.stopIcon.hidden = false;
  } catch (err) {
    send({ type: "mic", on: false });
    errorCard(
      "I couldn't open your microphone — your browser may be waiting for permission (check the address bar).",
    );
  }
  updateDot();
}
els.mic.addEventListener("click", () => void micToggle());
els.mic.dispatchEvent(new CustomEvent("eve:ready")); // parity with spec's custom-event pattern

// ---------------------------------------------------------------- header
// Desktop: the rail collapses to a sliver. Small screens (≤640px): it starts
// as a sliver and the same button opens it as a drawer.
const smallScreen = () => matchMedia("(max-width: 640px)").matches;
els.collapse.onclick = () => (smallScreen() ? els.panel.classList.toggle("open") : els.panel.classList.toggle("collapsed"));
els.alerts.onclick = () => (smallScreen() ? els.panel.classList.add("open") : els.panel.classList.remove("collapsed"));
els.pause.onclick = () => send({ type: "set_paused", paused: !paused });

connect();
updateDot();
