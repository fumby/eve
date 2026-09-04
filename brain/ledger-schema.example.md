<!-- TEMPLATE. The real brain/ledger-schema.md describes the operator's own finances
     and is not in this public mirror. Copy this file to brain/ledger-schema.md and
     replace it with your own schema. It is loaded into the stable prompt block as
     "Data you can query" and is hot-reloaded, so an edit lands on the next turn.
     Keep it accurate: re-verify it with describe_table when the schema changes. -->

## The ledger (query_ledger)

A read-only Postgres holding personal transactions. Reach it with the `query_ledger`
tool: `list_tables`, `describe_table`, and `query` (exactly one SELECT). The
connection is SELECT-only at the database role, and the SQL is checked by a pure
guard before it is sent — no semicolons, no DDL or DML, no side-effect functions.

### Tables

- **transactions** — one row per movement. `id`, `occurred_on` (date), `amount`
  (numeric, negative = money out), `currency`, `description`, `account_id`,
  `category_id`, `source` (`'seed'` for demo rows).
- **accounts** — `id`, `name`, `kind` (`checking` / `savings` / `card` / `cash`).
- **categories** — `id`, `name`, `parent_id` (nullable, one level of nesting).
- **budgets** — `id`, `category_id`, `month` (first day of the month), `amount`.

### Views

- **v_monthly_spend** — `month`, `category_id`, `category_name`, `total`.
- **v_budget_status** — `month`, `category_name`, `budgeted`, `spent`, `remaining`.

### Gotchas

- Amounts are signed. Spending is negative; `SUM(amount)` over a spend category is a
  negative number, so report `-SUM(amount)` or say "net".
- `occurred_on` is a date, not a timestamp. Compare with dates, never with `now()`.
- Prefer the views for anything month-shaped: they already handle the sign and the
  category join.
- Rows with `source = 'seed'` are demo data. Exclude them once real data exists.
