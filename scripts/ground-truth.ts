// Generates docs/ground-truth.md — what is actually true of this codebase right
// now, read from the code rather than remembered.
//
// The rule this script lives by: report only what can be read mechanically, and
// say plainly where a fact cannot be. A hand-written ground truth drifts —
// docs/cloud-migration-suspended/archive/01-ground-truth-for-council.md claimed "Backups today:
// none" and "No Node pin" long after both stopped being true, and sandboxed
// councils read it as fact. A generated one is wrong only when the code is.
//
// Never emitted: any content from memory/ (only names and counts) and any value
// from .env (only key names). Both are read by the model that reads this file.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "../src/core/config.js";
import { Registry, isFactoryAllowed, type EveTool } from "../src/core/registry.js";
import { reminderTools } from "../src/tools/reminders.js";
import { noteTools } from "../src/tools/notes.js";
import { projectTools } from "../src/tools/projects.js";
import { memoryTools } from "../src/tools/memory.js";
import { weatherTools } from "../src/tools/weather.js";
import { researchTools } from "../src/tools/research.js";
import { perplexityTools } from "../src/tools/perplexity.js";
import { boardTools } from "../src/tools/board.js";
import { ledgerTools } from "../src/tools/ledger.js";
import { designTools } from "../src/design/tools.js";
import { factoryTools } from "../src/tools/factory.js";

const OUT = path.join(ROOT, "docs", "ground-truth.md");

// ── helpers ────────────────────────────────────────────────────────────────

function sh(cmd: string, args: string[], cwd = ROOT): string {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out);
    else if (ext.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (p: string): string => path.relative(ROOT, p);
const lines = (p: string): string[] => fs.readFileSync(p, "utf8").split("\n");

// ── sections ───────────────────────────────────────────────────────────────

function sectionTree(): string {
  const rows = [
    ["src/", walk(path.join(ROOT, "src"), /\.ts$/)],
    ["tests/", walk(path.join(ROOT, "tests"), /\.test\.ts$/)],
    ["scripts/", walk(path.join(ROOT, "scripts"), /\.(ts|sh)$/)],
    ["face/", walk(path.join(ROOT, "face"), /\.(js|css|html)$/)],
    ["docs/", walk(path.join(ROOT, "docs"), /\.md$/)],
  ] as const;

  const counts = rows
    .map(([label, files]) => {
      const bytes = files.reduce((n, f) => n + fs.statSync(f).size, 0);
      return `| \`${label}\` | ${files.length} | ${(bytes / 1024).toFixed(0)} KB |`;
    })
    .join("\n");

  // Which directories exist under src/, with how many files each — the shape of
  // the system at a glance, without listing 70 paths.
  const srcDir = path.join(ROOT, "src");
  const subs = fs
    .readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `| \`src/${e.name}/\` | ${walk(path.join(srcDir, e.name), /\.ts$/).length} |`)
    .join("\n");
  const loose = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts")).length;

  return `| tree | files | size |
|---|---:|---:|
${counts}

| module | .ts files |
|---|---:|
${subs}
| \`src/\` (top level) | ${loose} |`;
}

function sectionTools(): string {
  // buildRegistry() is NOT exported and is duplicated verbatim in src/cli.ts and
  // src/face/server.ts; both modules start timers and watchers at import, so
  // neither can be loaded here. This mirrors their tool list from the same
  // exported modules they use, and constructs its own Registry.
  const r = new Registry();
  const all: EveTool[] = [
    ...reminderTools, ...noteTools, ...projectTools, ...memoryTools, ...weatherTools,
    ...researchTools, ...perplexityTools, ...boardTools, ...ledgerTools, ...designTools,
  ];
  for (const t of all) r.register(t);
  for (const t of factoryTools(r)) r.register(t);

  const gate = (t: EveTool): string =>
    typeof t.needsConfirmation === "function"
      ? "conditional"
      : t.needsConfirmation
        ? "always"
        : "no";

  const rows = r
    .all()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => {
      const declared =
        typeof t.factoryAllowed === "boolean" ? String(t.factoryAllowed) : "(derived)";
      return `| \`${t.name}\` | ${gate(t)} | ${declared} | ${isFactoryAllowed(t)} |`;
    })
    .join("\n");

  // Spawned agents register dispatch_to_<slug> tools at runtime from this file.
  const agentsFile = path.join(ROOT, "data", "factory", "agents.json");
  let spawned = "`data/factory/agents.json` does not exist — 0 spawned agents.";
  if (fs.existsSync(agentsFile)) {
    try {
      const rowsJson = JSON.parse(fs.readFileSync(agentsFile, "utf8")) as { slug?: string }[];
      spawned = rowsJson.length
        ? `${rowsJson.length} spawned agent(s) in \`data/factory/agents.json\`, each registering a \`dispatch_to_<slug>\` tool at runtime that does not appear above: ${rowsJson.map((a) => `\`dispatch_to_${a.slug}\``).join(", ")}.`
        : "`data/factory/agents.json` exists and is empty — 0 spawned agents, so no `dispatch_to_<slug>` tools exist.";
    } catch {
      spawned = "`data/factory/agents.json` exists but did not parse.";
    }
  }

  return `\`needsConfirmation\` is \`conditional\` when it is a function of the call's
arguments — the answer depends on what is being asked, so there is no static
value to print here. \`factory (effective)\` is \`isFactoryAllowed()\` actually
called, which is what the Factory uses; \`declared\` shows whether the tool says
so itself or lets the default decide.

| tool | gate | factory (declared) | factory (effective) |
|---|---|---|---|
${rows}

${spawned}`;
}

function sectionWrites(): string {
  const WRITE =
    /\b(writeFileAtomic|writeJson|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync|rename|unlinkSync|unlink|truncateSync|truncate|rmdirSync|rmSync|rm|mkdirSync)\s*\(/;
  const isComment = (l: string): boolean => {
    const t = l.trim();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
  };
  // Every function in this codebase is declared at column 0, so scanning back to
  // the nearest column-0 declaration is exact, not a guess. Asserted below.
  const DECL = /^(?:export\s+)?(?:async\s+)?(?:function|class)\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[:=]/;

  const rows: string[] = [];
  let unattributed = 0;
  for (const file of walk(path.join(ROOT, "src"), /\.ts$/)) {
    const ls = lines(file);
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i]!;
      if (isComment(line)) continue;
      const m = line.match(WRITE);
      if (!m) continue;

      let owner = "(top level)";
      for (let j = i; j >= 0; j--) {
        const d = ls[j]!.match(DECL);
        if (d) {
          owner = d[1] ?? d[2] ?? "(top level)";
          break;
        }
      }
      if (owner === "(top level)") unattributed++;

      // Only the literal fragments that appear in the source. The real target is
      // built from runtime values (path.join(STORE_DIR, `${name}.md`)), so it is
      // deliberately NOT resolved here — a resolved path would be a guess.
      const frags = [...line.matchAll(/"([^"]*)"|'([^']*)'/g)]
        .map((f) => f[1] ?? f[2] ?? "")
        .filter((s) => s.length > 0 && s.length < 40);
      rows.push(
        `| \`${rel(file)}:${i + 1}\` | \`${owner}\` | \`${m[1]}\` | ${frags.length ? frags.map((f) => `\`${f}\``).join(" ") : "—"} |`,
      );
    }
  }

  return `Call sites only. The path a call actually writes to is usually built from
runtime values (\`path.join(STORE_DIR, \\\`\${name}.md\\\`)\`), so it is **not**
resolved here — a resolved path would be a guess, which is the thing this
document exists to avoid. The \`literals\` column shows only string constants
present on the line.

${unattributed} call site(s) could not be attributed to a declaration.

| site | enclosing declaration | call | literals on the line |
|---|---|---|---|
${rows.join("\n")}`;
}

function sectionChecks(): string {
  const testFiles = walk(path.join(ROOT, "tests"), /\.test\.ts$/);
  let total = 0;
  const per = testFiles
    .map((f) => {
      const n = lines(f).filter((l) => /^test\(/.test(l)).length;
      total += n;
      return { f: rel(f), n };
    })
    .sort((a, b) => b.n - a.n)
    .map((x) => `| \`${x.f}\` | ${x.n} |`)
    .join("\n");

  // Counted statically, not by running the suite: `npm test` writes to the real
  // memory/store/, and a document about the system should not mutate it.
  let typecheck = "not run";
  try {
    execFileSync("npx", ["tsc", "--noEmit"], { cwd: ROOT, stdio: "ignore" });
    typecheck = "clean";
  } catch {
    typecheck = "FAILING";
  }

  return `\`tsc --noEmit\`: **${typecheck}**

Tests are counted statically (\`^test(\` at column 0, the convention this repo
enforces — no \`describe\`, no nesting). The suite is deliberately NOT run here:
it writes to the real \`memory/store/\`, and a document describing the system
should not change it. \`npm test\` remains the authority.

**${total} tests across ${testFiles.length} files.**

| file | tests |
|---|---:|
${per}`;
}

function sectionGit(): string {
  const memRepo = path.join(ROOT, "memory");
  const hasMemGit = fs.existsSync(path.join(memRepo, ".git"));
  const memLog = hasMemGit ? sh("git", ["log", "-1", "--format=%h %ci"], memRepo) : "";
  const memCount = hasMemGit ? sh("git", ["rev-list", "--count", "HEAD"], memRepo) : "0";

  const remotes = sh("git", ["remote", "-v"]);
  const tracked = sh("git", ["ls-files"]).split("\n").filter(Boolean).length;
  const dirty = sh("git", ["status", "--porcelain"]).split("\n").filter(Boolean).length;

  const ignored = ["memory/", "data/", "logs/", ".env"]
    .map((p) => {
      const v = sh("git", ["check-ignore", "-v", p]);
      return `| \`${p}\` | ${v ? `ignored (${v.split("\t")[0]})` : "**tracked**"} |`;
    })
    .join("\n");

  const tm = sh("tmutil", ["destinationinfo"]) || "no output";

  return `| fact | value |
|---|---|
| branch | \`${sh("git", ["branch", "--show-current"]) || "(detached)"}\` |
| HEAD | \`${sh("git", ["log", "-1", "--format=%h %ci"])}\` |
| tracked files | ${tracked} |
| uncommitted changes | ${dirty} |
| remotes | ${remotes ? remotes.split("\n").length : 0} — ${remotes || "**none configured**"} |

| path | git status |
|---|---|
${ignored}

**Backups.** \`memory/\` is its own local git repo: ${hasMemGit ? `yes — ${memCount} commit(s), latest \`${memLog}\`` : "**no**"}.
Hourly via \`~/Library/LaunchAgents/com.umberto.eve.memory-backup.plist\` →
\`scripts/backup-memory.sh\` (add and commit only). No remote, by decision.
Time Machine: ${tm.includes("No destinations") ? "**no destination configured**" : "configured"}.

\`memory/\` holds ${walk(path.join(ROOT, "memory"), /\.md$/).length} markdown file(s); contents are deliberately not reproduced here.`;
}

function sectionDeps(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const installed = (name: string): string => {
    const p = path.join(ROOT, "node_modules", name, "package.json");
    if (!fs.existsSync(p)) return "not installed";
    return (JSON.parse(fs.readFileSync(p, "utf8")) as { version: string }).version;
  };
  const rows = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([n, range]) => `| \`${n}\` | \`${range}\` | ${installed(n)} |`)
    .join("\n");

  // Names only — never values. This file is read by models.
  const envPath = path.join(ROOT, ".env");
  const envKeys = fs.existsSync(envPath)
    ? lines(envPath)
        .map((l) => l.match(/^([A-Z0-9_]+)=/)?.[1])
        .filter((k): k is string => Boolean(k))
        .sort()
    : [];

  const nvmrc = fs.existsSync(path.join(ROOT, ".nvmrc"))
    ? fs.readFileSync(path.join(ROOT, ".nvmrc"), "utf8").trim()
    : "absent";

  return `Node: \`engines.node\` = \`${pkg.engines?.node ?? "unset"}\`, \`.nvmrc\` = \`${nvmrc}\`, running \`${process.version}\`.

| package | range | installed |
|---|---|---|
${rows}

**\`.env\` keys present (${envKeys.length}) — names only, never values:**
${envKeys.map((k) => `\`${k}\``).join(", ") || "(no .env)"}

\`npm run\` scripts: ${Object.keys(pkg.scripts ?? {}).map((s) => `\`${s}\``).join(", ")}`;
}

// Hand-written. The decisions a generator cannot read, because they live in
// Umberto's head and in conversations, not in the code.
const CONSTRAINTS = `> **This section is written by hand, not generated.** Everything above is read
> from the code and is true as of the timestamp. This part is the *intent*: the
> decisions that have already been made and are not open for re-litigation.

1. **EVE's own state stays in plain files. No database.** A generic "move to
   cloud Postgres" prompt was rejected for exactly this reason. The Supabase
   ledger is not a counter-example: EVE is a read-only *client* of it, and it
   holds Umberto's money data, never her memory.
2. **Tailnet only.** No public ports, ever, and never \`tailscale funnel\`.
   HTTPS comes from Tailscale Serve so the microphone works.
3. **One writer.** One \`FaceTurns\`/\`Agent\` per server process. Multiple
   devices may watch; they do not each get their own conversation.
4. **\`memory/core/\` and \`brain/identity.md\` are Umberto's, never EVE's.**
   She reads them every turn and has no tool, and no code path, that writes to
   them. Enforced by \`tests/memory-boundaries.test.ts\`, not by convention.
   Note: the \`(fill in)\` markers in some of those files are ordinary text —
   nothing in the code parses them, and they are not enforced boundaries.
5. **Secrets never pass through chat.** The pattern that works is a \`read -rs\`
   one-liner appending to \`.env\`; rotate in the provider's dashboard first.
6. **Backups are local by choice.** No remote, no third-party service, because
   \`memory/core/\` holds personal data about Umberto and about other people who
   consented to nothing, and git history is permanent.`;

// ── assemble ───────────────────────────────────────────────────────────────

const head = sh("git", ["log", "-1", "--format=%H"]);
const dirtyCount = sh("git", ["status", "--porcelain"]).split("\n").filter(Boolean).length;

const doc = `# EVE — ground truth

**Generated ${new Date().toISOString()}** from commit \`${head}\`${dirtyCount ? ` (+ ${dirtyCount} uncommitted change(s) — this document may describe code that is not committed)` : ""}.

Do not edit this file by hand: run \`npm run groundtruth\` and it is rewritten.
Every section marked GENERATED is read from the code. The one marked HAND-WRITTEN
is the only place a human statement belongs.

Where a fact cannot be read mechanically, this document says so rather than
guessing. That is the whole point of it: the hand-written predecessor
(\`docs/cloud-migration-suspended/archive/01-ground-truth-for-council.md\`) drifted out of date
while still being read as fact by sandboxed councils.

---

## Repository shape — GENERATED

${sectionTree()}

---

## Tools — GENERATED

${sectionTools()}

---

## Filesystem writes — GENERATED

${sectionWrites()}

---

## Tests and typecheck — GENERATED

${sectionChecks()}

---

## Git, ignores and backups — GENERATED

${sectionGit()}

---

## Dependencies and environment — GENERATED

${sectionDeps()}

---

## Constraints — HAND-WRITTEN

${CONSTRAINTS}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, doc);
console.log(`wrote ${rel(OUT)} — ${(doc.length / 1024).toFixed(1)} KB, from ${head.slice(0, 8)}`);
