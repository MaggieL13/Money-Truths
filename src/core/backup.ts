import type { Db, Stmt } from "../db.ts";

// JSON export / restore. Export is every table, verbatim. Restore
// writes into an EMPTY database only — it never overwrites a live one.

/** Parent tables first so foreign keys hold on restore. */
export const TABLES = [
  "schema_meta",
  "owners",
  "accounts",
  "balance_checkpoints",
  "transactions",
  "postings",
  "transaction_splits",
  "obligations",
  "obligation_payments",
  "obligation_status_history",
  "recurring_rules",
  "expected_inflows",
  "reservations",
  "reconciliation_issues",
  "card_snapshots",
  "entity_fields",
  "notes",
  "audit_log",
  "idempotency_keys",
  "month_closures",
  "month_close_exports",
] as const;

export interface LedgerExport {
  format: "money-truths-export";
  version: 1;
  exported_at: string;
  tables: Record<string, Record<string, unknown>[]>;
}

export async function exportAll(db: Db, now: string): Promise<LedgerExport> {
  const tables: LedgerExport["tables"] = {};
  for (const t of TABLES) tables[t] = await db.all(`SELECT * FROM ${t}`);
  return { format: "money-truths-export", version: 1, exported_at: now, tables };
}

export async function restoreInto(db: Db, dump: LedgerExport): Promise<Record<string, number>> {
  if (dump?.format !== "money-truths-export") throw new Error("Not a Money Truths export.");
  const existing = await db.get<{ n: number }>("SELECT count(*) AS n FROM accounts");
  if ((existing?.n ?? 0) > 0) throw new Error("Refusing to restore into a database that already has data. Restore into an empty database.");
  // transactions.reversed_by points at later rows; insert without it, then patch.
  const stmts: Stmt[] = [];
  const counts: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = dump.tables[t] ?? [];
    counts[t] = rows.length;
    for (const row of rows) {
      const r = t === "transactions" ? { ...row, reversed_by: null } : row;
      const cols = Object.keys(r);
      stmts.push({ sql: `INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => r[c] as string | number | null) });
    }
  }
  for (const row of dump.tables.transactions ?? []) {
    if (row.reversed_by) stmts.push({ sql: "UPDATE transactions SET reversed_by = ? WHERE id = ?", params: [row.reversed_by as string, row.id as string] });
  }
  await db.batch(stmts);
  return counts;
}
