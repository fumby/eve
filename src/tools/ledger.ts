// query_ledger: read-only SQL over Umberto's money ledger — a Supabase Postgres
// he fills, EVE only reads. Two walls keep it that way: the DB role
// (trillion_analytics: SELECT-only, default_transaction_read_only, 5 s
// statement timeout) and the pure guard in ledger-sql.ts. Memory stays files;
// this is an outbound client to *his* data, not a store of EVE's own.
//
// Connection: the IPv4 shared transaction pooler (Supavisor, port 6543). We
// only ever use the unnamed extended-protocol statement, no SET, no session
// state — exactly what transaction pooling supports.
import pg from "pg";
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { requireKey } from "../core/config.js";
import { audit } from "../core/audit.js";
import { MAX_ROWS, formatResult, sanitizeDsn, validateReadOnlySql, wrapWithLimit } from "./ledger-sql.js";

const { Pool, types } = pg;

// Dates come back as the text Postgres sent ('2026-07-01'), not a JS Date at
// local midnight that shifts a day when serialised as UTC.
types.setTypeParser(types.builtins.DATE, (v) => v);
types.setTypeParser(types.builtins.TIMESTAMP, (v) => v);
types.setTypeParser(types.builtins.TIMESTAMPTZ, (v) => v);

let pool: pg.Pool | null = null;

// Created on first use, not at import — the tool registers (and shows in
// capabilities) even before SUPABASE_LEDGER_URL exists, and fails in prose.
function getPool(): pg.Pool {
  if (pool) return pool;
  const { connectionString } = sanitizeDsn(requireKey("SUPABASE_LEDGER_URL"));
  const p = new Pool({
    connectionString,
    // sslmode=require parity: encrypted, not CA-verified (Supabase's pooler CA
    // isn't in the system store). Pinning the CA is a follow-up.
    ssl: { rejectUnauthorized: false },
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 8_000, // client backstop; the role's 5 s statement_timeout fires first
    statement_timeout: 5_000,
    application_name: "eve-ledger",
    allowExitOnIdle: true, // scripts (brief-now, checks) exit without hanging
    keepAlive: true,
  });
  // An idle client dropped by the pooler emits here; unhandled it would take
  // the whole face server down under launchd.
  p.on("error", (err) => audit("ledger_pool_error", { error: err.message }));
  pool = p;
  return p;
}

// Exposed for the live check script only.
export function ledgerPool(): pg.Pool {
  return getPool();
}

interface PgErr {
  code?: string;
  message?: string;
  hint?: string;
  severity?: string;
}

// Postgres and socket errors, rewritten as one sentence the model can act on.
// The DSN never appears in any of these.
function explain(err: unknown): Error {
  const e = (err ?? {}) as PgErr;
  const msg = e.message ?? String(err);
  switch (e.code) {
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new Error(
        `the ledger database host can't be resolved (${msg}) — SUPABASE_LEDGER_URL must use the IPv4 shared pooler host`,
      );
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ETIMEDOUT":
      return new Error(
        `the ledger database is unreachable right now (${msg}) — free Supabase projects pause when idle; check the dashboard`,
      );
    case "28P01":
      return new Error("the ledger database rejected the password — check SUPABASE_LEDGER_URL in .env");
    case "28000":
      return new Error(`the ledger database rejected the login (${msg}) — the user must be trillion_analytics.<project-ref>`);
    case "57014":
      return new Error("that query took longer than 5 seconds and was cancelled — narrow it (add a WHERE, or use the v_monthly_spend view)");
    case "25006":
    case "42501":
      return new Error("the ledger is read-only for EVE — that statement would need write access, and she only reads");
    case "42P01":
    case "42703":
      return new Error(`the database said: ${msg} — check the schema notes or call describe_table`);
    default:
      if (/timeout/i.test(msg)) {
        return new Error(`the ledger database didn't answer in time (${msg}) — it may be paused; check the Supabase dashboard`);
      }
      if (e.severity) return new Error(`the database said: ${msg}${e.hint ? ` (hint: ${e.hint})` : ""}`);
      return new Error(msg);
  }
}

async function runQuery(rawSql: string): Promise<string> {
  const sql = validateReadOnlySql(rawSql); // pure — throws before any connection is made
  const p = getPool();
  try {
    const res = await p.query({ text: wrapWithLimit(sql), values: [MAX_ROWS + 1], rowMode: "array" });
    return formatResult({ fields: res.fields.map((f) => f.name), rows: res.rows as unknown[][] });
  } catch (err) {
    throw explain(err);
  }
}

async function listTables(): Promise<string> {
  const p = getPool();
  try {
    const res = await p.query<{ name: string; kind: string; comment: string | null }>(
      `SELECT c.relname AS name,
              CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' END AS kind,
              obj_description(c.oid, 'pg_class') AS comment
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m')
       ORDER BY (c.relkind IN ('v','m')), c.relname`,
    );
    if (res.rows.length === 0) return "The ledger database has no tables or views in the public schema yet.";
    return res.rows.map((r) => `- ${r.name} (${r.kind})${r.comment ? `: ${r.comment}` : ""}`).join("\n");
  } catch (err) {
    throw explain(err);
  }
}

async function describeTable(table: string): Promise<string> {
  const name = table.trim().toLowerCase();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`'${table}' isn't a plain table name — use one from list_tables`);
  }
  const p = getPool();
  try {
    const res = await p.query<{
      column: string;
      type: string;
      nullable: boolean;
      default: string | null;
      comment: string | null;
    }>(
      `SELECT a.attname AS column,
              format_type(a.atttypid, a.atttypmod) AS type,
              NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS default,
              col_description(a.attrelid, a.attnum) AS comment
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [name],
    );
    if (res.rows.length === 0) throw new Error(`no table or view named '${name}' in the ledger — call list_tables`);
    const lines = res.rows.map((r) => {
      const bits = [r.type, r.nullable ? "NULL" : "NOT NULL"];
      if (r.default) bits.push(`default ${r.default}`);
      return `- ${r.column}: ${bits.join(", ")}${r.comment ? ` — ${r.comment}` : ""}`;
    });
    return `${name}\n${lines.join("\n")}`;
  } catch (err) {
    throw explain(err);
  }
}

export const ledgerTools: EveTool[] = [
  {
    name: "query_ledger",
    description:
      "Read-only SQL over Umberto's money ledger (personal + ventures; Supabase Postgres): transactions, budgets, accounts, ventures. " +
      "Use it for any question about his spending, income, budgets, or venture costs — how much, on what, when, versus budget. " +
      "action 'query' runs ONE SELECT (or WITH … SELECT) statement in Postgres 17 dialect: no semicolons, no $1 parameters, " +
      `results capped at ${MAX_ROWS} rows — aggregate or filter rather than dumping tables. ` +
      "The tables, their meaning, and the gotchas are in your system prompt under 'Data you can query'; " +
      "if a column name errors, call describe_table for live structure, and list_tables to see everything. " +
      "Never state a number you didn't get from this tool.",
    schema: z.object({
      action: z
        .enum(["query", "list_tables", "describe_table"])
        .default("query")
        .describe("'query' (default) runs sql; 'list_tables' lists tables and views; 'describe_table' shows one table's columns."),
      sql: z
        .string()
        .optional()
        .describe("For action 'query': one SELECT or WITH … SELECT statement. No semicolons."),
      table: z
        .string()
        .optional()
        .describe("For action 'describe_table': the table or view name, e.g. 'transactions'."),
    }),
    needsConfirmation: false,
    run: async (input) => {
      const action = String(input.action ?? "query");
      if (action === "list_tables") return listTables();
      if (action === "describe_table") {
        if (typeof input.table !== "string" || !input.table.trim()) {
          throw new Error("describe_table needs a table name — e.g. { action: 'describe_table', table: 'transactions' }");
        }
        return describeTable(input.table);
      }
      if (typeof input.sql !== "string" || !input.sql.trim()) {
        throw new Error("pass the SELECT statement in `sql`");
      }
      return runQuery(input.sql);
    },
  },
];
