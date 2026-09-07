-- EVE's ledger write role — run this ONCE in the Supabase SQL editor
-- (Dashboard → SQL Editor → New query → paste → Run), then add the
-- connection string to .env as SUPABASE_LEDGER_WRITE_URL.
--
-- The principle: EVE can INSERT a transaction, never UPDATE or DELETE one.
-- Money is append-only — a mistake creates a row Umberto deletes by hand,
-- not a silent edit of history.
--
-- Password: change 'pick-something-alphanumeric' FIRST — alphanumeric only,
-- so nothing needs percent-encoding in the DSN. Then build the DSN as:
--   postgresql://trillion_writer.<project-ref>:<password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres
-- (same pooler host/port as the read DSN in .env — copy it and change only
-- the user and password).

create role trillion_writer login password 'pick-something-alphanumeric';

-- Writes, and only writes: INSERT on transactions. No UPDATE, no DELETE,
-- no reads of anything the analytics role doesn't already cover. The GRANT
-- is the wall — Postgres denies everything not granted here.
grant insert on table public.transactions to role trillion_writer;
-- SELECT on the lookup tables so log_expense can resolve category/account/
-- venture names to ids before inserting.
grant select on table public.categories to role trillion_writer;
grant select on table public.accounts to role trillion_writer;
grant select on table public.ventures to role trillion_writer;

-- Statement timeout so a runaway tool call can't hold a pooler slot.
alter role trillion_writer set statement_timeout = '5s';

-- Keep the pooler slot count small; EVE's write pool is max:1.
alter role trillion_writer connection limit 2;

-- Sanity check: this MUST return false (no delete rights on transactions):
-- select has_table_privilege('trillion_writer', 'public.transactions', 'DELETE');
-- And this MUST return true (insert is the only write):
-- select has_table_privilege('trillion_writer', 'public.transactions', 'INSERT');
