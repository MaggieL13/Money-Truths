// Disaster-recovery drill: load a JSON export (GET /<key>/api/export) into an
// empty in-memory database and print the resulting snapshot. Never touches a
// live database.
//
//   node scripts/restore-dry-run.ts backups/money-truths-2026-10-01.json
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sqliteDb } from "../src/db.ts";
import { Core, money } from "../src/core/index.ts";
import { restoreInto } from "../src/core/backup.ts";
import { readSettings } from "../src/setup.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/restore-dry-run.ts <export.json>");
  process.exit(1);
}
const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const db = await sqliteDb(":memory:");
for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
  await db.exec(readFileSync(join(migrations, f), "utf8"));
}
const counts = await restoreInto(db, JSON.parse(readFileSync(file, "utf8")));
const settings = await readSettings(db);
if (!settings) throw new Error("The export has no owner or settings — was it taken before setup?");
const snap = await new Core(db, { timezone: settings.timezone, baseCurrency: settings.currency, actor: "restore-dry-run" }).snapshot();
console.log("Restored rows:", counts);
console.log(`${settings.ownerName}: liquid ${money(snap.me.liquid, snap.currency)} · free ${money(snap.me.free, snap.currency)} · ${snap.open_obligations.length} open obligations · ${snap.reconciliation_issues.length} open issues`);
console.log("Dry run only — nothing was written anywhere.");
