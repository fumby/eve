// Pure layout math. Deliberately imports nothing from three.js so the
// positions can be reasoned about — and tested — on their own.

export const ANCHORS = {
  core: [0, 0, 0],
  memory: [-11, 1.5, -2],
  working: [6, 5.5, 4],
  agents: [9, -1, -6], // reserved: EVE has no sub-agents yet
  knowledge: [1, -7.5, 5],
  rim: [10, 2, -7],
};

// FNV-1a over the id. Deterministic, so a reload never reshuffles the scene —
// Math.random() here would make everything shimmer differently every visit.
export function hash01(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// --------------------------------------------------------------- memory web
// Force-directed, run once at load and baked. A live sim would cost the frame
// budget every frame and look no better.
export function layoutMemory(nodes, edges, anchor = ANCHORS.memory, iterations = 150) {
  const n = nodes.length;
  if (n === 0) return new Map();
  const idx = new Map(nodes.map((node, i) => [node.id, i]));
  const pos = nodes.map((node) => {
    const h = hash01(node.id);
    const g = hash01(node.id + "y");
    const k = hash01(node.id + "z");
    return [(h - 0.5) * 7, (g - 0.5) * 7, (k - 0.5) * 7];
  });
  const vel = nodes.map(() => [0, 0, 0]);

  const springs = [];
  for (const e of edges) {
    const a = idx.get(e.source);
    const b = idx.get(e.target);
    if (a !== undefined && b !== undefined) springs.push([a, b, e.weight ?? 0.5]);
  }

  for (let step = 0; step < iterations; step++) {
    // repulsion — inverse square with a floor so coincident nodes don't explode
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i][0] - pos[j][0];
        let dy = pos[i][1] - pos[j][1];
        let dz = pos[i][2] - pos[j][2];
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.06) {
          dx = (hash01(`${i}-${j}x`) - 0.5) * 0.1;
          dy = (hash01(`${i}-${j}y`) - 0.5) * 0.1;
          dz = (hash01(`${i}-${j}z`) - 0.5) * 0.1;
          d2 = 0.06;
        }
        const f = 1.4 / d2;
        const d = Math.sqrt(d2);
        const ux = (dx / d) * f;
        const uy = (dy / d) * f;
        const uz = (dz / d) * f;
        vel[i][0] += ux; vel[i][1] += uy; vel[i][2] += uz;
        vel[j][0] -= ux; vel[j][1] -= uy; vel[j][2] -= uz;
      }
    }
    // springs along real similarity edges
    for (const [a, b, w] of springs) {
      const dx = pos[b][0] - pos[a][0];
      const dy = pos[b][1] - pos[a][1];
      const dz = pos[b][2] - pos[a][2];
      const d = Math.hypot(dx, dy, dz) || 0.0001;
      const target = 2.4;
      const f = (d - target) * 0.08 * (0.5 + w);
      const ux = (dx / d) * f;
      const uy = (dy / d) * f;
      const uz = (dz / d) * f;
      vel[a][0] += ux; vel[a][1] += uy; vel[a][2] += uz;
      vel[b][0] -= ux; vel[b][1] -= uy; vel[b][2] -= uz;
    }
    // gravity toward the region anchor, then damping
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) {
        vel[i][k] += -pos[i][k] * 0.012;
        vel[i][k] *= 0.82;
        pos[i][k] += vel[i][k];
      }
    }
  }

  const out = new Map();
  nodes.forEach((node, i) => out.set(node.id, add(anchor, pos[i])));
  return out;
}

// --------------------------------------------------------------- working
export function layoutRing(nodes, anchor = ANCHORS.working, radius = 2.6) {
  const out = new Map();
  nodes.forEach((node, i) => {
    const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    const wobble = (hash01(node.id) - 0.5) * 1.2;
    out.set(node.id, add(anchor, [Math.cos(a) * radius, wobble, Math.sin(a) * radius]));
  });
  return out;
}

// --------------------------------------------------------------- knowledge
export function layoutGrid(nodes, anchor = ANCHORS.knowledge, spacing = 1.9) {
  const out = new Map();
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  nodes.forEach((node, i) => {
    const cx = (i % cols) - (cols - 1) / 2;
    const cy = Math.floor(i / cols) - (Math.ceil(nodes.length / cols) - 1) / 2;
    out.set(node.id, add(anchor, [cx * spacing, cy * spacing * 0.7, 0]));
  });
  return out;
}

// --------------------------------------------------------------- rim
// A compact capability ball, not a scene-encircling ring: categories spread by
// golden angle on an inner sphere, their tools bunched around them like
// grapes, integrations on a slightly larger shell phase-offset by π so the two
// interleave instead of shadowing each other.
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function goldenPoint(i, count, radius, phaseOffset = 0) {
  const y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = GOLDEN * i + phaseOffset;
  return [Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius];
}

export function layoutRim(categories, toolsByCategory, integrations, anchor = ANCHORS.rim) {
  const out = new Map();
  categories.forEach((cat, i) => {
    const c = goldenPoint(i, categories.length, 2.5);
    out.set(cat.id, add(anchor, c));
    const tools = toolsByCategory.get(cat.extra?.name ?? cat.label) ?? [];
    tools.forEach((t, j) => {
      const g = goldenPoint(j, Math.max(1, tools.length), 0.95, i * 1.7);
      out.set(t.id, add(anchor, [c[0] + g[0], c[1] + g[1], c[2] + g[2]]));
    });
  });
  integrations.forEach((n, i) => {
    out.set(n.id, add(anchor, goldenPoint(i, integrations.length, 3.9, Math.PI)));
  });
  return out;
}

// One call: node id → [x,y,z] for every node in the skeleton.
export function layoutAll(skeleton) {
  const byRegion = (r) => skeleton.nodes.filter((n) => n.region === r);
  const positions = new Map();

  positions.set("core:eve", ANCHORS.core);

  const mem = byRegion("memory");
  const simEdges = skeleton.edges.filter((e) => e.kind === "similarity");
  for (const [id, p] of layoutMemory(mem, simEdges)) positions.set(id, p);

  for (const [id, p] of layoutRing(byRegion("working"))) positions.set(id, p);
  for (const [id, p] of layoutGrid(byRegion("knowledge"))) positions.set(id, p);

  const rim = byRegion("rim");
  const categories = rim.filter((n) => n.type === "category");
  const integrations = rim.filter((n) => n.type === "integration");
  const toolsByCategory = new Map();
  for (const t of rim.filter((n) => n.type === "tool")) {
    const cat = t.extra?.category ?? "other";
    if (!toolsByCategory.has(cat)) toolsByCategory.set(cat, []);
    toolsByCategory.get(cat).push(t);
  }
  for (const [id, p] of layoutRim(categories, toolsByCategory, integrations)) positions.set(id, p);

  // Anything unplaced (a region we don't lay out yet) gets its anchor rather
  // than silently landing at the origin on top of the core.
  for (const n of skeleton.nodes) {
    if (!positions.has(n.id)) positions.set(n.id, ANCHORS[n.region] ?? [0, 0, 0]);
  }
  return positions;
}
