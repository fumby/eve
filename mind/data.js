// Data access: the skeleton fetch, lazy node detail, and the read-only
// observer socket. Nothing here knows about three.js.

export async function fetchSkeleton() {
  const res = await fetch("/api/mind-map", { cache: "no-store" });
  if (!res.ok) throw new Error(`mind-map ${res.status}`);
  return res.json();
}

export async function fetchNode(id) {
  const res = await fetch(`/api/mind-map/node/${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`node ${res.status}`);
  return res.json();
}

// Spectator stream. Reconnects with backoff, and closes entirely while the tab
// is hidden — the render loop is paused anyway, and a live socket would just
// queue a stale burst to replay on return.
export function observe(onEvent) {
  let ws = null;
  let delay = 1000;
  let closedByUs = false;

  function open() {
    if (document.hidden || ws) return;
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/observe`);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      delay = 1000;
    };
    ws.onmessage = (ev) => {
      try {
        onEvent(JSON.parse(ev.data));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      ws = null;
      if (!closedByUs) schedule();
    };
    ws.onerror = () => {
      try {
        ws?.close();
      } catch {
        /* already closing */
      }
    };
  }

  function schedule() {
    setTimeout(open, delay);
    delay = Math.min(delay * 2, 15000);
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      closedByUs = true;
      try {
        ws?.close();
      } catch {
        /* fine */
      }
      ws = null;
    } else {
      closedByUs = false;
      delay = 1000;
      open();
    }
  });

  open();
  return () => {
    closedByUs = true;
    ws?.close();
  };
}
