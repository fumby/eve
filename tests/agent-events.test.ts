// The sub-agent event bus and the face roster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { onAgentEvent, emitAgentEvent, type AgentEvent } from "../src/core/agent-events.js";
import { buildRoster, colorFor } from "../src/face/roster.js";
import type { Seat } from "../src/board/dossier.js";

test("agent events: emit → listeners, unsubscribe works, a throwing listener does not stop others", () => {
  const got: AgentEvent[] = [];
  const off1 = onAgentEvent(() => {
    throw new Error("spectator bug");
  });
  const off2 = onAgentEvent((e) => got.push(e));
  emitAgentEvent({ agent: "munger", phase: "dispatch", label: "q" });
  emitAgentEvent({ agent: "munger", phase: "working" });
  assert.equal(got.length, 2);
  assert.equal(got[0].agent, "munger");
  assert.equal(got[0].phase, "dispatch");
  assert.match(got[0].at, /^\d{4}-\d{2}-\d{2}T/);
  off1();
  off2();
  emitAgentEvent({ agent: "munger", phase: "done" });
  assert.equal(got.length, 2);
});

test("roster: seats first with their colours, then design and research; unknown seat gets a cool colour", () => {
  const seats = [
    { id: "drucker", name: "Peter Drucker", seat: "Management & Innovation" },
    { id: "zed", name: "Someone New", seat: "Novelty" },
  ] as unknown as Seat[];
  const r = buildRoster(seats);
  assert.deepEqual(
    r.map((a) => a.id),
    ["drucker", "zed", "design", "research"],
  );
  assert.equal(r[0].color, "#67E8F9");
  assert.equal(r[0].specialty, "Management & Innovation");
  assert.match(r[1].color!, /^#[0-9a-f]{6}$/i);
  assert.equal(r[2].initial, "HD");
  assert.equal(colorFor("zed"), colorFor("zed"));
  assert.equal(buildRoster([]).length, 2);
});
