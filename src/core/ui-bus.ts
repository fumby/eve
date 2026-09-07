// UI window events: tools that produce a browsable window (the food options
// window today) announce it here, and the face server forwards it to the
// active client as `open_url`. This is how the PHONE finally gets the
// options window: the Mac-side `open` command can never reach a browser on
// another device, but the WebSocket the phone is already talking on can.
//
// Same shape as the design event bus (src/design/dispatch.ts): simple
// listener list, no persistence, no delivery guarantee — the tool's own
// return text still carries the URL as a fallback, so a dropped event costs
// nothing but a tap on the link.

export interface UiWindowEvent {
  /** The path to open, e.g. "/options". */
  path: string;
  /** What opened, for logging. */
  kind: string;
}

type Listener = (ev: UiWindowEvent) => void;

const listeners: Listener[] = [];

export function emitUiWindow(ev: UiWindowEvent): void {
  for (const l of [...listeners]) {
    try {
      l(ev);
    } catch {
      // a broken listener must not break the tool that announced
    }
  }
}

export function onUiWindow(fn: Listener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}
