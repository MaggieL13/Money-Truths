import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqliteDb, type Db } from "../src/db.ts";
import { Core } from "../src/core/index.ts";
import { accountsOnly, demoHousehold } from "./fixture.ts";

export const TZ = "America/Sao_Paulo";
export const CURRENCY = "USD";
export const NOW = "2026-10-01T15:00:00.000Z";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Apply every migration in migrations/, in order. */
export async function migrate(db: Db): Promise<void> {
  const dir = join(ROOT, "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
}

export function coreFor(db: Db): Core {
  return new Core(db, { timezone: TZ, baseCurrency: CURRENCY, actor: "test", now: () => new Date(NOW) });
}

/**
 * A fresh in-memory ledger.
 *  - "demo": the fictional demo household (test/fixture.ts) as of its cutover
 *  - "accounts": owners and accounts only — no balances, obligations or issues,
 *    for isolated scenarios
 *  - "empty": schema only, not set up
 */
export async function fresh(mode: "demo" | "accounts" | "empty" = "accounts") {
  const db = await sqliteDb(":memory:");
  await migrate(db);
  if (mode === "demo") await db.batch(demoHousehold());
  if (mode === "accounts") await db.batch(accountsOnly());
  return { db, core: coreFor(db) };
}

/** Establish a starting balance with no history (no reconciliation issue). */
export async function given(core: Core, accountId: string, balance: number, at = "2026-10-01T08:00") {
  await core.setBalanceCheckpoint({ idempotency_key: `given-${accountId}-${at}`, account_id: accountId, as_of: at, reported_balance_minor: balance, source_kind: "user" });
}

export async function bal(core: Core, accountId: string): Promise<number> {
  return core.balanceOf(accountId);
}

export async function liquid(core: Core): Promise<number> {
  return (await core.snapshot()).me.liquid;
}

export async function count(core: Core, sql: string, params: (string | number)[] = []): Promise<number> {
  return (await core.db.get<{ n: number }>(sql, params))!.n;
}
