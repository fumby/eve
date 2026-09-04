// Recall over the memory store: semantic when the Voyage key is present,
// honest lexical fallback when it isn't (or when the API hiccups) — recall
// degrades, it never breaks. The vector index in data/memory-vectors.json is
// DERIVED: delete it any time and it rebuilds from the files on next use.
import { loadConfig } from "../core/config.js";
import { readJson, writeJson } from "../core/store.js";
import { listMemories, type StoredMemory } from "./store.js";
import { bagOfWords, lexicalCosine } from "../mind/embed.js";

const VEC_FILE = "memory-vectors.json";
const MAX_HITS = 4;

interface VecEntry {
  hash: string;
  vector: number[];
}

function memText(m: StoredMemory): string {
  return `${m.hook}\n${m.body}`.slice(0, 2000);
}

function hash16(t: string): string {
  // FNV-1a, hex — cheap content fingerprint for cache invalidation.
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function fetchVoyage(
  texts: string[],
  inputType: "document" | "query",
  key: string,
): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      input: texts,
      model: loadConfig().embeddings.model,
      input_type: inputType,
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const j = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  return j.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

// Document vectors for every stored memory, cached by content hash — only new
// or edited memories cost an API call; deleted ones are pruned from the cache.
async function documentVectors(
  memories: StoredMemory[],
  key: string,
): Promise<Map<string, number[]>> {
  const cache = readJson<Record<string, VecEntry>>(VEC_FILE, {});
  const vectors = new Map<string, number[]>();
  const missing: { name: string; text: string; hash: string }[] = [];

  for (const m of memories) {
    const h = hash16(memText(m));
    const hit = cache[m.name];
    if (hit && hit.hash === h) vectors.set(m.name, hit.vector);
    else missing.push({ name: m.name, text: memText(m), hash: h });
  }
  const live = new Set(memories.map((m) => m.name));
  let dirty = false;
  for (const name of Object.keys(cache)) {
    if (!live.has(name)) {
      delete cache[name];
      dirty = true;
    }
  }
  if (missing.length > 0) {
    const fresh = await fetchVoyage(missing.map((m) => m.text), "document", key);
    missing.forEach((m, i) => {
      vectors.set(m.name, fresh[i]!);
      cache[m.name] = { hash: m.hash, vector: fresh[i]! };
    });
    dirty = true;
  }
  if (dirty) writeJson(VEC_FILE, cache);
  return vectors;
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

export interface RecallHit {
  memory: StoredMemory;
  score: number;
}

export interface RecallResult {
  hits: RecallHit[];
  how: "semantic" | "lexical";
}

export async function recallMemories(query: string, limit = MAX_HITS): Promise<RecallResult> {
  const memories = listMemories();
  if (memories.length === 0) return { hits: [], how: "lexical" };

  const key = process.env.VOYAGE_API_KEY;
  if (key) {
    try {
      const vectors = await documentVectors(memories, key);
      const [qv] = await fetchVoyage([query], "query", key);
      const hits = memories
        .map((m) => ({ memory: m, score: cosine(qv!, vectors.get(m.name)!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .filter((h) => h.score > 0.2);
      return { hits, how: "semantic" };
    } catch {
      // fall through to lexical — a vector hiccup must never blind her
    }
  }

  const qBag = bagOfWords(query);
  const hits = memories
    .map((m) => ({ memory: m, score: lexicalCosine(qBag, bagOfWords(memText(m))) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .filter((h) => h.score > 0);
  return { hits, how: "lexical" };
}
