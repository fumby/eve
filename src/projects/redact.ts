// The pure half of the project reader: which files may be opened at all, and
// how a credential is kept out of the transcript. No I/O here on purpose —
// every rule is testable without a filesystem, which matters because these
// rules are the only thing between EVE and four folders that really do hold
// live API keys, OAuth tokens and refresh tokens on disk (`.env`,
// `credentials.json` and `token.json` exist in every one of them today).
import path from "node:path";
import { isSensitive } from "../memory/store.js";

// An ALLOWLIST, not a denylist. A refusal list has to anticipate every
// extension a secret might wear; this only has to name the ones worth reading.
export const READABLE_EXT = new Set([
  ".md", ".txt", ".rst", ".org",
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".json", ".jsonl", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf",
  ".sh", ".bash", ".zsh", ".sql", ".csv", ".tsv",
  ".html", ".css", ".xml", ".graphql", ".prisma",
]);

// Anchored on the WHOLE basename, never a substring. `tokenizer.ts`,
// `secretsmanager.py` and `keyframes.json` are ordinary source in these very
// projects; a refusal list that also eats them teaches the model to route
// around the reader, which is worse than not having one.
const SECRET_BASENAME =
  /^(?:credentials?|tokens?|secrets?|client_secret[\w.-]*|service_account[\w.-]*|serviceaccount[\w.-]*|htpasswd)\.(?:json|ya?ml|txt|pickle|pkl|env|cfg|ini|toml)$/i;
const SECRET_NAME_EXACT = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "authorized_keys", "known_hosts",
  "htpasswd", "netrc", "npmrc", "pypirc", "pgpass", "git-credentials",
]);
const SECRET_EXT = /\.(?:pem|key|p12|pfx|pkcs12|jks|keystore|asc|gpg|kdbx|ppk|crt|cer|der)$/i;

// Judge the name at EVERY trailing-extension boundary, not just once. A single
// pass over a fixed list of backup suffixes is not enough: appending any
// readable extension — `credentials.json.txt`, `id_rsa.md`, `server.pem.txt` —
// walks straight past a one-shot check and then passes the extension
// allowlist, which is a verified way through the front door.
function nameCandidates(basename: string): string[] {
  const out = [basename];
  let cur = basename;
  // At most 6 steps: a name with more trailing extensions than that is not a
  // filename anyone typed, and an unbounded loop on a pathological name is its
  // own problem.
  for (let i = 0; i < 6; i++) {
    const dot = cur.lastIndexOf(".");
    if (dot <= 0) break;
    cur = cur.slice(0, dot);
    out.push(cur);
  }
  return out;
}

export function isSecretFilename(basename: string): boolean {
  // Trailing dots and spaces are stripped by some filesystems on open, so a
  // name is judged without them too.
  const cleaned = basename.replace(/[.\s]+$/, "");
  for (const candidate of nameCandidates(cleaned)) {
    const lower = candidate.toLowerCase();
    if (SECRET_NAME_EXACT.has(lower)) return true;
    if (SECRET_NAME_EXACT.has(lower.replace(/^\./, ""))) return true;
    if (SECRET_EXT.test(candidate)) return true;
    if (SECRET_BASENAME.test(candidate)) return true;
  }
  return false;
}

// Any path segment beginning with a dot is refused outright, on the walk AND
// on a path the model hands us directly. notes.ts skips dotfiles only while
// walking, so a model that simply asks for ".env" gets it — that gap is the
// reason this is a shared function rather than a line inside the walker.
export function hasDotSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

export const SKIP_DIRS = new Set([
  "node_modules", "venv", "env", "__pycache__", "dist", "build", "site-packages",
  "coverage", "target", "vendor", "out", "Pods", "DerivedData",
]);

export function isReadableFilename(basename: string): boolean {
  if (isSecretFilename(basename)) return false;
  return READABLE_EXT.has(path.extname(basename).toLowerCase());
}

// VALUE shapes. isSensitive() in src/memory/store.ts judges prose EVE wrote —
// it fires on the WORD "password" — and was never a detector for a bare
// credential value: it misses AIza…, GOCSPX-…, sk_…, ya29.…, a PEM header and
// an ssh-rsa line outright. Those are the shapes actually on disk in these
// folders, so they are named here and the two are always used together.
const SECRET_VALUE = new RegExp(
  [
    "AIza[0-9A-Za-z_-]{20,}",                        // Google API key
    "GOCSPX-[0-9A-Za-z_-]{10,}",                     // Google OAuth client secret
    "\\bya29\\.[0-9A-Za-z_-]{20,}",                  // Google OAuth access token
    "\\b1//[0-9A-Za-z_-]{20,}",                      // Google OAuth refresh token
    "\\b(?:sk|rk|pk)[_-][A-Za-z0-9]{20,}",           // ElevenLabs / Stripe / OpenAI
    "\\bxox[baprs]-[0-9A-Za-z-]{10,}",               // Slack
    "hooks\\.slack\\.com/services/[A-Za-z0-9/]{10,}",// Slack webhook
    "\\b\\d{8,10}:AA[0-9A-Za-z_-]{30,}",             // Telegram bot token
    "-----BEGIN (?:[A-Z][A-Z ]*)?PRIVATE KEY-----",  // PEM, incl. bare PKCS#8
    "\\bssh-(?:rsa|dss|ed25519) AAAA[0-9A-Za-z+/]{20,}",
    "\"private_key(?:_id)?\"\\s*:",                  // service-account JSON
    "\"(?:refresh|access|id|bearer)_token\"\\s*:",
    "\"(?:token|secret|password|passwd|api_key|apikey)\"\\s*:",
    "\"type\"\\s*:\\s*\"service_account\"",
    "\\bnpm_[A-Za-z0-9]{30,}",
    "\\bglpat-[0-9A-Za-z_-]{15,}",
    "\\bhf_[A-Za-z0-9]{30,}",
    "\\bdop_v1_[a-f0-9]{60,}",
    "\\bBasic [A-Za-z0-9+/]{16,}={0,2}",             // HTTP basic auth header
    // An assignment to a credential-ish NAME, anywhere on the line rather than
    // only at its start. The ^-anchored version missed every indented or
    // lower-cased assignment, and missed everything after the first line once a
    // snippet window collapsed its newlines.
    "[A-Za-z_][A-Za-z0-9_]*(?:key|token|secret|password|passwd|credentials?|dsn|uri|url)\\s*[:=]\\s*[\"'`]?\\S",
  ].join("|"),
  "i",
);

export function looksLikeSecretValue(line: string): boolean {
  return SECRET_VALUE.test(line);
}

// A credential-ish LABEL with nothing after it: the value is on the next line.
// `"private_key":` / `password =` / `token: |` all end a line this way in JSON,
// YAML and .env-adjacent formats, so the following line is withheld too.
const DANGLING_LABEL =
  /(?:key|token|secret|password|passwd|credentials?|private_key(?:_id)?)["']?\s*[:=]\s*(?:[|>[({]|&\S+)?\s*$/i;

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]*-----/;
const PEM_END = /-----END [A-Z0-9 ]*-----/;

export const WITHHELD = "… (line withheld — it reads like a credential)";

// Judged line by line, and always BEFORE any windowing — a search snippet is a
// character window, so windowing first would carry a raw value with nothing
// left to match on. Three pieces of state, each for a shape that a purely
// line-local rule cannot see: a PEM block (only its header matches), a value
// on the line after its label, and the END marker that closes a block.
export function redactLines(text: string): { text: string; redacted: number } {
  let redacted = 0;
  let inBlock = false;
  let carry = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (inBlock) {
      redacted++;
      if (PEM_END.test(line)) inBlock = false;
      continue; // the whole block collapses into the one placeholder already emitted
    }
    if (!line.trim()) {
      out.push(line);
      continue; // a blank line neither leaks nor breaks a carry
    }
    if (PEM_BEGIN.test(line)) {
      redacted++;
      inBlock = !PEM_END.test(line);
      carry = false;
      out.push(WITHHELD);
      continue;
    }
    if (carry || looksLikeSecretValue(line) || isSensitive(line)) {
      redacted++;
      carry = DANGLING_LABEL.test(line);
      out.push(WITHHELD);
      continue;
    }
    carry = DANGLING_LABEL.test(line);
    if (carry) {
      // The label itself is not the secret, but the next line is.
      out.push(line);
      continue;
    }
    out.push(line);
  }
  return { text: out.join("\n"), redacted };
}

// A path is echoed back to the model by search and by status, so a credential
// living in a FILENAME would ride out on the one string nothing was checking.
export function safeRelPath(rel: string): string {
  return looksLikeSecretValue(rel) || isSensitive(rel)
    ? "… (path withheld — the filename reads like a credential)"
    : rel;
}
