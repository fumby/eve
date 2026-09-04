// The pure half of query_ledger: SQL guard, LIMIT wrap, result shaping, DSN
// hygiene. Deliberately no I/O — every rule here is unit-tested with no
// database in sight (see tests/ledger.test.ts). The database role is already
// SELECT-only and read-only-by-default; this layer is the second wall, so a
// bad query fails fast with a sentence the model can act on.

export const MAX_ROWS = 200;
export const MAX_SQL_CHARS = 4000;
export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_CELL_CHARS = 500;

// Two views of one statement, produced in a single pass:
//   sql  — comments removed, string literals kept  → what actually runs
//   code — comments removed, string literals blanked → what the rules inspect
// Blanking literals is the point: a `;` or `drop` inside '...' is data, and a
// regex over the raw text can't tell the difference.
export interface SqlViews {
  sql: string;
  code: string;
}

const isIdent = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

export function tokenize(input: string): SqlViews {
  let sql = "";
  let code = "";
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i]!;
    const nx = input[i + 1];

    // -- line comment: dropped up to (not including) the newline
    if (ch === "-" && nx === "-") {
      while (i < n && input[i] !== "\n") i++;
      continue;
    }
    // /* block comment */, nested as Postgres allows
    if (ch === "/" && nx === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (input[i] === "/" && input[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (input[i] === "*" && input[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) throw new Error("that SQL has an unterminated /* comment");
      sql += " ";
      code += " ";
      continue;
    }
    // E'...' with backslash escapes, or plain '...' with '' escapes
    if (ch === "'" || ((ch === "E" || ch === "e") && nx === "'" && !isIdent(input[i - 1]))) {
      const escaped = ch !== "'";
      const start = i;
      i += escaped ? 2 : 1;
      let closed = false;
      while (i < n) {
        const c = input[i];
        if (escaped && c === "\\") {
          i += 2;
          continue;
        }
        if (c === "'") {
          if (input[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error("that SQL has an unterminated string literal (missing closing ')");
      sql += input.slice(start, i);
      code += "'?'";
      continue;
    }
    // "quoted identifier" with "" escapes
    if (ch === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (input[i] === '"') {
          if (input[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error('that SQL has an unterminated "quoted identifier"');
      const raw = input.slice(start, i);
      sql += raw;
      // Blanking a quoted identifier is right almost everywhere: a column named
      // "update" is data, not a write, and the keyword rules must not see it.
      // In FUNCTION position it is exactly backwards — Postgres resolves
      // "pg_sleep"(10) to the same function as pg_sleep(10), so blanking hid the
      // one name the blocklist exists to read. Only a following paren unquotes
      // it, which leaves `… AS "x"(a, b)` (a column alias list) still harmless.
      let j = i;
      while (j < n && /\s/.test(input[j]!)) j++;
      code += input[j] === "(" ? raw.slice(1, -1).replace(/""/g, '"') : '"?"';
      continue;
    }
    // $tag$ ... $tag$ dollar quoting
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i));
      if (m) {
        const tag = m[0];
        const end = input.indexOf(tag, i + tag.length);
        if (end < 0) throw new Error("that SQL has an unterminated dollar-quoted string");
        sql += input.slice(i, end + tag.length);
        code += "'?'";
        i = end + tag.length;
        continue;
      }
    }
    sql += ch;
    code += ch;
    i++;
  }
  return { sql, code };
}

// Model output arrives in every shape: fenced, trailing semicolon, both.
export function normalizeSql(raw: string): string {
  let s = raw.trim();
  const fence = /^```(?:sql)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = fence[1]!.trim();
  if (s.length === 0) throw new Error("no SQL was given — pass one SELECT statement in `sql`");
  if (s.length > MAX_SQL_CHARS) {
    throw new Error(`that query is ${s.length} characters — keep it under ${MAX_SQL_CHARS}`);
  }
  return s;
}

const FORBIDDEN_KEYWORDS =
  /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|execute|call|do|vacuum|into|set|reset|lock|refresh|listen|notify|discard|begin|commit|rollback)\b/i;
const ROW_LOCKS = /\bfor\s+(no\s+key\s+)?update\b|\bfor\s+(key\s+)?share\b/i;
const SIDE_EFFECT_FUNCTIONS =
  /\b(pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_notify|set_config|pg_(?:try_)?advisory\w*|nextval|setval|lo_\w+|pg_read_\w+|pg_ls_\w+|dblink\w*|pg_reload_conf)\s*\(/i;

// Returns the runnable statement (comments stripped, trailing `;` removed) or
// throws a plain-language reason. Every message is written for the model to
// relay or repair from.
export function validateReadOnlySql(raw: string): string {
  const s = normalizeSql(raw);
  const views = tokenize(s);
  const code = views.code.trim().replace(/[\s;]+$/, "");
  const sql = views.sql.trim().replace(/[\s;]+$/, "");
  if (!/^(select|with)\b/i.test(code)) {
    throw new Error("only SELECT (or WITH … SELECT) statements are allowed — the ledger is read-only");
  }
  if (code.includes(";")) {
    throw new Error("one statement at a time — remove the semicolon and run the second query separately");
  }
  if (/\$\d/.test(code)) {
    throw new Error("don't use $1-style parameters — write the literal value into the query");
  }
  const kw = FORBIDDEN_KEYWORDS.exec(code);
  if (kw) {
    throw new Error(
      `'${kw[1]!.toUpperCase()}' isn't allowed — the ledger is read-only, and EVE only ever runs SELECT`,
    );
  }
  if (ROW_LOCKS.test(code)) throw new Error("row locks (FOR UPDATE / FOR SHARE) aren't allowed on the ledger");
  const fn = SIDE_EFFECT_FUNCTIONS.exec(code);
  if (fn) throw new Error(`${fn[1]!} isn't allowed here — read-only queries only`);
  return sql;
}

// Newline padding matters: a trailing `-- comment` in the inner SQL would
// otherwise swallow the closing paren. $1 is the row cap (MAX_ROWS + 1 so we
// can tell "exactly 200" from "more than 200").
export function wrapWithLimit(sql: string): string {
  return `SELECT * FROM (\n${sql}\n) AS _q LIMIT $1`;
}

export function jsonSafeCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<bytea ${v.byteLength} bytes>`;
  if (Array.isArray(v)) return v.map(jsonSafeCell);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = jsonSafeCell(val);
    return out;
  }
  return String(v);
}

export interface RawResult {
  fields: string[];
  rows: unknown[][];
}

// Compact JSON the model reads well, with the caps applied and stated. Rows
// beyond MAX_ROWS are dropped; if the text is still too long, whole rows are
// dropped from the end — never a mid-JSON slice.
export function formatResult(r: RawResult): string {
  if (r.rows.length === 0) return "The query ran fine but returned no rows.";
  const overCap = r.rows.length > MAX_ROWS;
  let rows = r.rows.slice(0, MAX_ROWS).map((row) => row.map(jsonSafeCell));
  const kept = rows.length;
  const build = (rs: unknown[][]): string =>
    JSON.stringify({ columns: r.fields, rowCount: rs.length, truncated: overCap || rs.length < kept, rows: rs });
  let out = build(rows);
  while (out.length > MAX_OUTPUT_CHARS && rows.length > 1) {
    rows = rows.slice(0, Math.max(1, Math.floor(rows.length * 0.7)));
    out = build(rows);
  }
  if (overCap) {
    out += `\n(Only the first ${rows.length} rows are shown; there were more. Aggregate or filter to narrow it.)`;
  } else if (rows.length < kept) {
    out += `\n(Only the first ${rows.length} of ${kept} rows fit; the rest were dropped. Aggregate or filter to narrow it.)`;
  }
  return out;
}

export interface DsnSummary {
  user: string;
  host: string;
  port: string;
  database: string;
}

// The pg driver lets DSN query params (sslmode=…) override the explicit ssl
// config we pass — so those are stripped here. Also refuses the two mistakes
// the Supabase UI nudges you into: the superuser, and the IPv6-only direct host.
export function sanitizeDsn(raw: string): { connectionString: string; summary: DsnSummary } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      "SUPABASE_LEDGER_URL is not a valid postgresql:// URL — if the password has special characters, percent-encode them (or pick an alphanumeric one)",
    );
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("SUPABASE_LEDGER_URL must start with postgresql://");
  }
  const user = decodeURIComponent(url.username);
  if (user === "postgres" || user.startsWith("postgres.")) {
    throw new Error(
      "SUPABASE_LEDGER_URL uses the postgres superuser — it must be the read-only role: trillion_analytics.<project-ref>",
    );
  }
  if (!user.startsWith("trillion_analytics")) {
    throw new Error(`SUPABASE_LEDGER_URL user is '${user}' — expected trillion_analytics.<project-ref>`);
  }
  if (!url.hostname.endsWith(".pooler.supabase.com")) {
    throw new Error(
      `SUPABASE_LEDGER_URL host is ${url.hostname} — the direct db.<ref>.supabase.co host is IPv6-only; use the IPv4 shared pooler (aws-N-<region>.pooler.supabase.com)`,
    );
  }
  const port = url.port || "5432";
  if (port !== "6543" && port !== "5432") {
    throw new Error(`SUPABASE_LEDGER_URL port is ${port} — the transaction pooler listens on 6543`);
  }
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith("ssl")) url.searchParams.delete(key);
  }
  return {
    connectionString: url.toString(),
    summary: { user, host: url.hostname, port, database: url.pathname.replace(/^\//, "") || "postgres" },
  };
}
