// The distant web behind the orb: ~100 small nodes gathered into ~8 coloured
// clusters, thin lines between nodes that sit close together, and a few
// hundred motes of dust. Layout only — typed arrays and colours; the
// renderer turns them into points and lines. Deterministic. Pure module.

import { mulberry32 } from "../rng.js";
import { hexToRgb } from "../ease.js";

export const CLUSTER_COLORS = Object.freeze([
  "#2DD4A8", "#67E8F9", "#A78BFA", "#5B8BF0", "#E88FB3", "#7DD3FC", "#3EE8BC", "#7C6BF0",
]);

/**
 * @param {object} o
 * @param {number} [o.nodes=100]  node count (halve on mobile)
 * @param {number} [o.dust=300]   dust count (halve on mobile)
 * @param {number} [o.clusters=8]
 * @param {number} [o.spread=50]  half-extent of the field in world units
 * @param {number} [o.clusterRadius=9]
 * @param {number} [o.linkDist=7] connect nodes closer than this
 * @param {number} [o.seed=1337]
 */
export function layoutNetwork(o = {}) {
  const nodes = o.nodes ?? 100;
  const dust = o.dust ?? 300;
  const clusters = o.clusters ?? 8;
  const spread = o.spread ?? 50;
  const cr = o.clusterRadius ?? 9;
  const linkDist = o.linkDist ?? 7;
  const rnd = mulberry32(o.seed ?? 1337);

  // Cluster centres: spread on a flattened shell so they read as depth, not a plane.
  const centres = [];
  for (let c = 0; c < clusters; c++) {
    const a = (c / clusters) * Math.PI * 2 + rnd() * 0.5;
    const rr = spread * (0.45 + 0.5 * rnd());
    centres.push([
      Math.cos(a) * rr,
      (rnd() - 0.5) * spread * 0.9,
      Math.sin(a) * rr * 0.6 - spread * 0.2 * rnd(),
    ]);
  }

  const pos = new Float32Array(nodes * 3);
  const col = new Float32Array(nodes * 3);
  const size = new Float32Array(nodes);
  const cluster = new Uint8Array(nodes);
  for (let i = 0; i < nodes; i++) {
    const c = i % clusters;
    const [cx, cy, cz] = centres[c];
    // gaussian-ish scatter around the centre
    const g = () => (rnd() + rnd() + rnd() - 1.5) * cr;
    pos[i * 3] = cx + g();
    pos[i * 3 + 1] = cy + g() * 0.8;
    pos[i * 3 + 2] = cz + g() * 0.9;
    const [r, gg, b] = hexToRgb(CLUSTER_COLORS[c % CLUSTER_COLORS.length]);
    col[i * 3] = r; col[i * 3 + 1] = gg; col[i * 3 + 2] = b;
    size[i] = 0.7 + rnd() * 1.1;
    cluster[i] = c;
  }

  // Edges: any two nodes closer than linkDist (O(n²) on 100 nodes is nothing).
  const edges = [];
  for (let i = 0; i < nodes; i++) {
    for (let j = i + 1; j < nodes; j++) {
      const dx = pos[i * 3] - pos[j * 3];
      const dy = pos[i * 3 + 1] - pos[j * 3 + 1];
      const dz = pos[i * 3 + 2] - pos[j * 3 + 2];
      if (dx * dx + dy * dy + dz * dz < linkDist * linkDist) edges.push(i, j);
    }
  }
  const edgePos = new Float32Array(edges.length * 3);
  const edgeCol = new Float32Array(edges.length * 3);
  for (let k = 0; k < edges.length; k++) {
    const n = edges[k];
    edgePos[k * 3] = pos[n * 3];
    edgePos[k * 3 + 1] = pos[n * 3 + 1];
    edgePos[k * 3 + 2] = pos[n * 3 + 2];
    edgeCol[k * 3] = col[n * 3];
    edgeCol[k * 3 + 1] = col[n * 3 + 1];
    edgeCol[k * 3 + 2] = col[n * 3 + 2];
  }

  const dustPos = new Float32Array(dust * 3);
  const dustSize = new Float32Array(dust);
  for (let i = 0; i < dust; i++) {
    dustPos[i * 3] = (rnd() - 0.5) * spread * 2.4;
    dustPos[i * 3 + 1] = (rnd() - 0.5) * spread * 1.6;
    dustPos[i * 3 + 2] = (rnd() - 0.5) * spread * 1.6;
    dustSize[i] = 0.25 + rnd() * 0.5;
  }

  return {
    nodes: { count: nodes, pos, col, size, cluster },
    edges: { count: edges.length / 2, pos: edgePos, col: edgeCol },
    dust: { count: dust, pos: dustPos, size: dustSize },
    centres,
    linkDist,
  };
}
