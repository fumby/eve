// Umberto's money ledger — the write half. query_ledger reads; this logs a
// single expense/income/transfer by voice. It uses a SEPARATE connection
// string (SUPABASE_LEDGER_WRITE_URL) with a role that has INSERT on
// transactions but still no UPDATE/DELETE — money is append-only by design.
//
// The INSERT is parameterised (no string concatenation into SQL), the columns
// are validated against the schema in brain/ledger-schema.md, and the whole
// thing sits behind the Tier 6 gate because it writes money data.
import pg from "pg";
import { z } from "zod";
import type { EveTool } from "../core/registry.js";
import { requireKey } from "../core/config.js";
import { audit } from "../core/audit.js";

const { Pool } = pg;

let writePool: pg.Pool | null = null;

function getWritePool(): pg.Pool {
  if (writePool) return writePool;
  const connectionString = requireKey("SUPABASE_LEDGER_WRITE_URL");
  const p = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 8_000,
    application_name: "eve-ledger-write",
    allowExitOnIdle: true,
  });
  p.on("error", (err) => audit("ledger_write_pool_error", { error: err.message }));
  writePool = p;
  return p;
}

// Resolve a category name to its id. Case-insensitive, partial match — so
// "groceries" finds "Groceries", and "trasporti" finds "Transport".
async function resolveCategory(pool: pg.Pool, name: string): Promise<number | null> {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM categories WHERE lower(name) = lower($1) LIMIT 1`,
    [name.trim()],
  );
  return res.rows[0]?.id ?? null;
}

// Resolve an account name to its id the same way.
async function resolveAccount(pool: pg.Pool, name: string): Promise<number | null> {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM accounts WHERE lower(name) = lower($1) LIMIT 1`,
    [name.trim()],
  );
  return res.rows[0]?.id ?? null;
}

// Resolve a venture name to its id (null = personal).
async function resolveVenture(pool: pg.Pool, name: string | null): Promise<number | null> {
  if (!name || !name.trim()) return null;
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM ventures WHERE lower(name) = lower($1) LIMIT 1`,
    [name.trim()],
  );
  return res.rows[0]?.id ?? null;
}

export const ledgerWriteTools: EveTool[] = [
  {
    name: "log_expense",
    description:
      "Log a single expense, income, or transfer into Umberto's money ledger (Supabase Postgres). Use it when he says 'log €12.40 for lunch', 'I spent €30 on groceries', 'I got €500 scholarship', or 'I transferred €200 to Revolut'. Requires his explicit confirmation — the gate shows the amount, category, account, and note. The ledger is append-only: you can INSERT, never UPDATE or DELETE. If a category or account name doesn't match, it defaults to the first matching one or errors — list them with query_ledger first if unsure.",
    schema: z.object({
      amount: z.number().positive().describe("The amount in EUR, always positive. The 'kind' field says direction."),
      kind: z
        .enum(["expense", "income", "transfer"])
        .default("expense")
        .describe("expense = money out, income = money in, transfer = between his own accounts."),
      category: z
        .string()
        .optional()
        .describe("Category name: groceries, rent, utilities, eating out, transport, books & courses, phone & subscriptions, health, fun, moving, software & tools, domains & hosting (expense); scholarship, tutoring, family support (income). Fuzzy-matched."),
      account: z
        .string()
        .optional()
        .describe("Account name: Intesa, Cash, Revolut. Fuzzy-matched. Defaults to the first account."),
      merchant: z.string().optional().describe("Who he paid or who paid him, e.g. 'Esselunga' or 'Università'."),
      note: z.string().optional().describe("A free-text note about the transaction."),
      venture: z
        .string()
        .optional()
        .describe("Venture name if this is a venture cost/income. Omit for personal (null)."),
      occurred_on: z
        .string()
        .optional()
        .describe("Date the transaction occurred, ISO format 'YYYY-MM-DD'. Defaults to today."),
    }),
    needsConfirmation: true,
    confirmIntent: (input) => {
      const amount = Number(input.amount);
      const kind = String(input.kind ?? "expense");
      const category = input.category ? String(input.category) : "(none)";
      const merchant = input.merchant ? String(input.merchant) : "";
      const account = input.account ? String(input.account) : "(default)";
      const venture = input.venture ? ` [venture: ${String(input.venture)}]` : "";
      return {
        human: `Log a €${amount.toFixed(2)} ${kind} in the ledger?\n\n  category: ${category}\n  account: ${account}\n  merchant: ${merchant}\n  note: ${input.note ? String(input.note) : "(none)"}${venture}`,
        log: `log_expense €${amount.toFixed(2)} ${kind} ${category} (details withheld)`,
      };
    },
    run: async (input) => {
      const amount = Number(input.amount);
      const kind = String(input.kind ?? "expense");
      const today = new Date().toISOString().slice(0, 10);
      const occurredOn = input.occurred_on ? String(input.occurred_on) : today;
      const pool = getWritePool();
      // Resolve the FKs — these are the only columns that need a lookup.
      const categoryId = input.category ? await resolveCategory(pool, String(input.category)) : null;
      const accountId = input.account ? await resolveAccount(pool, String(input.account)) : null;
      const ventureId = input.venture ? await resolveVenture(pool, String(input.venture)) : null;
      // If no account was given, use the first one.
      const finalAccountId = accountId ?? (await pool.query<{ id: number }>("SELECT id FROM accounts ORDER BY id LIMIT 1")).rows[0]?.id ?? null;
      if (!finalAccountId) throw new Error("no accounts found in the ledger — set one up in Supabase first");

      const res = await pool.query(
        `INSERT INTO transactions (occurred_on, kind, amount, account_id, category_id, venture_id, merchant, note, currency, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'EUR', 'voice')
         RETURNING id, occurred_on, kind, amount, merchant, note`,
        [
          occurredOn,
          kind,
          amount.toFixed(2),
          finalAccountId,
          categoryId,
          ventureId,
          input.merchant ? String(input.merchant) : null,
          input.note ? String(input.note) : null,
        ],
      );
      const row = res.rows[0] as { id: number; occurred_on: string; kind: string; amount: string; merchant: string | null; note: string | null } | undefined;
      if (!row) throw new Error("the insert returned no row — the write role may not have INSERT permission on transactions");
      audit("ledger_write", { kind, amount, category: input.category ?? null, id: row.id });
      const dir = kind === "expense" ? "spent" : kind === "income" ? "received" : "transferred";
      return `Logged: €${Number(row.amount).toFixed(2)} ${dir} on ${row.occurred_on}${row.merchant ? ` (${row.merchant})` : ""}${row.note ? ` — ${row.note}` : ""}. ID ${row.id}.`;
    },
  },
];
