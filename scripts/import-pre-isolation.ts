// One-time import: the 41 pre-isolation conversations from
// memory/archive/conversations.pre-isolation.json into the transcripts
// archive (memory/transcripts/), where search_conversations can reach them.
//
// Before this, that file was the ONLY copy of the Cergy-move discussion, the
// professor-Bianchi mention, the July budget question and the 16-August
// travel planning — invisible to EVE's search because nothing read the
// archive directory (the README says so itself). This script changes no
// content: each conversation is rendered exactly as archiveConversation
// renders a live eviction, verbatim turns, original ids, original timestamps.
// It is idempotent — an id already archived is skipped, never clobbered.
//
// Run once: npx tsx scripts/import-pre-isolation.ts
import fs from "node:fs";
import path from "node:path";

const { ROOT, STATE_ROOT } = await import("../src/core/config.js");
const { archiveConversation, loadConversations, transcriptsDir } = await import(
  "../src/core/conversations.js"
);

// Guard: this must only run against the REAL state (EVE_STATE_DIR unset).
// Under a sandbox, it would copy nothing (the archive path resolves into the
// sandbox) and quietly report success — the exact failure mode the
// state-isolation test exists to prevent.
if (STATE_ROOT !== ROOT) {
  console.error("Refusing: EVE_STATE_DIR is set — this import is for the real memory tree only.");
  process.exit(1);
}

const SOURCE = path.join(ROOT, "memory", "archive", "conversations.pre-isolation.json");
const raw = JSON.parse(fs.readFileSync(SOURCE, "utf8")) as {
  id: string;
  source: string;
  startedAt: string;
  updatedAt: string;
  turns: { role: "user" | "assistant"; text: string; at: string }[];
  distilledAt?: string;
}[];

// Reuse the same loader the live store uses: write into data/conversations.json
// (in memory — never saved), then archive each through the normal path. This
// guarantees byte-identical rendering with future evictions.
const { writeJson } = await import("../src/core/store.js");

// Temporarily hold the real live store, splice in the imported set, archive,
// restore. Never write the spliced store: writeJson is only called by
// archiveConversation itself, and it filters OUT the archived id — so after
// every archive call the file on disk returns to its pre-splice state plus
// nothing. Simplest correct route: append the imports to the LIVE store
// (they will sort oldest and be harmless), archive them, then restore the
// original bytes.
const LIVE = path.join(STATE_ROOT, "data", "conversations.json");
const originalBytes = fs.existsSync(LIVE) ? fs.readFileSync(LIVE) : null;
const liveNow = loadConversations();
const imported = raw.filter((c) => c && typeof c.id === "string" && Array.isArray(c.turns) && c.turns.length > 0);
const known = new Set(liveNow.map((c) => c.id));

// Merge: imported conversations that are not already live.
const merged = [...liveNow, ...imported.filter((c) => !known.has(c.id))];
writeJson("conversations.json", merged);

// Count archived files, tolerating the directory not existing yet (the very
// first archive creates it).
function listArchiveCount(): number {
  try {
    return fs.readdirSync(transcriptsDir()).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

let archived = 0;
let skipped = 0;
try {
  for (const c of imported) {
    const before = listArchiveCount();
    archiveConversation(c.id);
    const after = listArchiveCount();
    if (after > before) archived++;
    else skipped++;
  }
} finally {
  // Restore the live store to exactly what it was (or remove it if it never
  // existed) — the import lives in memory/transcripts/, not in the live file.
  if (originalBytes === null) fs.rmSync(LIVE, { force: true });
  else fs.writeFileSync(LIVE, originalBytes);
}

console.log(
  `Imported ${archived} conversation(s) to memory/transcripts/` +
    `${skipped > 0 ? `, skipped ${skipped} (already archived or empty)` : ""}.`,
);
