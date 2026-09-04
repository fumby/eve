// ?demo=1 — the scene alive without a backend. Cycles the moods, feeds
// synthetic levels where the real analyser would, and (from tier 5 on)
// dispatches agents and docks the design agent to a fake card so every
// reaction can be seen without waiting for a real turn. Stop with
// EveOrb.demo.stop().

const SCRIPT = [
  ["idle", 3000],
  ["listening", 3200],
  ["processing", 6500],
  ["speaking", 5000],
  ["error-flash", 0],
  ["idle", 2500],
];

export function startDemo(api) {
  let stopped = false;
  let timer = 0;
  let i = 0;
  const cards = document.getElementById("cards");
  let fakeCard = null;

  function ensureCard() {
    if (fakeCard && fakeCard.isConnected) return fakeCard;
    fakeCard = document.createElement("div");
    fakeCard.className = "card";
    fakeCard.dataset.design = "demo";
    fakeCard.innerHTML =
      '<div class="label">Head of Design · demo</div><div class="design-log"><div class="design-line cc_tool">▸ composing mockup…</div></div>';
    cards?.appendChild(fakeCard);
    return fakeCard;
  }

  function step() {
    if (stopped) return;
    const [mood, ms] = SCRIPT[i % SCRIPT.length];
    i++;
    if (mood === "error-flash") {
      api.flash("error", 2200);
      timer = setTimeout(step, 2400);
      return;
    }
    api.setState(mood);
    // agent reactions land here once the constellation exists (tier 5/6)
    if (mood === "processing" && api.agents?.dispatch) {
      const ids = (api.agents.list?.() || []).map((a) => a.id);
      const seats = ids.filter((id) => !["design", "research"].includes(id));
      const pick = seats.sort(() => Math.random() - 0.5).slice(0, 2);
      pick.forEach((id, k) => setTimeout(() => !stopped && api.agents.dispatch(id, { label: "demo question" }), 300 + k * 900));
      setTimeout(() => {
        if (stopped) return;
        api.agents.working?.("design", { label: "composing" });
        api.agents.dock?.("design", ensureCard(), { side: "right", gap: 28, tether: true });
      }, 2200);
      setTimeout(() => !stopped && pick.forEach((id) => api.agents.done?.(id)), 5800);
    }
    if (mood === "idle" && api.agents?.undock) {
      api.agents.done?.("design");
      fakeCard?.remove();
      fakeCard = null;
    }
    timer = setTimeout(step, ms);
  }
  step();

  api.demo = {
    stop() {
      stopped = true;
      clearTimeout(timer);
      fakeCard?.remove();
      api.setState("idle");
    },
  };
  console.info("[eve] demo running — EveOrb.demo.stop() to end it");
  return api.demo;
}
