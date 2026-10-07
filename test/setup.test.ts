// First run: setup page logic, access keys, and creating people and accounts
// by chat. Also money formatting across currencies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Core } from "../src/core/index.ts";
import { fresh, bal, liquid, count, NOW } from "./helpers.ts";
import { initialize, issueKeys, keyScope, readSettings, checkSetupCode, sha256, SetupError } from "../src/setup.ts";
import { fmt, fmtCompact, currencyDigits } from "../src/money.ts";

const T = "2026-10-01T10:00";

test("S1. setup creates the owner and settings once", async () => {
  const { db } = await fresh("empty");
  assert.equal(await readSettings(db), null);
  await assert.rejects(initialize(db, { name: "Robin", currency: "usd", timezone: "Mars/Olympus", now: NOW }), SetupError);
  await assert.rejects(initialize(db, { name: "Robin", currency: "XYZ", timezone: "Europe/Madrid", now: NOW }), /currency code/);
  await assert.rejects(initialize(db, { name: " ", currency: "EUR", timezone: "Europe/Madrid", now: NOW }), /name/);
  await initialize(db, { name: "Robin", currency: "eur", timezone: "Europe/Madrid", now: NOW });
  assert.deepEqual(await readSettings(db), { timezone: "Europe/Madrid", currency: "EUR", ownerName: "Robin" });
  await assert.rejects(initialize(db, { name: "Eve", currency: "USD", timezone: "UTC", now: NOW }), /already set up/);
});

test("S2. keys are random, stored only as hashes, scoped, and rotate", async () => {
  const { db } = await fresh("empty");
  const first = await issueKeys(db, NOW);
  assert.match(first.write, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.write, first.read);
  assert.equal(await keyScope(db, first.write), "write");
  assert.equal(await keyScope(db, first.read), "read");
  assert.equal(await keyScope(db, "x".repeat(43)), null);
  assert.equal(await keyScope(db, "short"), null);
  const stored = await db.all<{ key_hash: string }>("SELECT key_hash FROM access_keys");
  assert.ok(!stored.some((r) => r.key_hash === first.write || r.key_hash === first.read), "plaintext keys are never stored");
  assert.ok(stored.map((r) => r.key_hash).includes(await sha256(first.write)));

  const second = await issueKeys(db, NOW);
  assert.equal(await keyScope(db, first.write), null, "old links stop working");
  assert.equal(await keyScope(db, first.read), null);
  assert.equal(await keyScope(db, second.write), "write");
});

test("S3. the setup code is required, compared exactly, and guessing is braked", async () => {
  const { db } = await fresh("empty");
  const t0 = Date.parse(NOW);
  assert.equal(await checkSetupCode(db, undefined, "anything", t0), "unconfigured");
  assert.equal(await checkSetupCode(db, "short", "short", t0), "unconfigured", "codes under 8 characters are refused");
  assert.equal(await checkSetupCode(db, "purple-otter-42", "purple-otter-42", t0), "ok");
  for (let i = 0; i < 5; i++) assert.equal(await checkSetupCode(db, "purple-otter-42", `guess-${i}`, t0 + i), "wrong");
  assert.equal(await checkSetupCode(db, "purple-otter-42", "purple-otter-42", t0 + 10), "locked", "even the right code waits out the lock");
  assert.equal(await checkSetupCode(db, "purple-otter-42", "purple-otter-42", t0 + 16 * 60 * 1000), "ok", "the lock lifts after 15 minutes");
  assert.equal(await checkSetupCode(db, "purple-otter-42", "nope", t0 + 16 * 60 * 1000 + 1), "wrong", "and the counter starts over");
});

async function setUp(currency = "USD") {
  const { db } = await fresh("empty");
  await initialize(db, { name: "Robin", currency, timezone: "America/Sao_Paulo", now: NOW });
  const core = new Core(db, { timezone: "America/Sao_Paulo", baseCurrency: currency, actor: "test", now: () => new Date(NOW) });
  return { db, core };
}

test("S4. a brand-new ledger is empty but works", async () => {
  const { core } = await setUp();
  const s = await core.snapshot();
  assert.equal(s.me.id, "me");
  assert.deepEqual([s.me.liquid, s.me.free, s.me.accounts.length], [0, 0, 0]);
  const { loadView } = await import("../src/core/report-data.ts");
  const { renderPage } = await import("../src/report.ts");
  const v = await loadView(core);
  assert.equal(v.ownerName, "Robin");
  const html = renderPage(v, [], { kind: "month", ym: "2026-10", filter: null }, new Map());
  assert.match(html, /Robin — actually yours/);
  assert.match(html, /No credit cards yet/);
  const { cardData, debtsData } = await import("../src/card.ts");
  assert.equal(cardData(v).liquid, 0);
  assert.deepEqual(debtsData(v).cards, []);
});

test("S5. not set up: tools explain what to do", async () => {
  const { db } = await fresh("empty");
  const core = new Core(db, { timezone: "UTC", baseCurrency: "USD", now: () => new Date(NOW) });
  await assert.rejects(core.snapshot(), /isn't set up yet/);
});

test("S6. accounts by chat: opening balances are checkpoints, never income", async () => {
  const { core } = await setUp();
  const r = await core.createAccount({ idempotency_key: "a1", name: "Chase Checking!", type: "bank", institution: "Chase", last4: "1234", balance_minor: 123_456, as_of: "2026-10-01T08:00" });
  const id = r.entity!.id;
  assert.equal(id, "asset_chase_checking");
  assert.match(r.summary, /\$1,234\.56/);
  assert.equal(await bal(core, id), 123_456);
  assert.equal(await liquid(core), 123_456);
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 0, "no invented income");
  assert.equal((await core.periodSummary({ month: "2026-10" })).income, 0);

  // Same name again gets its own id; replaying the same key does nothing.
  const again = await core.createAccount({ idempotency_key: "a2", name: "Chase checking", type: "bank" });
  assert.equal(again.entity!.id, "asset_chase_checking_2");
  assert.equal((await core.createAccount({ idempotency_key: "a1", name: "Chase Checking!", type: "bank", balance_minor: 123_456, as_of: "2026-10-01T08:00" })).replayed, true);
  assert.equal(await count(core, "SELECT count(*) n FROM accounts WHERE id LIKE 'asset_chase%'"), 2);

  // Later activity works like any account, and a new balance report reconciles normally.
  await core.recordExpense({ idempotency_key: "e", occurred_at: T, amount_minor: 3_456, currency: "USD", payment_account_id: id, category: "food", description: "Groceries" });
  assert.equal(await bal(core, id), 120_000);

  await assert.rejects(core.createAccount({ idempotency_key: "bad1", name: "X", type: "bank", last4: "1234567890" }), /last 4/);
  await assert.rejects(core.createAccount({ idempotency_key: "bad2", name: "X", type: "bank", currency: "dollars" }), /3-letter/);
  await assert.rejects(core.createAccount({ idempotency_key: "bad3", name: "X", type: "piggy" as never }), /type must be one of/);
});

test("S7. cards, loans and personal debts by chat", async () => {
  const { core } = await setUp();
  const visa = (await core.createAccount({ idempotency_key: "c", name: "Visa", type: "credit_card", institution: "Chase", balance_minor: 50_000, credit_limit_minor: 200_000 })).entity!.id;
  const car = (await core.createAccount({ idempotency_key: "l", name: "Car loan", type: "loan", installment_minor: 30_000, installments_paid: 4, installments_total: 18 })).entity!.id;
  const aunt = (await core.createAccount({ idempotency_key: "d", name: "Owe Aunt May", type: "personal_debt", balance_minor: 40_000 })).entity!.id;
  assert.equal(await liquid(core), 0, "debts never count as money you have");

  const { loadView } = await import("../src/core/report-data.ts");
  const v = await loadView(core);
  const card = v.cards.find((c) => c.id === visa)!;
  assert.deepEqual([card.debt, card.limit, card.available, card.availableEstimated], [50_000, 200_000, 150_000, false]);
  const loan = v.loans.find((l) => l.id === car)!;
  assert.deepEqual([loan.balance, loan.installment, loan.paid, loan.total], [null, 30_000, 4, 18], "unknown balance stays unknown");
  assert.equal(v.loans.find((l) => l.id === aunt)!.balance, 40_000);
  const liabs = (await core.snapshot()).liabilities;
  assert.equal(liabs.find((l) => l.id === car)!.balance_known, false);

  // The balance arrives later as a checkpoint: no reconciliation issue for a first balance.
  const cp = await core.setBalanceCheckpoint({ idempotency_key: "cp", account_id: car, as_of: T, reported_balance_minor: 480_000, source_kind: "statement" });
  assert.equal(cp.reconciliation_issues.length, 0);
  assert.equal((await core.snapshot()).liabilities.find((l) => l.id === car)!.balance_known, true);

  await assert.rejects(core.createAccount({ idempotency_key: "neg", name: "Bad", type: "loan", balance_minor: -5 }), /positive amount owed/);
  await assert.rejects(core.createAccount({ idempotency_key: "lim", name: "Bad", type: "bank", credit_limit_minor: 5 }), /only for credit cards/);
});

test("S8. people: shared purchases, money owed, and money held for them", async () => {
  const { core } = await setUp();
  await core.createAccount({ idempotency_key: "a", name: "Checking", type: "bank", balance_minor: 100_000, as_of: "2026-10-01T08:00" });
  const p = await core.createPerson({ idempotency_key: "p", name: "Jordan" });
  assert.equal(p.entity!.id, "jordan");
  await assert.rejects(core.createPerson({ idempotency_key: "p2", name: "jordan" }), /already exists/);

  // Money Jordan already owed before the ledger started.
  const owed = await core.createAccount({ idempotency_key: "o", name: "Jordan owes me", type: "owed_to_me", owner_id: "jordan", balance_minor: 2_500, as_of: "2026-10-01T08:00" });
  assert.equal(owed.entity!.id, "recv_jordan_USD");
  await assert.rejects(core.createAccount({ idempotency_key: "o2", name: "Again", type: "owed_to_me", owner_id: "jordan" }), /already track/);
  await assert.rejects(core.createAccount({ idempotency_key: "o3", name: "Nobody", type: "owed_to_me" }), /needs owner_id/);

  // A shared dinner adds to it; paying back settles it — never income.
  await core.recordExpense({ idempotency_key: "dinner", occurred_at: T, amount_minor: 6_000, currency: "USD", payment_account_id: "asset_checking", category: "food", description: "Dinner", reimbursable_minor: 3_000, reimbursable_from_owner_id: "jordan" });
  assert.equal(await bal(core, "recv_jordan_USD"), 5_500);
  await core.recordReimbursementReceived({ idempotency_key: "back", occurred_at: "2026-10-01T11:00", receivable_id: "jordan", destination_account_id: "asset_checking", amount_minor: 5_500 });
  assert.equal(await bal(core, "recv_jordan_USD"), 0);
  assert.equal((await core.periodSummary({ month: "2026-10" })).income, 0);

  // An account holding Jordan's money is visible but never counted as yours.
  const before = await liquid(core);
  await core.createAccount({ idempotency_key: "j", name: "Jordan's rent jar", type: "cash", owner_id: "jordan", balance_minor: 80_000 });
  assert.equal(await liquid(core), before);
  assert.ok((await core.snapshot()).others.some((o) => o.name === "Jordan's rent jar"));
  await assert.rejects(core.createAccount({ idempotency_key: "jd", name: "Jordan's card", type: "credit_card", owner_id: "jordan" }), /always yours/);
  await assert.rejects(core.createAccount({ idempotency_key: "x", name: "Ghost's cash", type: "cash", owner_id: "ghost" }), /Unknown person/);
});

test("S9. an opening balance can't be dated into a closed month", async () => {
  const { core } = await setUp();
  await core.closeMonth({ idempotency_key: "close", month: "2026-09" });
  await assert.rejects(core.createAccount({ idempotency_key: "old", name: "Old bank", type: "bank", balance_minor: 1, as_of: "2026-09-15" }), /closed/);
  await core.createAccount({ idempotency_key: "new", name: "New bank", type: "bank", balance_minor: 1 });
});

test("S10. money formats by each currency's own decimals", () => {
  assert.equal(currencyDigits("USD"), 2);
  assert.equal(currencyDigits("JPY"), 0);
  assert.equal(currencyDigits("KWD"), 3);
  assert.equal(fmt(123_456, "USD"), "$1,234.56");
  assert.equal(fmt(-5, "USD"), "−$0.05");
  assert.equal(fmt(1_234, "JPY"), "¥1,234");
  assert.equal(fmt(1_000, "EUR"), "€10.00");
  assert.equal(fmt(2_500_000, "PYG"), "₲2,500,000");
  assert.equal(fmtCompact(250_000_00, "USD"), "$250k");
  assert.equal(fmtCompact(2_700_000, "JPY"), "¥2.7M");
});

test("S11. a ledger in a zero-decimal currency reports in that currency", async () => {
  const { core } = await setUp("JPY");
  await core.createAccount({ idempotency_key: "a", name: "Bank", type: "bank", balance_minor: 150_000 });
  await core.createAccount({ idempotency_key: "b", name: "Dollar account", type: "bank", currency: "USD", balance_minor: 12_345 });
  const { loadView } = await import("../src/core/report-data.ts");
  const { cardText, cardData } = await import("../src/card.ts");
  const { renderPage } = await import("../src/report.ts");
  const v = await loadView(core);
  assert.equal(v.currency, "JPY");
  assert.match(cardText(cardData(v)), /Liquid ¥150,000/);
  const html = renderPage(v, [], { kind: "month", ym: "2026-10", filter: null }, new Map());
  assert.match(html, /¥150,000/);
  assert.match(html, /\$123\.45/, "the dollar account shows separately in dollars");
});

test("S12. the code has no built-in timezone or currency", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { ROOT } = await import("./helpers.ts");
  const files = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]));
  for (const f of files("src")) {
    const text = readFileSync(join(ROOT, f), "utf8");
    // Placeholders and examples on the setup page are fine; logic must read settings.
    if (f.endsWith("setup.ts")) continue;
    assert.ok(!/timeZone: "[A-Z][a-z]+\//.test(text), `${f} hardcodes a timezone`);
    assert.ok(!/[₲€£¥]\$\{|"[₲€£¥]"/.test(text), `${f} hardcodes a currency symbol`);
  }
});

test("S13. settings: rename and re-zone any time; switch currency only before anything uses it", async () => {
  const { db, core } = await setUp("USD");
  const r = await core.updateSettings({ idempotency_key: "s1", currency: "pyg", name: "Rob", timezone: "America/Asuncion" });
  assert.match(r.summary, /USD → PYG/);
  assert.deepEqual(await readSettings(db), { timezone: "America/Asuncion", currency: "PYG", ownerName: "Rob" });
  await assert.rejects(core.updateSettings({ idempotency_key: "s2", timezone: "Nowhere/Land" }), /isn't a timezone/);
  await assert.rejects(core.updateSettings({ idempotency_key: "s3" }), /Pass name/);

  const pyg = new Core(db, { timezone: "America/Asuncion", baseCurrency: "PYG", now: () => new Date(NOW) });
  await pyg.createAccount({ idempotency_key: "a", name: "Bank", type: "bank", balance_minor: 500_000 });
  assert.equal((await pyg.snapshot()).me.liquid, 500_000);
  await assert.rejects(pyg.updateSettings({ idempotency_key: "s4", currency: "USD" }), /never converts/);
  assert.equal((await readSettings(db))!.currency, "PYG");
});
