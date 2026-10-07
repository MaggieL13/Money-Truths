// Acceptance scenarios (1–25), then regression tests for bugs found in review
// (R…), housekeeping (E…), in-chat cards (C…). Data: test/fixture.ts, a
// fictional household in USD (amounts in cents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { LedgerError } from "../src/core/index.ts";
import { fresh, given, bal, liquid, count, ROOT } from "./helpers.ts";
import { BALANCES, LIQUID, RESERVED } from "./fixture.ts";

const T = "2026-10-01T10:00";

test("1. simple income, idempotent retry", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 1_000_000);
  const before = await liquid(core);
  const args = { idempotency_key: "salary-1", occurred_at: T, amount_minor: 350_000, currency: "USD", destination_account_id: "asset_checking", source: "Salary", category: "salary" };
  const r = await core.recordIncome(args);
  assert.equal(await bal(core, "asset_checking"), 1_350_000);
  assert.equal((await liquid(core)) - before, 350_000);
  assert.match(r.summary, /Checking \$10,000\.00 → \$13,500\.00/);
  const again = await core.recordIncome(args);
  assert.equal(again.replayed, true);
  assert.equal(await bal(core, "asset_checking"), 1_350_000);
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 1);
});

test("2. transfer between your own accounts", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 500_000);
  await given(core, "asset_cash", 100_000);
  const before = await liquid(core);
  await core.recordTransfer({ idempotency_key: "t2", occurred_at: T, amount_minor: 100_000, currency: "USD", from_account_id: "asset_checking", to_account_id: "asset_cash" });
  assert.equal(await bal(core, "asset_checking"), 400_000);
  assert.equal(await bal(core, "asset_cash"), 200_000);
  assert.equal(await liquid(core), before);
  const s = await core.periodSummary({ month: "2026-10" });
  assert.equal(s.economic_spending, 0);
  assert.equal(s.cash_in + s.cash_out, 0, "internal transfers are not cash flow");
});

test("3. cash swap with a person", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 500_000);
  await given(core, "asset_alex_shop", 0);
  const before = await liquid(core);
  await core.recordCashSwap({ idempotency_key: "swap", occurred_at: T, amount_minor: 12_000, from_account_id: "asset_checking", to_account_id: "asset_cash", counterparty_owner_id: "alex" });
  assert.equal(await liquid(core), before);
  assert.equal((await core.periodSummary({ month: "2026-10" })).economic_spending, 0);
  // Moving your money straight into someone else's account is not a "transfer".
  await assert.rejects(
    core.recordTransfer({ idempotency_key: "bad", occurred_at: T, amount_minor: 1, currency: "USD", from_account_id: "asset_checking", to_account_id: "asset_alex_shop" }),
    LedgerError,
  );
});

test("4. card purchase", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 500_000);
  await given(core, "liab_mastercard", 0);
  const before = await liquid(core);
  await core.recordCardPurchase({ idempotency_key: "cp", occurred_at: T, card_account_id: "liab_mastercard", amount_minor: 8_950, category: "clothing", description: "Clothes" });
  assert.equal(await bal(core, "liab_mastercard"), 8_950);
  assert.equal((await core.periodSummary({ month: "2026-10" })).economic_spending, 8_950);
  assert.equal((await core.periodSummary({ month: "2026-10" })).card_purchases, 8_950);
  assert.equal(await liquid(core), before);
});

test("5. card payment is not new spending", async () => {
  const { core } = await fresh();
  await given(core, "asset_savings", 200_000);
  await given(core, "liab_visa", 1_000_000);
  await core.recordCardPayment({ idempotency_key: "pay", occurred_at: T, card_account_id: "liab_visa", funding_account_id: "asset_savings", amount_minor: 50_000 });
  assert.equal(await bal(core, "asset_savings"), 150_000);
  assert.equal(await bal(core, "liab_visa"), 950_000);
  const s = await core.periodSummary({ month: "2026-10" });
  assert.equal(s.economic_spending, 0);
  assert.equal(s.debt_payments, 50_000);
});

test("6. intended payment is not payment", async () => {
  const { core } = await fresh("demo");
  const r = await core.recordTransfer({ idempotency_key: "visa-intent", occurred_at: T, amount_minor: 38_000, currency: "USD", from_account_id: "asset_checking", to_account_id: "asset_bills", notes: "for the Visa" });
  assert.equal((await core.obligation("obl_visa_2026_10")).status, "pending");
  assert.ok(r.warnings.some((w) => /Visa/.test(w) && /stays unpaid/.test(w)));
  await core.markObligationPaid({ idempotency_key: "amex-paid", obligation_id: "obl_visa_2026_10", paid_at: "2026-10-02T09:00", funding_account_id: "asset_bills" });
  assert.equal((await core.obligation("obl_visa_2026_10")).status, "paid");
});

test("7. reimbursable purchase and reimbursement", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 500_000);
  const start = await liquid(core);
  await core.recordExpense({ idempotency_key: "groc", occurred_at: T, amount_minor: 100_000, currency: "USD", payment_account_id: "asset_checking", category: "groceries", description: "Groceries", reimbursable_minor: 40_000, reimbursable_from_owner_id: "alex" });
  assert.equal(start - (await liquid(core)), 100_000);
  let s = await core.periodSummary({ month: "2026-10" });
  assert.equal(s.economic_spending, 60_000);
  assert.equal(await bal(core, "recv_alex_USD"), 40_000);
  await core.recordReimbursementReceived({ idempotency_key: "alex-back", occurred_at: "2026-10-01T11:30", receivable_id: "recv_alex_USD", destination_account_id: "asset_checking", amount_minor: 40_000 });
  assert.equal(start - (await liquid(core)), 60_000);
  assert.equal(await bal(core, "recv_alex_USD"), 0);
  s = await core.periodSummary({ month: "2026-10" });
  assert.equal(s.income, 0, "a reimbursement is never income");
  assert.equal(s.reimbursements_received, 40_000);
});

test("8. fresh snapshot conflict", async () => {
  const { core } = await fresh();
  await given(core, "asset_cash", 4_800, "2026-09-29T12:00");
  const r = await core.setBalanceCheckpoint({ idempotency_key: "cash-count", account_id: "asset_cash", as_of: T, reported_balance_minor: 2_000, source_kind: "user" });
  assert.equal(await bal(core, "asset_cash"), 2_000);
  assert.equal(r.reconciliation_issues.length, 1);
  assert.equal((r.reconciliation_issues[0] as { difference_minor: number }).difference_minor, -2_800);
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 0, "no phantom expense");
});

test("9. expected income changes nothing", async () => {
  const { core } = await fresh("demo");
  const before = await core.snapshot();
  await core.addExpectedInflow({ idempotency_key: "bonus", source: "Year-end bonus", amount_minor: 300_000, currency: "USD", status: "confirmed_arrangement" });
  const after = await core.snapshot();
  assert.equal(after.me.liquid, before.me.liquid);
  assert.equal(after.me.free, before.me.free);
});

test("10. someone else's money visible but excluded", async () => {
  const { core } = await fresh("demo");
  const s = await core.snapshot();
  const alex = s.others.find((a) => a.id === "asset_alex_shop");
  assert.equal(alex?.balance_minor, BALANCES.asset_alex_shop);
  assert.equal(s.me.liquid, LIQUID);
  assert.ok(!s.me.accounts.some((a) => a.id === "asset_alex_shop"));
});

test("11. reservation lowers free money, not the bank", async () => {
  const { core } = await fresh();
  await given(core, "asset_bills", 42_000);
  const before = await core.snapshot();
  await core.reserveFunds({ idempotency_key: "res", label: "Amex minimum", amount_minor: 42_000, currency: "USD", account_id: "asset_bills" });
  const after = await core.snapshot();
  assert.equal(await bal(core, "asset_bills"), 42_000);
  assert.equal(before.me.free - after.me.free, 42_000);
});

test("12. gross grocery split", async () => {
  const { core } = await fresh();
  await given(core, "liab_mastercard", 0);
  const splits = [
    { label: "Household", amount_minor: 8_412, economic_owner_id: "me", reimbursable: false },
    { label: "Sam personal", amount_minor: 2_390, economic_owner_id: "me", reimbursable: false },
    { label: "Alex personal", amount_minor: 1_575, economic_owner_id: "alex", reimbursable: true },
  ];
  await assert.rejects(
    core.recordSplitPurchase({ idempotency_key: "split-bad", occurred_at: T, gross_amount_minor: 12_387, payment_account_id: "liab_mastercard", splits, description: "Supermarket" }),
    /must match/,
  );
  await core.recordSplitPurchase({ idempotency_key: "split", occurred_at: T, gross_amount_minor: 12_377, payment_account_id: "liab_mastercard", splits, description: "Supermarket" });
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 1, "one purchase, not one per split");
  assert.equal(await count(core, "SELECT count(*) n FROM transaction_splits"), 3);
  const s = await core.periodSummary({ month: "2026-10" });
  assert.equal(s.economic_spending, 8_412 + 2_390);
  assert.equal(await bal(core, "recv_alex_USD"), 1_575);
  assert.equal(await bal(core, "liab_mastercard"), 12_377);
});

test("13. partial reimbursement with explicit waiver", async () => {
  const { core } = await fresh();
  await given(core, "asset_cash", 100_000);
  await given(core, "asset_savings", 500_000);
  await core.recordExpense({ idempotency_key: "store", occurred_at: T, amount_minor: 9_215, currency: "USD", payment_account_id: "asset_savings", category: "groceries", description: "Store run", reimbursable_minor: 2_150, reimbursable_from_owner_id: "alex" });
  await assert.rejects(
    core.recordReimbursementReceived({ idempotency_key: "r-bad", occurred_at: "2026-10-01T11:30", receivable_id: "alex", destination_account_id: "asset_cash", amount_minor: 2_000, waive_minor: 150 }),
    /waive_reason/,
  );
  await core.recordReimbursementReceived({ idempotency_key: "r", occurred_at: "2026-10-01T11:30", receivable_id: "alex", destination_account_id: "asset_cash", amount_minor: 2_000, waive_minor: 150, waive_reason: "rounded off" });
  assert.equal(await bal(core, "recv_alex_USD"), 0);
  assert.equal(await bal(core, "asset_cash"), 102_000);
  assert.equal((await core.periodSummary({ month: "2026-10" })).waived, 150);
});

test("14. pass-through", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 300_000);
  await core.recordPassThrough({ idempotency_key: "pt-in", occurred_at: T, amount_minor: 100_000, account_id: "asset_checking", owner_id: "alex", direction: "in", counterparty: "Landlord" });
  await core.recordPassThrough({ idempotency_key: "pt-out", occurred_at: "2026-10-01T11:00", amount_minor: 100_000, account_id: "asset_checking", owner_id: "alex", direction: "out", counterparty: "Landlord" });
  const s = await core.periodSummary({ month: "2026-10" });
  assert.equal(s.income, 0);
  assert.equal(s.economic_spending, 0);
  assert.equal(await bal(core, "asset_checking"), 300_000);
});

test("15. next month's minimum paid early", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 1_000_000, "2026-09-20T08:00");
  await given(core, "liab_store_card", 2_000_000, "2026-09-20T08:00");
  await core.upsertObligation({ idempotency_key: "o", obligation_id: "obl_cl", name: "Store card October minimum", amount_minor: 7_700, currency: "USD", due_date: "2026-10-06", kind: "card_minimum", linked_account_id: "liab_store_card", status: "pending", confidence: "confirmed" });
  await core.markObligationPaid({ idempotency_key: "p", obligation_id: "obl_cl", paid_at: "2026-09-25T12:00", funding_account_id: "asset_checking" });
  const o = await core.obligation("obl_cl");
  assert.equal(o.status, "paid");
  assert.equal(o.due_date!.slice(0, 7), "2026-10");
  assert.equal(o.paid_at!.slice(0, 7), "2026-09");
  assert.equal((await core.periodSummary({ month: "2026-09" })).debt_payments, 7_700);
  assert.equal((await core.periodSummary({ month: "2026-10" })).debt_payments, 0);
  const oct = (await core.upcomingObligations({ from_date: "2026-10-01", to_date: "2026-10-31" })) as { id: string; status: string }[];
  assert.equal(oct.find((x) => x.id === "obl_cl")?.status, "paid");
});

test("16. reversal keeps history", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 1_000_000);
  const r = await core.recordIncome({ idempotency_key: "wrong", occurred_at: T, amount_minor: 250_000, currency: "USD", destination_account_id: "asset_checking", source: "Typo" });
  await core.reverseTransaction({ idempotency_key: "undo", transaction_id: r.transaction_id!, reason: "entered twice" });
  assert.equal(await bal(core, "asset_checking"), 1_000_000);
  const orig = await core.db.get<{ status: string; reversed_by: string }>("SELECT status, reversed_by FROM transactions WHERE id = ?", [r.transaction_id!]);
  assert.equal(orig?.status, "reversed");
  assert.ok(orig?.reversed_by);
  assert.equal(await count(core, "SELECT count(*) n FROM audit_log WHERE action IN ('money_record_income','money_reverse_transaction')"), 2);
});

test("17. batch atomicity", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 1_000_000);
  const ok = (n: number) => ({ tool: "money_record_income", args: { occurred_at: T, amount_minor: 1_000 * n, currency: "USD", destination_account_id: "asset_checking", source: `item ${n}` } });
  await assert.rejects(
    core.recordBatch({ idempotency_key: "batch", items: [ok(1), ok(2), ok(3), { tool: "money_record_income", args: { ...ok(4).args, destination_account_id: "nope" } }, ok(5)] }),
    /item 4/,
  );
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 0);
  assert.equal(await bal(core, "asset_checking"), 1_000_000);
  await core.recordBatch({ idempotency_key: "batch2", items: [ok(1), ok(2), ok(3)] });
  assert.equal(await bal(core, "asset_checking"), 1_006_000);
});

test("18. currency isolation", async () => {
  const { core } = await fresh("demo");
  const s = await core.snapshot();
  assert.equal(s.me.liquid, LIQUID, "the EUR wallet isn't added to USD");
  assert.equal(s.foreign_currency.find((a) => a.id === "asset_euro")?.balance_minor, 2_000);
  await assert.rejects(
    core.recordTransfer({ idempotency_key: "fx", occurred_at: T, amount_minor: 2_000, currency: "EUR", from_account_id: "asset_euro", to_account_id: "asset_checking" }),
    /FX|currenc/i,
  );
});

test("19. owner separation", async () => {
  const { core } = await fresh("demo");
  const before = await liquid(core);
  await assert.rejects(
    core.recordExpense({ idempotency_key: "alex-pay", occurred_at: T, amount_minor: 5_000, currency: "USD", payment_account_id: "asset_alex_shop", category: "x", description: "Alex's purchase" }),
    /belongs to Alex/,
  );
  await assert.rejects(
    core.recordIncome({ idempotency_key: "alex-in", occurred_at: T, amount_minor: 5_000, currency: "USD", destination_account_id: "asset_alex_shop", source: "x" }),
    /belongs to Alex/,
  );
  // Alex's own balance update never touches your liquidity.
  await core.setBalanceCheckpoint({ idempotency_key: "alex-cp", account_id: "asset_alex_shop", as_of: T, reported_balance_minor: 50_000, source_kind: "user" });
  assert.equal(await liquid(core), before);
});

test("20. card snapshot wins, no synthesized interest", async () => {
  const { core } = await fresh("demo");
  const r = await core.setCardSnapshot({ idempotency_key: "visa-snap", card_account_id: "liab_visa", as_of: T, debt_minor: 418_000, available_credit_minor: 0, minimum_minor: 38_000, minimum_due_date: "2026-10-06" });
  assert.equal(await bal(core, "liab_visa"), 418_000);
  assert.equal(r.reconciliation_issues.length, 1);
  assert.equal((r.reconciliation_issues[0] as { difference_minor: number }).difference_minor, 418_000 - BALANCES.liab_visa);
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 0);
});

test("21. month close is immutable", async () => {
  const { core } = await fresh("demo");
  await core.closeMonth({ idempotency_key: "close-sep", month: "2026-09" });
  const frozen = (await core.db.get<{ export_json: string }>("SELECT export_json FROM month_close_exports WHERE month = '2026-09'"))!.export_json;
  await assert.rejects(
    core.recordIncome({ idempotency_key: "late", occurred_at: "2026-09-29T12:00", amount_minor: 1_000, currency: "USD", destination_account_id: "asset_checking", source: "late" }),
    /closed/,
  );
  await core.recordIncome({ idempotency_key: "oct", occurred_at: T, amount_minor: 1_000, currency: "USD", destination_account_id: "asset_checking", source: "October" });
  const after = (await core.db.get<{ export_json: string }>("SELECT export_json FROM month_close_exports WHERE month = '2026-09'"))!.export_json;
  assert.equal(after, frozen);
  await assert.rejects(core.closeMonth({ idempotency_key: "close-oct", month: "2026-10" }), /hasn't ended/);
});

test("22. paid obligation is atomic", async () => {
  const { core } = await fresh("demo");
  await assert.rejects(core.markObligationPaid({ idempotency_key: "bad", obligation_id: "obl_car_loan_2026_10", paid_at: T, funding_account_id: "asset_alex_shop" }));
  assert.equal((await core.obligation("obl_car_loan_2026_10")).status, "pending");
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 0);
  const r = await core.markObligationPaid({ idempotency_key: "good", obligation_id: "obl_car_loan_2026_10", paid_at: T, funding_account_id: "asset_checking" });
  const o = await core.obligation("obl_car_loan_2026_10");
  assert.equal(o.status, "paid");
  assert.ok(r.transaction_id);
  assert.equal(await bal(core, "asset_checking"), BALANCES.asset_checking - 41_275);
});

test("23. duplicate assistant retry", async () => {
  const { core } = await fresh("demo");
  const args = { idempotency_key: "same", occurred_at: T, amount_minor: 1_275, currency: "USD", payment_account_id: "asset_checking", category: "food", description: "Lunch" };
  await Promise.all([core.recordExpense(args), core.recordExpense(args)].map((p) => p.catch(() => null)));
  await core.recordExpense(args);
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 1);
  assert.equal(await bal(core, "asset_checking"), BALANCES.asset_checking - 1_275);
});

test("24. unknown funding account stays draft", async () => {
  const { core } = await fresh("demo");
  const before = await liquid(core);
  const r = await core.recordExpense({ idempotency_key: "paid-40", occurred_at: T, amount_minor: 4_000, currency: "USD", payment_account_id: null, category: "unknown", description: "I paid $40" });
  assert.match(r.summary, /DRAFT/);
  assert.equal(await liquid(core), before);
  await core.completeDraft({ idempotency_key: "paid-40-done", transaction_id: r.transaction_id!, payment_account_id: "asset_savings" });
  assert.equal(before - (await liquid(core)), 4_000);
});


test("25. starting liquidity and free money", async () => {
  const { core } = await fresh("demo");
  const s = await core.snapshot();
  assert.equal(s.currency, "USD");
  assert.equal(s.me.liquid, LIQUID);
  assert.equal(s.me.reserved, RESERVED, "the EUR reservation isn't subtracted from USD");
  assert.equal(s.me.free, LIQUID - RESERVED);
  assert.equal(s.held_total, LIQUID + BALANCES.asset_alex_shop);
  assert.ok(!s.me.accounts.some((a) => a.owner_id === "alex"));
});

test("backup round-trip restores the same truth", async () => {
  const { exportAll, restoreInto } = await import("../src/core/backup.ts");
  const { core } = await fresh("demo");
  await core.recordIncome({ idempotency_key: "rt-1", occurred_at: T, amount_minor: 60_000, currency: "USD", destination_account_id: "asset_checking", source: "Salary" });
  const r = await core.recordExpense({ idempotency_key: "rt-2", occurred_at: T, amount_minor: 500, currency: "USD", payment_account_id: "asset_cash", category: "food", description: "Lunch" });
  await core.reverseTransaction({ idempotency_key: "rt-3", transaction_id: r.transaction_id!, reason: "test" });
  await core.recordCardPayment({ idempotency_key: "rt-4", occurred_at: T, card_account_id: "liab_visa", funding_account_id: "asset_bills", amount_minor: 27_500, obligation_id: "obl_visa_2026_10" });
  const dump = JSON.parse(JSON.stringify(await exportAll(core.db, core.now())));
  const { core: target } = await freshEmpty();
  await restoreInto(target.db, dump);
  assert.deepEqual((await target.snapshot()).me, (await core.snapshot()).me);
  assert.equal((await target.obligation("obl_visa_2026_10")).paid_minor, 27_500, "partial payments survive a restore");
  await assert.rejects(restoreInto(target.db, dump), /already has data/);
});

async function freshEmpty() {
  return fresh("empty");
}

// ---------------------------------------------------------------------------
// Regressions: partial payments, reservations, closed months.

test("R1a. partial card payment keeps the minimum pending and spends only what was paid", async () => {
  const { core } = await fresh("demo");
  const debt = await bal(core, "liab_visa");
  const r = await core.recordCardPayment({ idempotency_key: "visa-part", occurred_at: T, card_account_id: "liab_visa", funding_account_id: "asset_bills", amount_minor: 27_500, obligation_id: "obl_visa_2026_10" });
  let o = await core.obligation("obl_visa_2026_10");
  assert.equal(o.status, "pending", "$275 against $380 must not mark it paid");
  assert.equal(o.paid_minor, 27_500);
  assert.match(r.summary, /\$105\.00 of \$380\.00 still due/);
  assert.equal(await bal(core, "liab_visa"), debt - 27_500);
  assert.equal((await core.db.get<{ status: string }>("SELECT status FROM reservations WHERE id = 'res_visa'"))!.status, "spent");
  const open = (await core.upcomingObligations({ from_date: "2026-10-01", to_date: "2026-10-31" })) as { id: string; remaining_minor: number }[];
  assert.equal(open.find((x) => x.id === "obl_visa_2026_10")!.remaining_minor, 10_500);

  const checking = await bal(core, "asset_checking");
  await core.markObligationPaid({ idempotency_key: "visa-rest", obligation_id: "obl_visa_2026_10", paid_at: T, funding_account_id: "asset_checking" });
  o = await core.obligation("obl_visa_2026_10");
  assert.equal(o.status, "paid");
  assert.equal(checking - (await bal(core, "asset_checking")), 10_500, "marking paid defaults to the remainder");
});

test("R1b. reservations draw down on partial payment and release when fully paid", async () => {
  const { core } = await fresh();
  await given(core, "asset_bills", 1_000_000);
  await given(core, "liab_visa", 1_000_000);
  await core.upsertObligation({ idempotency_key: "o", obligation_id: "obl_min", name: "Visa minimum", amount_minor: 60_000, currency: "USD", due_date: "2026-10-06", kind: "card_minimum", linked_account_id: "liab_visa", status: "pending", confidence: "confirmed" });
  await core.reserveFunds({ idempotency_key: "res", label: "Visa minimum", amount_minor: 42_000, currency: "USD", account_id: "asset_bills", obligation_id: "obl_min" });
  const resId = (await core.db.get<{ id: string }>("SELECT id FROM reservations"))!.id;
  await core.recordCardPayment({ idempotency_key: "p1", occurred_at: T, card_account_id: "liab_visa", funding_account_id: "asset_bills", amount_minor: 10_000, obligation_id: "obl_min" });
  let res = (await core.db.get<{ status: string; amount_minor: number }>("SELECT status, amount_minor FROM reservations WHERE id = ?", [resId]))!;
  assert.deepEqual({ ...res }, { status: "active", amount_minor: 32_000 });
  assert.equal((await core.snapshot()).me.reserved, 32_000);

  // Remainder paid from another account: the leftover reservation is released, never left dangling.
  await given(core, "asset_checking", 1_000_000);
  await core.recordCardPayment({ idempotency_key: "p2", occurred_at: T, card_account_id: "liab_visa", funding_account_id: "asset_checking", amount_minor: 10_000, obligation_id: "obl_min" });
  res = (await core.db.get<{ status: string; amount_minor: number }>("SELECT status, amount_minor FROM reservations WHERE id = ?", [resId]))!;
  assert.deepEqual({ ...res }, { status: "active", amount_minor: 22_000 });
  const last = await core.recordCardPayment({ idempotency_key: "p3", occurred_at: T, card_account_id: "liab_visa", funding_account_id: "asset_checking", amount_minor: 40_000, obligation_id: "obl_min" });
  assert.equal((await core.obligation("obl_min")).status, "paid");
  res = (await core.db.get<{ status: string; amount_minor: number }>("SELECT status, amount_minor FROM reservations WHERE id = ?", [resId]))!;
  assert.equal(res.status, "spent");
  assert.equal((await core.snapshot()).me.reserved, 0);
  assert.match(last.summary, /fully paid/);
});

test("R1c. a reservation larger than the obligation is released, not spent, when it's paid", async () => {
  const { core } = await fresh();
  await given(core, "asset_bills", 1_000_000);
  await given(core, "liab_visa", 1_000_000);
  await core.upsertObligation({ idempotency_key: "o", obligation_id: "obl_small", name: "Small minimum", amount_minor: 30_000, currency: "USD", due_date: "2026-10-06", kind: "card_minimum", linked_account_id: "liab_visa", status: "pending", confidence: "confirmed" });
  await core.reserveFunds({ idempotency_key: "res", label: "Held for card", amount_minor: 42_000, currency: "USD", account_id: "asset_bills", obligation_id: "obl_small" });
  const r = await core.markObligationPaid({ idempotency_key: "pay", obligation_id: "obl_small", paid_at: T, funding_account_id: "asset_bills" });
  assert.equal((await core.db.get<{ status: string }>("SELECT status FROM reservations"))!.status, "released");
  assert.ok(r.warnings.some((w) => /Released/.test(w)));
  assert.equal((await core.snapshot()).me.reserved, 0);
});

test("R1d. partial bill payment stays pending; reversal reopens a paid bill", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 500_000);
  await core.upsertObligation({ idempotency_key: "o", obligation_id: "obl_phone", name: "Phone bill", amount_minor: 8_000, currency: "USD", due_date: "2026-10-03", kind: "utility", status: "planned", confidence: "inferred" });
  await core.markObligationPaid({ idempotency_key: "c1", obligation_id: "obl_phone", paid_at: T, funding_account_id: "asset_checking", actual_amount_minor: 3_000 });
  let o = await core.obligation("obl_phone");
  assert.equal(o.status, "pending");
  assert.equal(o.paid_minor, 3_000);
  const r = await core.markObligationPaid({ idempotency_key: "c2", obligation_id: "obl_phone", paid_at: T, funding_account_id: "asset_checking" });
  o = await core.obligation("obl_phone");
  assert.equal(o.status, "paid");
  assert.equal((await core.periodSummary({ month: "2026-10" })).economic_spending, 8_000);

  await core.reverseTransaction({ idempotency_key: "undo-c2", transaction_id: r.transaction_id!, reason: "bank bounced it" });
  o = await core.obligation("obl_phone");
  assert.equal(o.status, "pending");
  assert.equal(o.paid_minor, 3_000);
});

test("R2. checkpoints and card snapshots can't write into a closed month", async () => {
  const { core } = await fresh("demo");
  await core.closeMonth({ idempotency_key: "close-sep", month: "2026-09" });
  await assert.rejects(
    core.setBalanceCheckpoint({ idempotency_key: "late-cp", account_id: "asset_cash", as_of: "2026-09-29T12:00", reported_balance_minor: 5_000, source_kind: "user" }),
    /closed/,
  );
  await assert.rejects(
    core.setCardSnapshot({ idempotency_key: "late-card", card_account_id: "liab_visa", as_of: "2026-09-29T12:00", debt_minor: 900_000 }),
    /closed/,
  );
  assert.equal(await count(core, "SELECT count(*) n FROM balance_checkpoints WHERE as_of < '2026-10-01'"), Object.keys(BALANCES).length + 1);
  await core.setBalanceCheckpoint({ idempotency_key: "oct-cp", account_id: "asset_cash", as_of: T, reported_balance_minor: 10_000, source_kind: "user" });
});

test("R3. a month close freezes month-end state, not close-time state", async () => {
  const { core } = await fresh("demo");
  // A September bill paid in October, a September issue resolved in October, and a new October issue.
  await core.upsertObligation({ idempotency_key: "o", obligation_id: "obl_sep_bill", name: "September bill", amount_minor: 50_000, currency: "USD", due_date: "2026-09-28", kind: "utility", status: "pending", confidence: "confirmed" });
  await core.markObligationPaid({ idempotency_key: "p", obligation_id: "obl_sep_bill", paid_at: T, funding_account_id: "asset_checking" });
  await core.resolveReconciliation({ idempotency_key: "res", issue_id: "rec_cash_sep", resolution_type: "accept_checkpoint", explanation: "unknown spend" });
  const oct = await core.setBalanceCheckpoint({ idempotency_key: "oct-issue", account_id: "asset_cash", as_of: T, reported_balance_minor: 4_000, source_kind: "user" });
  const octIssue = (oct.reconciliation_issues[0] as { id: string }).id;

  await core.closeMonth({ idempotency_key: "close-sep", month: "2026-09" });
  const snap = JSON.parse((await core.db.get<{ export_json: string }>("SELECT export_json FROM month_close_exports WHERE month = '2026-09'"))!.export_json);
  const ids = snap.open_reconciliation_issues.map((i: { id: string }) => i.id);
  assert.ok(ids.includes("rec_cash_sep"), "resolved after month-end, so still open at month-end");
  assert.ok(!ids.includes(octIssue), "an October issue doesn't belong in September's close");
  const bill = snap.obligations.find((o: { id: string }) => o.id === "obl_sep_bill");
  assert.equal(bill.status_at_month_end, "pending");
  assert.equal(bill.remaining_at_month_end_minor, 50_000);
});

test("R4. balances are known unless the account is explicitly flagged unknown", async () => {
  const { core } = await fresh();
  await given(core, "asset_checking", 1_000_000);
  await core.recordCardPayment({ idempotency_key: "p", occurred_at: T, card_account_id: "liab_home_loan", funding_account_id: "asset_checking", amount_minor: 100_000 });
  await core.setField({ idempotency_key: "f", entity_type: "account", entity_id: "liab_car_loan", key: "balance_unknown", value: true });
  let liabs = (await core.snapshot()).liabilities;
  assert.equal(liabs.find((l) => l.id === "liab_home_loan")!.balance_known, true, "ledger activity without a checkpoint still shows a balance");
  assert.equal(liabs.find((l) => l.id === "liab_car_loan")!.balance_known, false);
  await core.setBalanceCheckpoint({ idempotency_key: "cp", account_id: "liab_car_loan", as_of: T, reported_balance_minor: 4_000_000, source_kind: "statement" });
  liabs = (await core.snapshot()).liabilities;
  assert.equal(liabs.find((l) => l.id === "liab_car_loan")!.balance_known, true, "a checkpoint establishes the balance");
});

test("R6. closing a month through the tool stores a frozen HTML page", async () => {
  const { callTool } = await import("../src/tools.ts");
  const { core } = await fresh("demo");
  const r = await callTool(core, "money_close_month", { idempotency_key: "close", month: "2026-09" }, { readOnly: false });
  assert.ok(r.ok);
  const page = (await core.db.get<{ report_html: string }>("SELECT report_html FROM month_close_exports WHERE month = '2026-09'"))!.report_html;
  assert.match(page, /September 2026/);
  assert.match(page, /Generated from canonical Money Truths database/);
  assert.match(page, /Visa/);
  assert.match(page, /\$4,123\.50/, "amounts in the ledger's currency");
});

// ---------------------------------------------------------------------------
// Regressions: batches, overpayment, month-end status.

test("R7. a batch can't settle the same obligation or receivable twice", async () => {
  const { core } = await fresh("demo");
  const pay = (n: number) => ({ tool: "money_mark_obligation_paid", args: { obligation_id: "obl_visa_2026_10", paid_at: T, funding_account_id: "asset_checking", actual_amount_minor: n } });
  await assert.rejects(core.recordBatch({ idempotency_key: "two-pays", items: [pay(25_000), pay(20_000)] }), /items 1 and 2 both settle obligation/);
  assert.equal(await count(core, "SELECT count(*) n FROM transactions"), 0);
  assert.equal((await core.obligation("obl_visa_2026_10")).paid_minor, 0);

  await core.recordExpense({ idempotency_key: "front", occurred_at: T, amount_minor: 10_000, currency: "USD", payment_account_id: "asset_checking", category: "supplies", description: "Alex's supplies", reimbursable_minor: 10_000, reimbursable_from_owner_id: "alex" });
  const back = (n: number) => ({ tool: "money_record_reimbursement_received", args: { occurred_at: T, receivable_id: "alex", destination_account_id: "asset_checking", amount_minor: n } });
  await assert.rejects(core.recordBatch({ idempotency_key: "two-backs", items: [back(6_000), back(6_000)] }), /both settle receivable recv_alex_USD/);
  assert.equal(await bal(core, "recv_alex_USD"), 10_000, "the $120 would have over-settled a $100 debt");

  // One per obligation in a batch is fine.
  await core.recordBatch({ idempotency_key: "ok", items: [pay(38_000), back(6_000)] });
  assert.equal((await core.obligation("obl_visa_2026_10")).status, "paid");
});

test("R8. a payment larger than the obligation applies only what was owed", async () => {
  const { core } = await fresh("demo");
  const debt = await bal(core, "liab_visa");
  const r = await core.recordCardPayment({ idempotency_key: "big", occurred_at: "2026-10-01T11:00", card_account_id: "liab_visa", funding_account_id: "asset_checking", amount_minor: 60_000, obligation_id: "obl_visa_2026_10" });
  const o = await core.obligation("obl_visa_2026_10");
  assert.equal(o.status, "paid");
  assert.equal(o.paid_minor, 38_000, "never more than the obligation");
  assert.equal(debt - (await bal(core, "liab_visa")), 60_000, "the whole payment still reduced the card");
  assert.ok(r.warnings.some((w) => /\$220\.00 beyond/.test(w)));
});

test("R9. a month close reconstructs status as of month-end from status history", async () => {
  const { core } = await fresh("demo");
  await core.upsertObligation({ idempotency_key: "a", obligation_id: "obl_cancelled_later", name: "Cancelled in October", amount_minor: 30_000, currency: "USD", due_date: "2026-09-27", kind: "other", status: "pending", confidence: "confirmed" });
  await core.upsertObligation({ idempotency_key: "b", obligation_id: "obl_paid_on_time", name: "Paid Sep 29, recorded later", amount_minor: 40_000, currency: "USD", due_date: "2026-09-29", kind: "utility", status: "pending", confidence: "confirmed" });
  await core.upsertObligation({ idempotency_key: "c", obligation_id: "obl_cancelled_later", name: "Cancelled in October", amount_minor: 30_000, currency: "USD", due_date: "2026-09-27", kind: "other", status: "cancelled", confidence: "confirmed" });
  await core.markObligationPaid({ idempotency_key: "d", obligation_id: "obl_paid_on_time", paid_at: "2026-09-29T12:00", funding_account_id: "asset_checking" });

  await core.closeMonth({ idempotency_key: "close", month: "2026-09" });
  const snap = JSON.parse((await core.db.get<{ export_json: string }>("SELECT export_json FROM month_close_exports WHERE month = '2026-09'"))!.export_json);
  const get = (id: string) => snap.obligations.find((o: { id: string }) => o.id === id);
  assert.equal(get("obl_cancelled_later").status_at_month_end, "pending", "cancelled after month-end, so pending at month-end");
  assert.equal(get("obl_cancelled_later").remaining_at_month_end_minor, 30_000);
  assert.equal(get("obl_paid_on_time").status_at_month_end, "paid", "paid Sep 29 even though recorded in October");
  assert.equal(get("obl_paid_on_time").remaining_at_month_end_minor, 0);
});

// ---------------------------------------------------------------------------
// Housekeeping tools: edit plans and labels, never money that moved.

test("E1. notes can be edited, archived and unarchived", async () => {
  const { core } = await fresh("demo");
  const added = await core.addNote({ idempotency_key: "n", author: "Assistant", body: "first draft" });
  const id = added.entity!.id;
  await core.updateNote({ idempotency_key: "n-edit", note_id: id, body: "second draft" });
  await core.updateNote({ idempotency_key: "n-arch", note_id: id, archived: true });
  assert.equal((await core.notes()).length, 0, "archived notes leave the default list");
  const all = (await core.notes({ include_archived: true })) as { body: string; archived: number }[];
  assert.deepEqual([all[0].body, all[0].archived], ["second draft", 1]);
  await core.updateNote({ idempotency_key: "n-back", note_id: id, archived: false });
  assert.equal((await core.notes()).length, 1);
  await assert.rejects(core.updateNote({ idempotency_key: "n-empty", note_id: id, body: "  " }), /archive the note instead/);
});

test("E2. reservations can be resized or released; free money follows, the bank doesn't", async () => {
  const { core } = await fresh("demo");
  const before = await core.snapshot();
  await core.updateReservation({ idempotency_key: "r-size", reservation_id: "res_visa", amount_minor: 15_000 });
  let s = await core.snapshot();
  assert.equal(s.me.free - before.me.free, 12_500);
  assert.equal(s.me.liquid, before.me.liquid);
  await core.updateReservation({ idempotency_key: "r-free", reservation_id: "res_visa", status: "released" });
  s = await core.snapshot();
  assert.equal(s.me.free, s.me.liquid);
  await assert.rejects(core.updateReservation({ idempotency_key: "r-again", reservation_id: "res_visa", amount_minor: 1 }), /already released/);
  const r = await core.updateReservation({ idempotency_key: "r-big", reservation_id: "res_euro", amount_minor: 5_000 });
  assert.ok(r.warnings.some((w) => /more than the account holds/.test(w)));
});

test("E3. expected inflows can be updated or cancelled, never marked received by hand", async () => {
  const { core } = await fresh("demo");
  const added = await core.addExpectedInflow({ idempotency_key: "v", source: "Client — 5 posts", amount_minor: 25_000, currency: "USD", expected_to: "2026-09-30", status: "expected" });
  const id = added.entity!.id;
  const before = await core.snapshot();
  await core.updateExpectedInflow({ idempotency_key: "v-date", expected_inflow_id: id, expected_to: "2026-10-15", amount_minor: 20_000 });
  await assert.rejects(core.updateExpectedInflow({ idempotency_key: "v-recv", expected_inflow_id: id, status: "received" as never }), /money_record_income/);
  await core.updateExpectedInflow({ idempotency_key: "v-cancel", expected_inflow_id: id, status: "cancelled" });
  const after = await core.snapshot();
  assert.equal(after.me.free, before.me.free, "expected money never touches balances");
  assert.ok(!(after.expected_inflows as { id: string }[]).some((e) => e.id === id), "cancelled inflows drop out of the snapshot");

  const pay = await core.addExpectedInflow({ idempotency_key: "s", source: "Paycheck", amount_minor: 300_000, currency: "USD", status: "confirmed_arrangement" });
  await core.recordIncome({ idempotency_key: "s-in", occurred_at: T, amount_minor: 300_000, currency: "USD", destination_account_id: "asset_checking", source: "Paycheck", expected_inflow_id: pay.entity!.id });
  await assert.rejects(core.updateExpectedInflow({ idempotency_key: "s-edit", expected_inflow_id: pay.entity!.id, amount_minor: 1 }), /already arrived/);
});

test("E4. recurring rules: add, pause with a partial update, resume", async () => {
  const { core } = await fresh("demo");
  const added = await core.upsertRecurringRule({ idempotency_key: "rr", name: "AI subscription", owner_id: "me", amount_minor: 2_000, currency: "USD", cadence: "monthly", kind: "subscription", confidence: "confirmed" });
  const id = added.entity!.id;
  const paused = await core.upsertRecurringRule({ idempotency_key: "rr-pause", rule_id: id, active: false });
  assert.match(paused.summary, /Paused/);
  const rule = (await core.db.get<{ name: string; amount_minor: number; active: number }>("SELECT name, amount_minor, active FROM recurring_rules WHERE id = ?", [id]))!;
  assert.deepEqual({ ...rule }, { name: "AI subscription", amount_minor: 2_000, active: 0 }, "a partial update keeps everything else");
  assert.match((await core.upsertRecurringRule({ idempotency_key: "rr-resume", rule_id: id, active: true })).summary, /Resumed/);
  await assert.rejects(core.upsertRecurringRule({ idempotency_key: "rr-bad", name: "x", owner_id: "nobody", currency: "USD", cadence: "monthly", kind: "other" }), /Unknown owner/);
  await assert.rejects(core.upsertRecurringRule({ idempotency_key: "rr-half", name: "x" }), /required/);
  assert.ok(((await core.snapshot()).recurring_rules as { id: string }[]).some((r) => r.id === id));
});

test("E5. accounts: rename, refuse to close with money attached, close and reopen", async () => {
  const { core } = await fresh("demo");
  await core.updateAccount({ idempotency_key: "rename", account_id: "asset_bills", name: "Bills" });
  assert.equal((await core.account("asset_bills")).name, "Bills");
  await assert.rejects(core.updateAccount({ idempotency_key: "close-bills", account_id: "asset_bills", active: false }), /still shows \$275\.00/);
  await assert.rejects(core.updateAccount({ idempotency_key: "close-visa", account_id: "liab_visa", active: false }), /still shows/);
  await assert.rejects(core.updateAccount({ idempotency_key: "full-no", account_id: "liab_visa", last4: "4242424242424242" }), /never store a full/);

  // Empty the cash, then close it.
  await core.recordTransfer({ idempotency_key: "empty-cash", occurred_at: T, amount_minor: 1_000, currency: "USD", from_account_id: "asset_cash", to_account_id: "asset_checking" });
  const liquidBefore = (await core.snapshot()).me.liquid;
  await core.updateAccount({ idempotency_key: "close-cash", account_id: "asset_cash", active: false });
  const s = await core.snapshot();
  assert.equal(s.me.liquid, liquidBefore, "closing an empty account changes no total");
  assert.ok(!s.me.accounts.some((a) => a.id === "asset_cash"), "closed accounts leave the lists");
  await assert.rejects(core.recordIncome({ idempotency_key: "into-closed", occurred_at: T, amount_minor: 1_000, currency: "USD", destination_account_id: "asset_cash", source: "x" }), /is closed/);
  await assert.rejects(core.setBalanceCheckpoint({ idempotency_key: "cp-closed", account_id: "asset_cash", as_of: T, reported_balance_minor: 5_000, source_kind: "user" }), /is closed/);
  await core.updateAccount({ idempotency_key: "reopen-cash", account_id: "asset_cash", active: true });
  await core.recordIncome({ idempotency_key: "into-open", occurred_at: T, amount_minor: 1_000, currency: "USD", destination_account_id: "asset_cash", source: "x" });
});

test("E6. housekeeping writes are audited and idempotent", async () => {
  const { core } = await fresh("demo");
  const args = { idempotency_key: "same-release", reservation_id: "res_visa", status: "released" as const };
  await core.updateReservation(args);
  const again = await core.updateReservation(args);
  assert.equal(again.replayed, true);
  assert.equal(await count(core, "SELECT count(*) n FROM audit_log WHERE action = 'money_update_reservation'"), 1);
  const payload = JSON.parse((await core.db.get<{ payload_json: string }>("SELECT payload_json FROM audit_log WHERE action = 'money_update_reservation'"))!.payload_json);
  assert.equal(payload.payload[0].before.amount_minor, 27_500, "the audit keeps what it looked like before");
});

test("E7. paused subscriptions and cancelled expectations read correctly on the report", async () => {
  const { loadView } = await import("../src/core/report-data.ts");
  const { core } = await fresh("demo");
  const sub = await core.upsertRecurringRule({ idempotency_key: "sub", name: "Spotify", owner_id: "me", amount_minor: 599, currency: "USD", cadence: "monthly", kind: "subscription" });
  await core.setField({ idempotency_key: "lbl", entity_type: "recurring_rule", entity_id: sub.entity!.id, key: "status_label", value: "Active" });
  await core.upsertRecurringRule({ idempotency_key: "sub-off", rule_id: sub.entity!.id, active: false });
  const e = await core.addExpectedInflow({ idempotency_key: "e", source: "Old client", amount_minor: 10_000, currency: "USD", status: "expected" });
  await core.updateExpectedInflow({ idempotency_key: "e-x", expected_inflow_id: e.entity!.id, status: "cancelled" });
  const v = await loadView(core);
  const spotify = v.subscriptions.find((s) => s.name === "Spotify")!;
  assert.deepEqual([spotify.status, spotify.tone], ["Paused", "muted"]);
  assert.equal(v.expected.find((x) => x.source === "Old client")!.status, "cancelled");
});

// ---------------------------------------------------------------------------
// In-chat ledger card (MCP Apps).

test("C1. the ledger card carries the same numbers as the snapshot, urgent items first", async () => {
  const { loadView } = await import("../src/core/report-data.ts");
  const { cardData, cardText } = await import("../src/card.ts");
  const { core } = await fresh("demo");
  const d = cardData(await loadView(core));
  const s = await core.snapshot();
  assert.equal(d.liquid, s.me.liquid);
  assert.equal(d.free, s.me.free);
  assert.equal(d.reserved, s.me.reserved);
  assert.ok(d.next.length <= 5);
  assert.match(d.next[0].label, /Visa|Car loan/, "card/loan payments due within a week come before routine bills");
  assert.ok(d.separate.some((x) => x.currency === "EUR"), "the EUR wallet is shown separately");
  assert.equal(d.currency, "USD");
  assert.match(cardText(d), /free \$3,210\.00/);
});

test("C2. the card page speaks the MCP Apps protocol and loads nothing external", async () => {
  const { CARD_HTML, CARD_MIME, CARD_URI } = await import("../src/card.ts");
  assert.equal(CARD_MIME, "text/html;profile=mcp-app");
  assert.match(CARD_URI, /^ui:\/\//);
  for (const m of ["ui/initialize", "ui/notifications/initialized", "ui/notifications/tool-result", "ui/notifications/size-changed", "tools/call", "money_show_ledger", "appInfo"]) {
    assert.ok(CARD_HTML.includes(m), m);
  }
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|https?:\/\//.test(CARD_HTML), "no external scripts, styles or URLs");
  const { CARD_RESOURCE_META } = await import("../src/card.ts");
  assert.deepEqual(CARD_RESOURCE_META.ui.csp, { connectDomains: [], resourceDomains: [] }, "declares an empty CSP");
  assert.deepEqual(CARD_RESOURCE_META["openai/widgetCSP"], { connect_domains: [], resource_domains: [] });
});

test("R10. an obligation marked paid without payment entries owes nothing", async () => {
  const { core } = await fresh("demo");
  // obl_store_2026_10 is seeded as paid (paid Sep 25, before the ledger started).
  const rows = (await core.upcomingObligations({ from_date: "2026-10-01", to_date: "2026-10-31" })) as { id: string; status: string; remaining_minor: number }[];
  const clasica = rows.find((r) => r.id === "obl_store_2026_10")!;
  assert.equal(clasica.status, "paid");
  assert.equal(clasica.remaining_minor, 0);
  assert.equal(rows.find((r) => r.id === "obl_visa_2026_10")!.remaining_minor, 38_000, "unpaid ones still show what is owed");
});

test("C3. the due card lays out the month and tracks paid, partial and overdue", async () => {
  const { dueData, dueText } = await import("../src/card.ts");
  const { core } = await fresh("demo");
  let d = await dueData(core);
  assert.equal(d.month, "2026-10");
  assert.equal(d.daysInMonth, 31);
  assert.equal(d.firstWeekday, 3, "Oct 1 2026 is a Thursday (Monday = 0)");
  assert.equal(d.today, 1);
  const by = (label: RegExp) => d.items.find((i) => label.test(i.label))!;
  assert.equal(by(/Store card/).status, "paid");
  assert.equal(by(/Visa/).status, "upcoming");

  await core.recordCardPayment({ idempotency_key: "visa-part", occurred_at: T, card_account_id: "liab_visa", funding_account_id: "asset_bills", amount_minor: 27_500, obligation_id: "obl_visa_2026_10" });
  d = await dueData(core);
  assert.deepEqual([by(/Visa/).status, by(/Visa/).amount, by(/Visa/).paid], ["partial", 10_500, 27_500]);
  const open = d.items.filter((i) => i.status !== "paid");
  assert.equal(d.totals.stillDue, open.reduce((s, i) => s + (i.amount ?? 0), 0));
  assert.match(dueText(d), /Visa October minimum \$105\.00 \(partial\)/);

  const sep = await dueData(core, "2026-09");
  assert.equal(sep.today, null, "another month has no 'today'");
  await assert.rejects(dueData(core, "nonsense"), /YYYY-MM/, "a malformed month is an error, not silently this month");
});

test("C4. the debts card lists cards with usage and loans with progress", async () => {
  const { loadView } = await import("../src/core/report-data.ts");
  const { debtsData, debtsText } = await import("../src/card.ts");
  const { core } = await fresh("demo");
  await core.setField({ idempotency_key: "k3", entity_type: "account", entity_id: "liab_home_loan", key: "priority", value: true });
  await core.setField({ idempotency_key: "k4", entity_type: "account", entity_id: "liab_home_loan", key: "installments_paid", value: 41 });
  await core.setField({ idempotency_key: "k5", entity_type: "account", entity_id: "liab_home_loan", key: "installments_total", value: 360 });
  const d = debtsData(await loadView(core));
  assert.equal(d.cards.length, 3);
  assert.equal(d.totals.cardDebt, BALANCES.liab_visa + BALANCES.liab_store_card);
  const home = d.loans.find((l) => /Home/.test(l.label))!;
  assert.deepEqual([home.balance, home.paid, home.total, home.priority], [18_750_000, 41, 360, true]);
  const car = d.loans.find((l) => /Car/.test(l.label))!;
  assert.deepEqual([car.balance, car.paid, car.total], [null, 6, 24], "an unknown balance stays unknown");
  assert.equal(d.totals.unknownLoans, 1);
  assert.match(debtsText(d), /Loan Home loan: \$187,500\.00/);
});

test("C5. every card tool points at the same app and the app routes refresh to the right tool", async () => {
  const { CARD_HTML } = await import("../src/card.ts");
  for (const t of ["renderDue", "renderDebts", "current.tool", "current.args"]) assert.ok(CARD_HTML.includes(t), t);
});

// ---------------------------------------------------------------------------
// Regressions: next due, available credit, disputes, versions, schemas.

test("R11. a loan's next due looks past the current month", async () => {
  const { loadView } = await import("../src/core/report-data.ts");
  const { core } = await fresh("demo");
  await given(core, "asset_checking", 1_000_000, "2026-10-01T09:00");
  await core.markObligationPaid({ idempotency_key: "oct", obligation_id: "obl_home_2026_10", paid_at: T, funding_account_id: "asset_checking" });
  await core.upsertObligation({ idempotency_key: "nov", obligation_id: "obl_home_2026_11", name: "Home loan November", amount_minor: 132_000, currency: "USD", due_date: "2026-11-11", kind: "loan", linked_account_id: "liab_home_loan", status: "planned", confidence: "inferred" });
  const home = (await loadView(core)).loans.find((l) => l.id === "liab_home_loan")!;
  assert.equal(home.nextDue, "Nov 11");
});

test("R12. available credit is the bank's figure until anything touches the card, then an estimate", async () => {
  const { loadView } = await import("../src/core/report-data.ts");
  const { core } = await fresh("demo");
  const visa = async () => (await loadView(core)).cards.find((c) => c.id === "liab_visa")!;
  // Bank says $73.15 available, though limit − debt would be $100.00 (e.g. a pending hold).
  await core.setCardSnapshot({ idempotency_key: "snap", card_account_id: "liab_visa", as_of: T, debt_minor: 400_000, available_credit_minor: 7_315, credit_limit_minor: 410_000 });
  let v = await visa();
  assert.deepEqual([v.available, v.availableEstimated], [7_315, false]);
  await core.recordCardPayment({ idempotency_key: "pay", occurred_at: "2026-10-01T11:00", card_account_id: "liab_visa", funding_account_id: "asset_checking", amount_minor: 10_000 });
  v = await visa();
  assert.deepEqual([v.available, v.availableEstimated], [20_000, true]);
  // A purchase that brings the debt back to the snapshot figure doesn't make the bank's number current again.
  await core.recordCardPurchase({ idempotency_key: "buy", occurred_at: "2026-10-01T11:30", card_account_id: "liab_visa", amount_minor: 10_000, category: "food", description: "Dinner" });
  v = await visa();
  assert.equal(v.debt, 400_000);
  assert.deepEqual([v.available, v.availableEstimated], [10_000, true]);
  // A fresh snapshot makes it current again.
  await core.setCardSnapshot({ idempotency_key: "snap2", card_account_id: "liab_visa", as_of: "2026-10-01T11:45", debt_minor: 400_000, available_credit_minor: 6_000, credit_limit_minor: 410_000 });
  v = await visa();
  assert.deepEqual([v.available, v.availableEstimated], [6_000, false]);
});

test("R13. a disputed bill is disputed, not overdue, until its date passes", async () => {
  const { dueData } = await import("../src/card.ts");
  const { core } = await fresh("demo");
  await core.upsertObligation({ idempotency_key: "d", obligation_id: "obl_disputed", name: "Disputed charge", amount_minor: 9_000, currency: "USD", due_date: "2026-10-08", kind: "other", status: "disputed", confidence: "confirmed" });
  await core.upsertObligation({ idempotency_key: "e", obligation_id: "obl_disputed_late", name: "Old disputed charge", amount_minor: 10_000, currency: "USD", due_date: "2026-09-29", kind: "other", status: "disputed", confidence: "confirmed" });
  const d = await dueData(core);
  const item = d.items.find((i) => i.label === "Disputed charge")!;
  assert.deepEqual([item.status, item.late], ["disputed", false]);
  assert.equal(d.totals.overdueCount, 0, "disputed items never count as overdue");
  assert.equal(d.totals.disputedCount, 1, "September's disputed charge isn't in October");
});

test("R14. one version everywhere, stamped with the build", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { VERSION, versionLabel } = await import("../src/version.ts");
  const { CARD_HTML } = await import("../src/card.ts");
  assert.equal(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version, VERSION);
  assert.ok(CARD_HTML.includes(`const CARD_VERSION = "${VERSION}"`), "card app reports the same version");
  assert.ok(!CARD_HTML.includes("__CARD_VERSION__"));
  assert.equal(versionLabel("abc1234"), `v${VERSION} · abc1234`);
});

test("R15. card results match their declared output schemas", async () => {
  const { z } = await import("zod/v4");
  const { LEDGER_OUT, DUE_OUT, DEBTS_OUT } = await import("../src/mcp.ts");
  const { loadView } = await import("../src/core/report-data.ts");
  const { cardData, dueData, debtsData } = await import("../src/card.ts");
  const { core } = await fresh("demo");
  const view = await loadView(core);
  const version = "v1.0.0 · test";
  z.object(LEDGER_OUT).parse({ ...cardData(view), version });
  z.object(DUE_OUT).parse({ ...(await dueData(core)), version });
  z.object(DEBTS_OUT).parse({ ...debtsData(view), version });
});
