// The single animation loop. Everything in the face — background, orb,
// agents, labels — ticks from here, in order, once per frame. It pauses when
// the tab is hidden and resumes without a time jump (dt is clamped and t is
// accumulated, never read from the wall clock), so a state change that
// happened while you were away eases in when you come back instead of
// snapping. Frame counter lets the background render every other frame.

const MAX_DT = 0.05; // s — anything longer is a hiccup, not motion

export function createLoop({ ignoreHidden = false } = {}) {
  const subs = [];
  let raf = 0;
  let running = false;
  let paused = false;
  let lastNow = 0;
  let t = 0;
  let frame = 0;
  let fps = 60;

  // rAF is frozen in hidden tabs; with ignoreHidden we fall back to a timer so
  // automated verification (which drives a hidden pane) still sees motion.
  function schedule() {
    // hidden panes neither fire visibilitychange reliably nor run rAF; a plain
    // timer is the only clock that keeps going there
    if (ignoreHidden) raf = setTimeout(() => tick(performance.now()), 16);
    else raf = requestAnimationFrame(tick);
  }
  function unschedule() {
    cancelAnimationFrame(raf);
    clearTimeout(raf);
  }
  function tick(now) {
    if (!running || paused) return;
    schedule();
    const dtRaw = lastNow ? (now - lastNow) / 1000 : 1 / 60;
    lastNow = now;
    const dt = Math.min(MAX_DT, Math.max(0, dtRaw));
    t += dt;
    frame++;
    if (dtRaw > 0) fps += ((1 / Math.max(dtRaw, 1e-3)) - fps) * 0.05;
    for (const fn of subs) fn(dt, t, frame);
  }

  const loop = {
    subscribe(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    start() {
      if (running) return;
      running = true;
      lastNow = 0;
      schedule();
    },
    stop() {
      running = false;
      unschedule();
    },
    pause() {
      if (paused) return;
      paused = true;
      unschedule();
    },
    resume() {
      if (!paused) return;
      paused = false;
      lastNow = 0; // forget the gap
      if (running) schedule();
    },
    /** Advance the simulation by fixed steps without waiting on the wall clock (verification hook). */
    step(dt = 1 / 60, count = 1) {
      for (let i = 0; i < count; i++) {
        t += dt;
        frame++;
        for (const fn of subs) fn(dt, t, frame);
      }
    },
    get paused() {
      return paused;
    },
    get t() {
      return t;
    },
    get frame() {
      return frame;
    },
    get fps() {
      return fps;
    },
  };

  // ?nopause=1 keeps animating while hidden — for automated verification only.
  document.addEventListener("visibilitychange", () => {
    if (ignoreHidden) return;
    if (document.hidden) loop.pause();
    else loop.resume();
  });

  return loop;
}
