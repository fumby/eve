// Similarity for the memory web.
//
// Real embeddings need a provider key (Anthropic has no embedding endpoint).
// This seam takes whichever of VOYAGE_API_KEY / OPENAI_API_KEY exists in .env.
// With neither, it falls back to local lexical similarity — which is honestly
// labelled as "lexical" all the way to the UI, never passed off as semantic.
import crypto from "node:crypto";
import { readJson, writeJson } from "../core/store.js";
import { loadConfig } from "../core/config.js";

// Both constants are surfaced in the API stats so they can be tuned knowingly.
export const TOP_K = 3; // neighbours per memory — more than this is a hairball
export const SIM_THRESHOLD = 0.35; // roughly where "actually about the same thing" starts

export type SimilarityKind = "semantic" | "lexical";

interface CacheEntry {
  hash: string;
  vector: number[];
}

const CACHE_FILE = "embeddings.json";

const hashText = (t: string) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);

function provider(): { name: string; key: string } | null {
  if (process.env.VOYAGE_API_KEY) return { name: "voyage", key: process.env.VOYAGE_API_KEY };
  if (process.env.OPENAI_API_KEY) return { name: "openai", key: process.env.OPENAI_API_KEY };
  return null;
}

async function fetchVectors(texts: string[], p: { name: string; key: string }): Promise<number[][]> {
  if (p.name === "voyage") {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: texts,
        model: loadConfig().embeddings.model,
        input_type: "document",
      }),
    });
    if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const j = (await res.json()) as { data: { embedding: number[] }[] };
    return j.data.map((d) => d.embedding);
  }
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts, model: "text-embedding-3-small" }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Cached by content hash, so only genuinely new or edited memories cost a call.
export async function embed(
  items: { id: string; text: string }[],
): Promise<{ vectors: Map<string, number[]>; kind: SimilarityKind }> {
  const p = provider();
  if (!p || items.length === 0) return { vectors: new Map(), kind: "lexical" };

  const cache = readJson<Record<string, CacheEntry>>(CACHE_FILE, {});
  const vectors = new Map<string, number[]>();
  const missing: { id: string; text: string; hash: string }[] = [];

  for (const it of items) {
    const h = hashText(it.text);
    const hit = cache[it.id];
    if (hit && hit.hash === h) vectors.set(it.id, hit.vector);
    else missing.push({ ...it, hash: h });
  }

  if (missing.length > 0) {
    const fresh = await fetchVectors(
      missing.map((m) => m.text),
      p,
    );
    missing.forEach((m, i) => {
      const v = fresh[i]!;
      vectors.set(m.id, v);
      cache[m.id] = { hash: m.hash, vector: v };
    });
    writeJson(CACHE_FILE, cache);
  }
  return { vectors, kind: "semantic" };
}

// ---------------------------------------------------------------- lexical
// Exported: memory recall uses the same honest fallback.
const STOP = new Set(
  ("the a an and or of to in on for with is are was were be been it this that " +
    "il lo la le gli di del della che per con non sono una uno da come quando " +
    "umberto eve his her he she").split(" "),
);

export function bagOfWords(text: string): Map<string, number> {
  const bag = new Map<string, number>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.trim();
    if (w.length < 3 || STOP.has(w)) continue;
    bag.set(w, (bag.get(w) ?? 0) + 1);
  }
  return bag;
}

export function lexicalCosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [w, n] of a) dot += n * (b.get(w) ?? 0);
  if (dot === 0) return 0;
  const mag = (m: Map<string, number>) =>
    Math.sqrt([...m.values()].reduce((s, n) => s + n * n, 0));
  const d = mag(a) * mag(b);
  return d === 0 ? 0 : dot / d;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export interface SimEdge {
  source: string;
  target: string;
  weight: number;
}

// Full pairwise similarity, top-K above threshold, pairs canonicalised and
// deduped. O(n²) is trivial at this scale — no approximate index needed.
export function similarityEdges(
  items: { id: string; text: string }[],
  vectors: Map<string, number[]>,
): SimEdge[] {
  const useSemantic = vectors.size === items.length && items.length > 0;
  const bags = useSemantic ? null : new Map(items.map((i) => [i.id, bagOfWords(i.text)]));

  const seen = new Map<string, SimEdge>();
  for (const a of items) {
    const scored: { id: string; sim: number }[] = [];
    for (const b of items) {
      if (a.id === b.id) continue; // self-match is -1 by construction
      const sim = useSemantic
        ? cosine(vectors.get(a.id)!, vectors.get(b.id)!)
        : lexicalCosine(bags!.get(a.id)!, bags!.get(b.id)!);
      if (sim >= SIM_THRESHOLD) scored.push({ id: b.id, sim });
    }
    scored.sort((x, y) => y.sim - x.sim);
    for (const s of scored.slice(0, TOP_K)) {
      const [source, target] = [a.id, s.id].sort() as [string, string];
      const key = `${source}|${target}`;
      const prev = seen.get(key);
      if (!prev || s.sim > prev.weight) seen.set(key, { source, target, weight: s.sim });
    }
  }
  return [...seen.values()];
}

// Live nearest-neighbour query for the inspector panel.
export function nearestNeighbors(
  targetId: string,
  items: { id: string; text: string }[],
  vectors: Map<string, number[]>,
  limit = 5,
): { id: string; sim: number }[] {
  const useSemantic = vectors.size === items.length && items.length > 0;
  const me = items.find((i) => i.id === targetId);
  if (!me) return [];
  const myBag = useSemantic ? null : bagOfWords(me.text);
  return items
    .filter((i) => i.id !== targetId)
    .map((i) => ({
      id: i.id,
      sim: useSemantic
        ? cosine(vectors.get(targetId)!, vectors.get(i.id)!)
        : lexicalCosine(myBag!, bagOfWords(i.text)),
    }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, limit);
}
