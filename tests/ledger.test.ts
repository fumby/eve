// query_ledger's pure half: the SQL guard must let honest SELECTs through and
// stop everything else with a sentence — no database involved. The last test
// drives the real tool through the Registry with no env, proving the guard
// runs before any connection is even attempted.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ROWS,
  MAX_OUTPUT_CHARS,
  tokenize,
  validateReadOnlySql,
  wrapWithLimit,
  formatResult,
  jsonSafeCell,
  sanitizeDsn,
} from "../src/tools/ledger-sql.js";
import { ledgerTools } from "../src/tools/ledger.js";
import { Registry } from "../src/core/registry.js";

const ok = (sql: string) => assert.doesNotThrow(() => validateReadOnlySql(sql), sql);
const bad = (sql: string, re: RegExp) => assert.throws(() => validateReadOnlySql(sql), re, sql);

test("validator: honest SELECTs and CTEs pass, in any dress", () => {
  ok("select 1");
  ok("SELECT sum(amount) FROM transactions WHERE kind = 'expense'");
  ok("with m as (select * from v_monthly_spend) select * from m order by month desc");
  ok("  select 1;  ");
  ok("select 1;;\n");
  ok("```sql\nselect count(*) from budgets\n```");
  ok("select 1 -- trailing comment");
  ok("select /* inline */ 1");
  ok("select 'a;b' as s, 'it''s' as t");
  ok("select E'x\\'y;' as s");
  ok("select $$;drop$$ as s, $tag$ into $tag$ as t");
  ok('select "drop" from "into"'); // quoted identifiers are names, not keywords
  ok("select date_trunc('month', occurred_on) from transactions"); // 'month' is a literal
  ok("select * from accounts limit 5 offset 2");
  ok("select 1 for_update"); // an identifier, not a lock clause
});

test("validator: writes, DDL and admin are refused with a reason", () => {
  bad("insert into t values (1)", /read-only/);
  bad("update t set a = 1", /read-only/);
  bad("delete from t", /read-only/);
  bad("drop table transactions", /read-only/);
  bad("truncate transactions", /read-only/);
  bad("create table x (a int)", /read-only/);
  bad("grant select on t to public", /read-only/);
  bad("select 1 into new_table", /INTO/);
  bad("select set_config('a','b',false)", /set_config|SET/);
  bad("select * from t for update", /read-only|lock/); // 'UPDATE' keyword wall fires first
  bad("select * from t for no key update", /read-only|lock/);
  bad("select * from t for share", /lock/);
  bad("select * from t for key share", /lock/);
  bad("select pg_sleep(10)", /pg_sleep/);
  bad("select pg_terminate_backend(1)", /pg_terminate_backend/);
  bad("select nextval('s')", /nextval/);
  bad("select pg_advisory_lock(1)", /advisory|lock/i);
  bad("explain analyze select 1", /only SELECT/);
  bad("do $$ begin end $$", /only SELECT|read-only/);
  bad("copy t to '/tmp/x'", /only SELECT/);
});

test("validator: multi-statement and parameter tricks are refused", () => {
  bad("select 1; select 2", /one statement/);
  bad("select 1; drop table t", /one statement/);
  bad("select 1;\n-- comment\ndelete from t", /one statement|read-only/);
  bad("select 1 /* ; */ ; select 2", /one statement/);
  bad("select $1", /parameters/);
  bad("", /no SQL/);
  bad("   ", /no SQL/);
  bad("select 'unterminated", /unterminated/);
  bad("select /* open", /unterminated/);
  bad('select "open', /unterminated/);
  bad("select $$open", /unterminated/);
  bad("select " + "1 + ".repeat(2000) + "1", /characters/);
});

test("validator returns runnable SQL: comments gone, literals kept, trailing ; gone", () => {
  assert.equal(validateReadOnlySql("select 'a;b' -- note\n;"), "select 'a;b'");
  assert.equal(validateReadOnlySql("select /* c */ 1"), "select   1");
  assert.equal(validateReadOnlySql("```sql\nselect 2;\n```"), "select 2");
});

test("tokenize blanks literals in the code view and keeps them in the sql view", () => {
  const v = tokenize("select 'x;y', \"q\", $$z$$ -- c");
  assert.equal(v.code.trim(), `select '?', "?", '?'`);
  assert.equal(v.sql.trim(), `select 'x;y', "q", $$z$$`);
});

test("wrapWithLimit pads with newlines so a trailing comment can't eat the paren", () => {
  const w = wrapWithLimit("select 1");
  assert.match(w, /^SELECT \* FROM \(\nselect 1\n\) AS _q LIMIT \$1$/);
});

test("formatResult: caps rows, says so, and never slices JSON mid-way", () => {
  assert.equal(formatResult({ fields: ["a"], rows: [] }), "The query ran fine but returned no rows.");

  const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => [i]);
  const out = formatResult({ fields: ["n"], rows });
  const [json, note] = out.split("\n");
  const parsed = JSON.parse(json!) as { rowCount: number; truncated: boolean; rows: unknown[][] };
  assert.equal(parsed.rowCount, MAX_ROWS);
  assert.equal(parsed.truncated, true);
  assert.match(note!, /there were more/);

  const fat = Array.from({ length: 150 }, (_, i) => [i, "x".repeat(400)]);
  const big = formatResult({ fields: ["n", "s"], rows: fat });
  const bigJson = big.split("\n")[0]!;
  assert.ok(bigJson.length <= MAX_OUTPUT_CHARS, `json ${bigJson.length} > ${MAX_OUTPUT_CHARS}`);
  const p2 = JSON.parse(bigJson) as { rowCount: number; truncated: boolean };
  assert.ok(p2.rowCount < 150);
  assert.equal(p2.truncated, true);
  assert.match(big, /rows fit/);

  const small = formatResult({ fields: ["a", "a"], rows: [[1, 2]] });
  assert.deepEqual(JSON.parse(small), { columns: ["a", "a"], rowCount: 1, truncated: false, rows: [[1, 2]] });
});

test("jsonSafeCell: bigint, Date, bytea, long strings, nested", () => {
  assert.equal(jsonSafeCell(10n), "10");
  assert.equal(jsonSafeCell(new Date("2026-07-01T00:00:00Z")), "2026-07-01T00:00:00.000Z");
  assert.equal(jsonSafeCell(Buffer.from([1, 2, 3])), "<bytea 3 bytes>");
  assert.equal((jsonSafeCell("y".repeat(600)) as string).length, 501);
  assert.deepEqual(jsonSafeCell({ a: [1n, null] }), { a: ["1", null] });
  assert.equal(jsonSafeCell(undefined), null);
});

test("sanitizeDsn: strips ssl params, refuses superuser and IPv6-only host", () => {
  const good = "postgresql://trillion_analytics.abc123:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require&x=1";
  const r = sanitizeDsn(good);
  assert.equal(r.summary.user, "trillion_analytics.abc123");
  assert.equal(r.summary.host, "aws-0-eu-west-1.pooler.supabase.com");
  assert.equal(r.summary.port, "6543");
  assert.equal(r.summary.database, "postgres");
  assert.doesNotMatch(r.connectionString, /sslmode/);
  assert.match(r.connectionString, /x=1/);

  assert.throws(() => sanitizeDsn("postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), /superuser/);
  assert.throws(() => sanitizeDsn("postgresql://postgres:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), /superuser/);
  assert.throws(() => sanitizeDsn("postgresql://trillion_analytics.abc:pw@db.abc.supabase.co:5432/postgres"), /IPv6-only/);
  assert.throws(() => sanitizeDsn("postgresql://trillion_analytics.abc:pw@aws-0-eu-west-1.pooler.supabase.com:9999/postgres"), /6543/);
  assert.throws(() => sanitizeDsn("postgresql://someone.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), /expected trillion_analytics/);
  assert.throws(() => sanitizeDsn("mysql://trillion_analytics.abc:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres"), /postgresql:\/\//);
  assert.throws(() => sanitizeDsn("not a url"), /valid postgresql/);
});

test("query_ledger through the Registry with no env: guard first, then a clear missing-key error", async () => {
  const saved = process.env.SUPABASE_LEDGER_URL;
  delete process.env.SUPABASE_LEDGER_URL;
  try {
    const r = new Registry();
    for (const t of ledgerTools) r.register(t);
    const defs = r.definitions() as Array<{ name: string; input_schema: { properties: Record<string, unknown> } }>;
    assert.equal(defs[0]!.name, "query_ledger");
    assert.ok("sql" in defs[0]!.input_schema.properties);

    const refused = await r.execute("query_ledger", { sql: "drop table transactions" });
    assert.equal(refused.isError, true);
    assert.match(refused.content, /read-only/);

    const multi = await r.execute("query_ledger", { sql: "select 1; select 2" });
    assert.equal(multi.isError, true);
    assert.match(multi.content, /one statement/);

    const noKey = await r.execute("query_ledger", { sql: "select 1" });
    assert.equal(noKey.isError, true);
    assert.match(noKey.content, /Missing SUPABASE_LEDGER_URL/);

    const noTable = await r.execute("query_ledger", { action: "describe_table" });
    assert.equal(noTable.isError, true);
    assert.match(noTable.content, /needs a table name/);

    const badAction = await r.execute("query_ledger", { action: "drop_everything" });
    assert.equal(badAction.isError, true);
    assert.match(badAction.content, /Invalid input/);
  } finally {
    if (saved) process.env.SUPABASE_LEDGER_URL = saved;
  }
});
