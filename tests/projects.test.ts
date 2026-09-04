// The project reader's guards, on a fixture tree — no network, no real project
// folder. What matters: EVE reads inside a folder Umberto confirmed and
// nowhere else, and no credential value reaches the transcript.
//
// Two of these tests exist because the failure was reproduced first, not
// imagined. (1) A directory symlink defeats a lexical containment check
// entirely: path.resolve does not follow links, so "linkdir/secret.md" with
// "linkdir -> ../outside" passes a startsWith() test and then reads the file on
// the other side. src/tools/notes.ts had exactly that check and exactly that
// hole; it now shares resolveInside() with this file, and tests/notes.test.ts
// guards the same rules from that door. (2) isSensitive() in src/memory/store.ts was built to judge prose
// EVE wrote — it fires on the WORD "password" — and misses a bare AIza…,
// GOCSPX-…, sk_…, a PEM header and an ssh-rsa line, which are the shapes
// actually sitting in these project folders. Both are why redact.ts adds value
// shapes and read.ts realpaths instead of trusting either alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isSecretFilename,
  isReadableFilename,
  looksLikeSecretValue,
  redactLines,
  hasDotSegment,
  safeRelPath,
  WITHHELD,
} from "../src/projects/redact.js";
import {
  assertGrantableRoot,
  canonical,
  projectStatus,
  resolveRoot,
  resolveInside,
  readProjectFile,
  searchProject,
  ProjectError,
} from "../src/projects/read.js";
import { projectTools } from "../src/tools/projects.js";
import { isFactoryAllowed } from "../src/core/registry.js";
import { ROOT, forgetProjectDir } from "../src/core/config.js";

// ── the fixture ──────────────────────────────────────────────────────────
// A project root with a credential file, a lookalike source file, a secret
// living outside it, and both kinds of symlink pointing at that secret.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eve-projects-")));
const root = path.join(tmp, "project");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(root, "tools"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });

fs.writeFileSync(path.join(outside, "secret.md"), "TOP SECRET VALUE\n");
fs.writeFileSync(path.join(root, ".env"), "GROQ_API_KEY=gsk_realkeyvalue123456\n");
fs.writeFileSync(path.join(root, "credentials.json"), '{"private_key_id": "9f2c1a"}\n');
fs.writeFileSync(path.join(root, "credentials.json.prev.bak"), '{"private_key_id": "9f2c1a"}\n');
fs.writeFileSync(path.join(root, "README.md"), "# The project\nIt renders episodes.\n");
fs.writeFileSync(path.join(root, "tools", "tokenizer.ts"), "export const secretsmanager = 1;\n");
// The key value sits on its own line with the assignment BEFORE it, so a
// snippet window opening at "render" would carry the bare value if redaction
// ran after windowing instead of before.
fs.writeFileSync(
  path.join(root, "tools", "run.py"),
  ["# render the episode", "GOOGLE_API_KEY = 'AIzaSyD9fJ2kLmNoPqRsTuVwXyZ1234567890a'", "def render(): pass"].join("\n") + "\n",
);
// The discriminating fixture for snippet ordering. The credential rule for a
// .env-style assignment is ^-anchored, and a snippet window collapses newlines
// — so if redaction runs on the WINDOW instead of the line, every credential
// line after the first loses its anchor and rides out intact. The value here is
// deliberately shapeless (no AIza/sk_/JWT prefix) so nothing else can catch it.
fs.writeFileSync(
  path.join(root, "tools", "deploy.py"),
  ["def deploy(): pass", "WEBHOOK_URL=https://hooks.example.com/T00/B11/xyzSecretPath", "# end"].join("\n") + "\n",
);
// The fixture that proves redaction must run on LINES, before any window is
// cut. The value here has no shape of its own and its label is on the previous
// line, so only line structure can connect them — and a 220-char window opened
// past the filler collapses the newlines, destroying exactly that structure.
// Redact-first withholds the whole line; redact-after sees bare filler.
fs.writeFileSync(
  path.join(root, "tools", "keys.py"),
  [
    "def deploy(): pass",
    "private_key:",
    "  " + "q".repeat(90) + "SHAPELESSSECRETPAYLOAD" + "z".repeat(40),
    "# end",
  ].join("\n") + "\n",
);
fs.symlinkSync(path.join(outside, "secret.md"), path.join(root, "link.md")); // file symlink
fs.symlinkSync(outside, path.join(root, "linkdir")); // DIRECTORY symlink — the one that bites

// ── name rules ───────────────────────────────────────────────────────────
test("credentials files are refused by name, and their backup copies with them", () => {
  for (const name of [
    "credentials.json", "token.json", "secrets.yaml", "client_secret_123.json",
    "service_account.json", "id_rsa", "server.pem", "private.key",
    "credentials.json.prev.bak", "token.json.bak", "secrets.json.old",
  ]) {
    assert.equal(isSecretFilename(name), true, `${name} should be refused`);
  }
});

test("ordinary source that merely sounds like a secret is NOT refused", () => {
  // A refusal list that also eats real code teaches the model to route around
  // the reader. These are all real filenames in Umberto's projects.
  for (const name of ["tokenizer.ts", "secretsmanager.py", "keyframes.json", "brand.json", "tokens.css"]) {
    assert.equal(isSecretFilename(name), false, `${name} should be readable`);
    assert.equal(isReadableFilename(name), true, `${name} should pass the allowlist`);
  }
});

test("the extension allowlist refuses binaries, where an encoded blob would ride out", () => {
  for (const name of ["frame.png", "model.pickle", "episode.mp4", "archive.zip", "data.db"]) {
    assert.equal(isReadableFilename(name), false, `${name} should not be readable`);
  }
});

test("any dot segment is out of bounds, at any depth", () => {
  for (const p of [".env", ".git/config", "tools/.env", "a/.venv/lib/x.py", ".claude/settings.json"]) {
    assert.equal(hasDotSegment(p), true, `${p} should be refused`);
  }
  assert.equal(hasDotSegment("tools/run.py"), false);
});

// ── value rules ──────────────────────────────────────────────────────────
test("bare credential VALUES are caught — the ones isSensitive misses", () => {
  // Every one of these was verified to slip past src/memory/store.ts's
  // isSensitive() on its own. That is the whole reason this layer exists.
  for (const line of [
    "AIzaSyD9fJ2kLmNoPqRsTuVwXyZ1234567890a",
    "GOCSPX-AbCdEf123456GhIjKl",
    "sk_1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQxyz",
    '  "private_key_id": "9f2c1a",',
    '  "refresh_token": "1//0abc",',
    '  "type": "service_account",',
    "SUPABASE_LEDGER_URL=postgres://user:pw@host/db",
    "ELEVENLABS_API_KEY=abc123",
  ]) {
    assert.equal(looksLikeSecretValue(line), true, `should be caught: ${line.slice(0, 40)}`);
  }
});

test("ordinary code and prose are not mistaken for credentials", () => {
  for (const line of [
    "the tokenizer handles 13k tokens per turn",
    "import secretsmanager as sm",
    "def render_episode(scene_id: int) -> Path:",
    "MAX_RETRIES = 3",
    "# AIza is the prefix Google uses",
  ]) {
    assert.equal(looksLikeSecretValue(line), false, `false positive on: ${line}`);
  }
});

test("redaction replaces whole lines and counts them", () => {
  const { text, redacted } = redactLines("safe line\nAIzaSyD9fJ2kLmNoPqRsTuVwXyZ1234567890a\nalso safe\n");
  assert.equal(redacted, 1);
  assert.ok(text.includes(WITHHELD));
  assert.ok(!text.includes("AIzaSyD9fJ2kLmNoPqRsTuVwXyZ1234567890a"));
  assert.ok(text.includes("safe line") && text.includes("also safe"));
});

// ── containment ──────────────────────────────────────────────────────────
test("a symlinked DIRECTORY cannot walk a read out of the project folder", () => {
  // The reproduced failure. A lexical prefix check accepts this path: it is
  // spelled entirely inside the root, and only realpath reveals otherwise.
  assert.throws(() => resolveInside(root, "linkdir/secret.md"), ProjectError);
  assert.throws(() => readProjectFile(root, "linkdir/secret.md"), ProjectError);
});

test("a symlinked FILE cannot either", () => {
  assert.throws(() => resolveInside(root, "link.md"), ProjectError);
});

test("..-escapes, absolute paths and hidden files are refused", () => {
  assert.throws(() => resolveInside(root, "../outside/secret.md"), ProjectError);
  assert.throws(() => resolveInside(root, path.join(outside, "secret.md")), ProjectError);
  assert.throws(() => resolveInside(root, ".env"), ProjectError);
});

test("a credentials file is refused even when its path is named directly", () => {
  // The walk never sees this path, so a guard living only in the walk is a
  // guard with the front door open — the state notes.ts was in until it started
  // routing read_note through resolveInside too.
  assert.throws(() => readProjectFile(root, "credentials.json"), ProjectError);
  assert.throws(() => readProjectFile(root, "credentials.json.prev.bak"), ProjectError);
});

test("an ordinary file inside the project reads fine", () => {
  const r = readProjectFile(root, "README.md");
  assert.ok(r.text.includes("It renders episodes."));
  assert.equal(r.redacted, 0);
});

// ── the grant itself ─────────────────────────────────────────────────────
test("a root that CONTAINS EVE's checkout is refused, not just one inside it", () => {
  // The ancestor that is NOT the home folder — on this machine "/Users".
  // dirname(ROOT) IS the home folder, so an earlier version of this assertion
  // only ever exercised the homedir branch and stayed green with the ancestor
  // check deleted. A grandparent reaches brain/identity.md and memory/core/,
  // the files invariant 1 says are Umberto's alone.
  const grandparent = path.dirname(fs.realpathSync(os.homedir()));
  assert.notEqual(grandparent, fs.realpathSync(os.homedir()), "fixture assumption: home has a parent");
  assert.notEqual(grandparent, path.parse(grandparent).root, "fixture assumption: that parent isn't /");
  assert.throws(() => assertGrantableRoot(grandparent), ProjectError);
  assert.throws(() => assertGrantableRoot(path.dirname(fs.realpathSync(ROOT))), ProjectError);
  assert.throws(() => assertGrantableRoot(fs.realpathSync(ROOT)), ProjectError);
  assert.throws(() => assertGrantableRoot(path.join(fs.realpathSync(ROOT), "brain")), ProjectError);
  assert.throws(() => assertGrantableRoot(fs.realpathSync(os.homedir())), ProjectError);
  assert.throws(() => assertGrantableRoot(path.parse(process.cwd()).root), ProjectError);
  // …while an ordinary project folder is fine.
  assert.doesNotThrow(() => assertGrantableRoot(root));
});

// ── search ───────────────────────────────────────────────────────────────
test("a search snippet cannot carry a key value, even when the window opens past its name", () => {
  const { hits } = searchProject(root, "render");
  const found = hits.find((h) => h.rel.endsWith("run.py"));
  assert.ok(found, "expected run.py to match 'render'");
  assert.ok(!found.snippet.includes("AIzaSyD9fJ2kLmNoPqRsTuVwXyZ1234567890a"), "the key leaked into a snippet");
  assert.ok(found.snippet.includes("withheld"), "the credential line should be visibly withheld");
});

test("a shapeless value under a label on the previous line cannot ride out in a window", () => {
  // The strongest ordering case: nothing about this value matches any rule on
  // its own. Only the label above it marks it, and only if lines are still
  // lines when the judging happens.
  const { hits } = searchProject(root, "SHAPELESSSECRETPAYLOAD");
  for (const h of hits) {
    assert.ok(!h.snippet.includes("SHAPELESSSECRETPAYLOAD"), `the payload leaked: ${h.snippet.slice(0, 120)}`);
  }
});

test("a credential line is redacted before the window is cut, not after", () => {
  // Redacting the collapsed window instead of the line is a silent regression:
  // the ^-anchored .env rule only matches the window's first line, so this
  // value walks straight out. Judging the line first is what holds.
  const { hits } = searchProject(root, "deploy");
  const found = hits.find((h) => h.rel.endsWith("deploy.py"));
  assert.ok(found, "expected deploy.py to match 'deploy'");
  assert.ok(!found.snippet.includes("xyzSecretPath"), `the webhook URL leaked: ${found.snippet}`);
});

test("the walk never surfaces a credentials file or anything hidden", () => {
  const { hits } = searchProject(root, "e"); // matches nearly everything readable
  const names = hits.map((h) => h.rel);
  assert.ok(!names.some((n) => n.includes("credentials.json")), names.join(","));
  assert.ok(!names.some((n) => n.includes(".env")), names.join(","));
  assert.ok(!names.some((n) => n.includes("link")), "a symlink was walked");
});

// ── the Factory ──────────────────────────────────────────────────────────
test("no project tool is offered to spawned agents", () => {
  // The default would have gone the other way: isFactoryAllowed offers any
  // ungated tool whose name misses FACTORY_WITHHELD, so search_project and
  // read_project_file would have been handed out silently. A spawned agent has
  // no human on its channel; standing read access to folders full of
  // credentials is not something it should inherit by omission.
  for (const t of projectTools) {
    assert.equal(isFactoryAllowed(t), false, `${t.name} is offered to the Factory`);
  }
});

test("the two tools that widen or narrow access are gated", () => {
  const gated = projectTools.filter((t) => t.needsConfirmation === true).map((t) => t.name).sort();
  assert.deepEqual(gated, ["forget_project_dir", "set_project_dir"]);
});

test("the gate's log rendering never carries a surveyed folder's contents", () => {
  const tool = projectTools.find((t) => t.name === "set_project_dir")!;
  const intent = tool.confirmIntent!({ name: "fixture", dir: root });
  // The survey belongs in what Umberto reads on his own screen, never in
  // logs/audit.jsonl or the notices inbox — that split is the whole point of
  // confirmIntent returning two strings (src/core/registry.ts:120).
  assert.ok(intent.human.includes(root));
  assert.ok(intent.human.includes("at the top level"), "the gate should describe what it is granting");
  assert.equal(intent.log, `set_project_dir fixture -> ${root}`);
  assert.ok(!intent.log.includes("at the top level"), "the survey reached logs/audit.jsonl");
});


// ── what the adversarial review found, each with its own guard ───────────
test("a differently-cased path cannot walk around the grant refusals", () => {
  // fs.realpathSync resolves symlinks but hands back the CALLER's spelling, so
  // on case-insensitive APFS "/users/you" compared !== the real
  // "/Users/..." and all four refusals missed by one character — while opening
  // exactly the same directory. Only fs.realpathSync.native canonicalises case.
  // The earlier version of this suite fed only already-canonical paths, so it
  // stayed green through the hole.
  const home = canonical(os.homedir());
  const swapped = (p: string) => (p === p.toLowerCase() ? p.toUpperCase() : p.toLowerCase());
  for (const variant of [swapped(home), swapped(path.dirname(home)), swapped(canonical(ROOT))]) {
    assert.throws(() => assertGrantableRoot(variant), ProjectError, `accepted ${variant}`);
  }
});

test("appending a readable extension does not launder a credentials file", () => {
  // A one-shot suffix strip judged the name once; "credentials.json.txt" then
  // missed the name rule AND passed the .txt allowlist.
  for (const name of [
    "credentials.json.txt", "id_rsa.md", "server.pem.txt", "token.json.md",
    "secrets.yaml.json", "credentials.json.bak.txt", "id_rsa.",
  ]) {
    assert.equal(isSecretFilename(name), true, `${name} should be refused`);
    assert.equal(isReadableFilename(name), false, `${name} should not be readable`);
  }
  // …without eating real source that merely shares a word.
  for (const name of ["tokenizer.ts", "secretsmanager.py", "keyframes.json", "brand.json"]) {
    assert.equal(isReadableFilename(name), true, `${name} became unreadable`);
  }
});

test("a whole PEM block is withheld, not just its header line", () => {
  const pem = [
    "some context",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB",
    "AAAAMwAAAAtzc2gtZWQyNTUxOQAAACBFAKEKEYMATERIALHEREXX",
    "-----END OPENSSH PRIVATE KEY-----",
    "after",
  ].join("\n");
  const { text } = redactLines(pem);
  assert.ok(!text.includes("b3BlbnNzaC1rZXktdjEA"), "PEM body survived redaction");
  assert.ok(!text.includes("AAAAMwAAAAtzc2gt"), "PEM body survived redaction");
  assert.ok(text.includes("some context") && text.includes("after"), "context was eaten");
});

test("a value on the line after its label is withheld too", () => {
  const { text } = redactLines('{\n  "private_key":\n    "-----FAKEKEYMATERIAL-----",\n  "ok": 1\n}');
  assert.ok(!text.includes("FAKEKEYMATERIAL"), "the carried value leaked");
  assert.ok(text.includes('"ok": 1'), "an ordinary line was eaten");
});

test("an indented or lower-cased assignment is caught, not only a SCREAMING one at line start", () => {
  // The ^-anchored rule missed every one of these.
  for (const line of [
    "    api_key = 'abc123def456'",
    "  webhook_url: https://hooks.example.com/T00/B11/xyz",
    "\tdatabase_password=hunter2",
    "self.access_token = resp['tok']",
  ]) {
    assert.equal(looksLikeSecretValue(line), true, `missed: ${line}`);
  }
});

test("a credential living in a FILENAME is not echoed back", () => {
  const leaky = "keys/AIzaSyD9fJ2kLmNoPqRsTuVwXyZ1234567890a.md";
  assert.ok(!safeRelPath(leaky).includes("AIzaSyD9fJ2kLm"), "the filename leaked");
  assert.equal(safeRelPath("tools/run.py"), "tools/run.py");
});

test("binary content behind a text extension is refused, not returned as mojibake", () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "eve-projects-bin-"));
  fs.writeFileSync(path.join(binDir, "data.json"), Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x00, 0x03]));
  assert.throws(() => readProjectFile(canonical(binDir), "data.json"), ProjectError);
});

test("a slug off Object.prototype is missing, not a resolved root or a fake revocation", () => {
  // `map[slug]` yields a FUNCTION for "constructor"/"toString", which is
  // truthy — so resolveRoot got that far and then died on a TypeError instead
  // of saying the project doesn't exist. `slug in projects` had the same shape
  // in forgetProjectDir, which reported a revocation that never happened.
  // Object.hasOwn is what makes both plainly absent.
  for (const slug of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
    assert.throws(
      () => resolveRoot(slug),
      ProjectError,
      `resolveRoot("${slug}") did not fail cleanly`,
    );
    assert.equal(forgetProjectDir(slug), false, `forgetProjectDir("${slug}") claimed a revocation`);
  }
});

test("project_status reads its README through the same guard as everything else", () => {
  // This loop used a bare path.join + statSync, so a README.md symlinked to a
  // file outside the root was read and printed — the one place in the file
  // that skipped its own containment check.
  const linkRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eve-projects-link-")));
  const proj = path.join(linkRoot, "p");
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(linkRoot, "elsewhere.md"), "OUTSIDE CONTENT\n");
  fs.symlinkSync(path.join(linkRoot, "elsewhere.md"), path.join(proj, "README.md"));
  const s = projectStatus("linky", canonical(proj));
  assert.equal(s.selfDescription, null, "a symlinked README was read from outside the root");
});
