import "./sandbox.js"; // MUST stay first — isolates state before src/ is evaluated
// Live verification of the ledger connection and the query_ledger tool —
// the gate before "it works". Talks to the real Supabase database with the
// real DSN from .env. Prints host/port/user only, never the DSN. Every check
// prints ✅ with the actual value or ❌ with the real error, then exits 1.
//
//   npm run ledgercheck
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { loadEnv, ROOT, requireKey } from "../src/core/config.js";
import { Registry } from "../src/core/registry.js";
import { ledgerTools, ledgerPool } from "../src/tools/ledger.js";
import { sanitizeDsn } from "../src/tools/ledger-sql.js";

loadEnv();

const EXPECTED = ["accounts", "budgets", "categories", "transactions", "v_budget_status", "v_monthly_spend", "ventures"];
let failures = 0;

function pass(msg: string): void {
  console.log(`✅ ${msg}`);
}
function fail(msg: string): void {
  failures++;
  console.error(`❌ ${msg}`);
}
const errText = (e: unknown): string => {
  const x = e as { code?: string; message?: string };
  return `${x.code ? `[${x.code}] ` : ""}${x.message ?? String(e)}`;
};

async function main(): Promise<void> {
  // 0. DSN shape (no secret printed)
  let summary;
  try {
    ({ summary } = sanitizeDsn(requireKey("SUPABASE_LEDGER_URL")));
    pass(`DSN shape: user=${summary.user} host=${summary.host} port=${summary.port} db=${summary.database}`);
  } catch (e) {
    fail(`DSN: ${errText(e)}`);
    return;
  }

  // 1. Connect + identity + role settings
  const pool = ledgerPool();
  try {
    const r = await pool.query<{ user: string; ts: string; ro: string; st: string; v: string }>(
      "SELECT current_user AS user, now()::text AS ts, current_setting('default_transaction_read_only') AS ro, current_setting('statement_timeout') AS st, version() AS v",
    );
    const row = r.rows[0]!;
    pass(`connected as ${row.user} at ${row.ts} — ${row.v.split(",")[0]}`);
    if (row.user !== "trillion_analytics") fail(`current_user is ${row.user}, expected trillion_analytics`);
    if (row.ro === "on") pass("default_transaction_read_only = on");
    else fail(`default_transaction_read_only = ${row.ro} (expected on)`);
    if (row.st === "5s") pass("statement_timeout = 5s");
    else fail(`statement_timeout = ${row.st} (expected 5s)`);
  } catch (e) {
    fail(`connect: ${errText(e)}`);
    console.error(
      "   → ENOTFOUND/EAI_AGAIN: host is IPv6-only, use the IPv4 shared pooler · 28P01: password · 28000: user must be trillion_analytics.<ref> · timeout: project paused?",
    );
    await pool.end();
    process.exit(1);
  }

  // 2. Tables
  try {
    const r = await pool.query<{ name: string }>(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') ORDER BY 1",
    );
    const names = r.rows.map((x) => x.name);
    if (JSON.stringify(names) === JSON.stringify(EXPECTED)) pass(`tables/views: ${names.join(", ")}`);
    else fail(`tables/views differ — got [${names.join(", ")}], expected [${EXPECTED.join(", ")}]`);
    // doc drift: every table named in brain/ledger-schema.md must exist
    const doc = fs.readFileSync(path.join(ROOT, "brain", "ledger-schema.md"), "utf8");
    const mentioned = [...doc.matchAll(/\*\*([a-z_]+)\*\*/g)].map((m) => m[1]!);
    const missing = mentioned.filter((m) => !names.includes(m));
    if (missing.length) fail(`brain/ledger-schema.md names objects not in the DB: ${missing.join(", ")}`);
    else pass(`schema doc mentions ${mentioned.length} objects, all present`);
  } catch (e) {
    fail(`tables: ${errText(e)}`);
  }

  // 3. Data present
  try {
    const r = await pool.query<{ n: string; seed: string }>(
      "SELECT count(*)::text AS n, count(*) FILTER (WHERE source = 'seed')::text AS seed FROM transactions",
    );
    const n = Number(r.rows[0]!.n);
    if (n > 0) pass(`transactions: ${n} rows (${r.rows[0]!.seed} seed)`);
    else fail("transactions is empty");
  } catch (e) {
    fail(`count: ${errText(e)}`);
  }

  // 4. Negative probes straight at the DB (the role must refuse on its own)
  try {
    await pool.query("INSERT INTO ventures (name, stage) VALUES ('probe', 'idea')");
    fail("INSERT succeeded — the role is NOT read-only");
  } catch (e) {
    const t = errText(e);
    if (/read-only|permission denied/i.test(t)) pass(`INSERT refused by the database: ${t}`);
    else fail(`INSERT failed for an unexpected reason: ${t}`);
  }
  try {
    const t0 = Date.now();
    await pool.query("SELECT pg_sleep(10)");
    fail("pg_sleep(10) ran to completion — statement_timeout not applied");
  } catch (e) {
    const t = errText(e);
    if (/statement timeout|canceling statement/i.test(t)) pass(`pg_sleep(10) cancelled by statement_timeout: ${t}`);
    else fail(`pg_sleep(10) failed for an unexpected reason: ${t}`);
  }
  // The tool always sends a bound parameter ($1 = row cap), which forces the
  // extended protocol — where Postgres refuses multiple statements outright.
  // (With no values, pg falls back to the simple protocol, which allows them.)
  try {
    await pool.query({ text: "SELECT $1::int; SELECT 2", values: [1] });
    fail("multi-statement query accepted by the server on the extended protocol");
  } catch (e) {
    const t = errText(e);
    if (/multiple commands|syntax error/i.test(t)) pass(`multi-statement refused by the server on the extended protocol: ${t}`);
    else fail(`multi-statement failed for an unexpected reason: ${t}`);
  }

  // 5. TLS with strict verification — decides whether CA pinning is a follow-up
  {
    const { connectionString } = sanitizeDsn(requireKey("SUPABASE_LEDGER_URL"));
    const strict = new pg.Client({ connectionString, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10_000 });
    try {
      await strict.connect();
      await strict.query("SELECT 1");
      pass("TLS: strict verification (rejectUnauthorized: true) succeeded — CA is trusted by the system store");
    } catch (e) {
      console.log(`ℹ️  TLS: strict verification failed (${errText(e)}) — running in sslmode=require parity; CA pinning is a follow-up`);
    } finally {
      await strict.end().catch(() => {});
    }
  }

  // 6. The tool itself, through the Registry (gate + audit + prose errors)
  const registry = new Registry();
  for (const t of ledgerTools) registry.register(t);
  const run = (input: Record<string, unknown>) => registry.execute("query_ledger", input);

  {
    const r = await run({ action: "list_tables" });
    if (!r.isError && /transactions \(table\)/.test(r.content)) pass(`tool list_tables:\n${indent(r.content)}`);
    else fail(`tool list_tables: ${r.content}`);
  }
  {
    const r = await run({ action: "describe_table", table: "transactions" });
    if (!r.isError && /amount: numeric\(12,2\), NOT NULL/.test(r.content)) pass(`tool describe_table transactions:\n${indent(r.content)}`);
    else fail(`tool describe_table: ${r.content}`);
  }
  {
    const r = await run({
      sql: "select c.name as category, sum(t.amount) as total from transactions t join categories c on c.id = t.category_id where t.kind = 'expense' and t.occurred_on >= '2026-07-01' and t.occurred_on < '2026-08-01' group by 1 order by 2 desc",
    });
    if (!r.isError && /"groceries"/.test(r.content)) pass(`tool query (July spend by category):\n${indent(r.content)}`);
    else fail(`tool query: ${r.content}`);
  }
  {
    const r = await run({ sql: "select month, category, budget, spent, remaining from v_budget_status where month = '2026-08-01' and venture is null order by remaining limit 3" });
    if (!r.isError && /"remaining"/.test(r.content)) pass(`tool query (v_budget_status):\n${indent(r.content)}`);
    else fail(`tool query view: ${r.content}`);
  }
  {
    const r = await run({ sql: "drop table transactions" });
    if (r.isError && /read-only/.test(r.content)) pass(`tool refuses DDL: ${r.content}`);
    else fail(`tool DDL: ${r.content}`);
  }
  {
    const r = await run({ sql: "select 1; select 2" });
    if (r.isError && /one statement/.test(r.content)) pass(`tool refuses multi-statement: ${r.content}`);
    else fail(`tool multi: ${r.content}`);
  }
  {
    const r = await run({ sql: "select nope from transactions" });
    if (r.isError && /column|describe_table/i.test(r.content)) pass(`tool relays a column error usefully: ${r.content}`);
    else fail(`tool column error: ${r.content}`);
  }

  await pool.end();
  if (failures > 0) {
    console.error(`\n❌ ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\n✅ ledger check passed — EVE can read the ledger");
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `     ${l}`)
    .join("\n");
}

main().catch((e) => {
  console.error(`❌ ${errText(e)}`);
  process.exit(1);
});
