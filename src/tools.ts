import { z } from "zod/v4";
import type { Core } from "./core/index.ts";

// One registry of tools, shared by the MCP server and the HTTP API so the two
// surfaces can never drift.

export interface ToolDef {
  name: string;
  description: string;
  mutating: boolean;
  input: Record<string, z.ZodType>;
  run: (core: Core, args: Record<string, unknown>) => Promise<unknown>;
}

const key = z.string().min(1).describe("Unique per real-world event (e.g. 'salary-2026-10-01'). Retrying with the same key never double-records.");
const when = z.string().describe("ISO date (YYYY-MM-DD → noon local time) or datetime. Without an offset, the ledger's own timezone is assumed.");
const minor = z.number().int().describe("Integer in the currency's minor unit: cents for USD/EUR ($12.50 → 1250), whole units for currencies without decimals (JPY, PYG, KRW…).");
const currency = z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code like USD").describe("ISO 4217 code, e.g. USD, EUR, MXN.");
const account = (what: string) => z.string().describe(`${what} account id (see money_get_snapshot), e.g. asset_checking, asset_cash, liab_visa.`);
const notes = z.string().optional();

const def = <S extends Record<string, z.ZodType>>(d: { name: string; description: string; mutating: boolean; input: S; run: (core: Core, args: z.infer<z.ZodObject<S>>) => Promise<unknown> }): ToolDef => d as unknown as ToolDef;

export const TOOLS: ToolDef[] = [
  // ---- reads ----------------------------------------------------------------
  def({
    name: "money_get_snapshot",
    mutating: false,
    description:
      "Current Money Truths: the user's spendable money by account (main currency), reserved vs free money, money held for other people (excluded), other-currency accounts separately, cards/loans, open obligations, expected inflows (not cash), reconciliation issues and drafts. Call this first to learn account and obligation ids.",
    input: { as_of: z.string().optional(), include_others: z.boolean().optional(), include_expected: z.boolean().optional() },
    run: (c, a) => c.snapshot(a),
  }),
  def({
    name: "money_get_upcoming_obligations",
    mutating: false,
    description: "Obligations (card minimums, loans, bills, personal debts) due between two dates, any status.",
    input: { from_date: z.string(), to_date: z.string(), status: z.string().optional() },
    run: (c, a) => c.upcomingObligations(a),
  }),
  def({
    name: "money_get_reconciliation_issues",
    mutating: false,
    description: "Unexplained differences between reported balances and the ledger. Never resolve by inventing a transaction.",
    input: { status: z.enum(["open", "resolved", "all"]).optional() },
    run: (c, a) => c.reconciliationIssues(a),
  }),
  def({
    name: "money_get_history",
    mutating: false,
    description: "Ledger transactions with postings and splits, newest first. Filter by account and/or local dates.",
    input: { account_id: z.string().nullable().optional(), from_date: z.string().nullable().optional(), to_date: z.string().nullable().optional(), limit: z.number().int().optional() },
    run: (c, a) => c.history(a),
  }),
  def({
    name: "money_get_period_summary",
    mutating: false,
    description:
      "Month or year summary: cash in/out (internal transfers excluded), economic spending, income, debt payments, card purchases, reimbursements received, waived, by category. Pass month (YYYY-MM) or year.",
    input: { month: z.string().optional(), year: z.number().int().optional() },
    run: (c, a) => c.periodSummary(a),
  }),
  def({
    name: "money_search",
    mutating: false,
    description: "Accent/case-insensitive search across the ledger. Digits also match amounts in minor units (e.g. '1250' finds $12.50).",
    input: { q: z.string(), from_date: z.string().optional(), to_date: z.string().optional(), limit: z.number().int().optional() },
    run: (c, a) => c.search(a),
  }),
  def({
    name: "money_get_notes",
    mutating: false,
    description: "Notes pinned to the report, with their ids, newest first. Archived ones only with include_archived.",
    input: { include_archived: z.boolean().optional() },
    run: (c, a) => c.notes(a),
  }),
  def({
    name: "money_render_report",
    mutating: false,
    description: "Render the Money Truths report. format: json (view model — best for answering questions), markdown, or html. month defaults to the current month.",
    input: { month: z.string().optional(), format: z.enum(["html", "json", "markdown"]).optional() },
    run: async (c, a) => {
      const { loadView } = await import("./core/report-data.ts");
      const view = await loadView(c);
      if (a.format === "html") {
        const { renderReport } = await import("./report.ts");
        return { html: await renderReport(c, new URL(`https://ledger/?m=${a.month ?? view.asOf.slice(0, 7)}`)) };
      }
      if (a.format === "markdown") {
        const { viewMarkdown } = await import("./markdown.ts");
        return { markdown: viewMarkdown(view, await c.periodSummary({ month: a.month ?? view.asOf.slice(0, 7) })) };
      }
      return view;
    },
  }),

  // ---- setup by chat ------------------------------------------------------------
  def({
    name: "money_create_person",
    mutating: true,
    description:
      "Add someone the user shares money with (partner, parent, roommate, friend) so purchases can be split with them, money they owe can be tracked, and money held for them is never counted as the user's. Returns the person's id.",
    input: { idempotency_key: key, name: z.string().min(1), person_id: z.string().optional().describe("Optional short id; defaults to a slug of the name.") },
    run: (c, a) => c.createPerson(a),
  }),
  def({
    name: "money_create_account",
    mutating: true,
    description:
      "Add an account during setup or later. type: bank | cash | wallet | savings (money the user has), credit_card | loan | personal_debt (money they owe; balance_minor is the positive amount owed), owed_to_me (money a person owes them; needs owner_id). balance_minor is what the bank/app shows right now — it becomes the starting checkpoint, never income. Leave it out if unknown. Ask the user for each account's current balance rather than guessing.",
    input: {
      idempotency_key: key,
      name: z.string().min(1).describe("What the user calls it, e.g. 'Chase checking', 'Visa', 'Car loan'."),
      type: z.enum(["bank", "cash", "wallet", "savings", "credit_card", "loan", "personal_debt", "owed_to_me"]),
      currency: currency.optional().describe("Defaults to the ledger's main currency."),
      owner_id: z.string().nullable().optional().describe("For owed_to_me: who owes. For bank/cash/wallet/savings: set only if the money belongs to someone else."),
      institution: z.string().nullable().optional().describe("Bank or lender name, e.g. 'Chase'."),
      last4: z.string().nullable().optional().describe("Last 4 digits only. Never a full number."),
      balance_minor: z.number().int().nullable().optional().describe("Current balance in minor units; for debts, the positive amount owed."),
      as_of: z.string().nullable().optional().describe("When that balance was true; defaults to now."),
      credit_limit_minor: z.number().int().nullable().optional().describe("Credit cards only."),
      installment_minor: z.number().int().nullable().optional().describe("Loans: the regular payment."),
      installments_paid: z.number().int().nullable().optional(),
      installments_total: z.number().int().nullable().optional(),
      rate: z.string().nullable().optional().describe("Interest rate as text, e.g. '24.9% APR'."),
      color: z.string().nullable().optional().describe("Optional #rrggbb for the report."),
      notes: z.string().nullable().optional(),
    },
    run: (c, a) => c.createAccount(a),
  }),

  // ---- writes ---------------------------------------------------------------------
  def({
    name: "money_record_income",
    mutating: true,
    description: "Money the user earned or received into one of their accounts (salary, freelance, gifts). Not for reimbursements (money_record_reimbursement_received) or someone else's money passing through (money_record_pass_through).",
    input: { idempotency_key: key, occurred_at: when, amount_minor: minor, currency, destination_account_id: account("Receiving"), source: z.string(), category: z.string().optional(), notes, expected_inflow_id: z.string().nullable().optional().describe("Marks this expected inflow received.") },
    run: (c, a) => c.recordIncome(a),
  }),
  def({
    name: "money_record_expense",
    mutating: true,
    description:
      "A purchase/payment. payment_account_id may be a bank/cash account or a card. If someone owes part back, set reimbursable_minor + reimbursable_from_owner_id. If the paying account isn't known, omit it: a DRAFT is saved and nothing changes until money_complete_draft.",
    input: { idempotency_key: key, occurred_at: when, amount_minor: minor, currency, payment_account_id: z.string().nullable().optional(), category: z.string(), description: z.string(), reimbursable_minor: z.number().int().optional(), reimbursable_from_owner_id: z.string().nullable().optional(), notes },
    run: (c, a) => c.recordExpense(a),
  }),
  def({
    name: "money_record_split_purchase",
    mutating: true,
    description: "One gross purchase split by who it was for (the user, a partner, a roommate...). Splits must add up to the gross exactly. Reimbursable splits owned by someone else become a receivable. Recorded as ONE transaction.",
    input: {
      idempotency_key: key,
      occurred_at: when,
      gross_amount_minor: minor,
      payment_account_id: account("Paying (bank, cash or card)"),
      splits: z.array(z.object({ label: z.string(), amount_minor: z.number().int(), economic_owner_id: z.string().describe("Person id (see money_create_person); the user's own id is in money_get_snapshot me.id"), reimbursable: z.boolean() })),
      description: z.string(),
      category: z.string().optional(),
      notes,
    },
    run: (c, a) => c.recordSplitPurchase(a),
  }),
  def({
    name: "money_record_transfer",
    mutating: true,
    description: "Move money between two of the SAME owner's accounts (e.g. checking → cash). Not income, not spending. Moving money into checking 'for the card bill' is only a transfer — the card stays unpaid until a card payment is recorded.",
    input: { idempotency_key: key, occurred_at: when, amount_minor: minor, currency, from_account_id: account("Source"), to_account_id: account("Destination"), notes },
    run: (c, a) => c.recordTransfer(a),
  }),
  def({
    name: "money_record_cash_swap",
    mutating: true,
    description: "Bank↔cash swap, including with a person (the user sends someone a transfer and gets the same cash back). Both legs are the user's accounts; net worth unchanged.",
    input: { idempotency_key: key, occurred_at: when, amount_minor: minor, from_account_id: account("Source"), to_account_id: account("Destination"), counterparty_owner_id: z.string().nullable().optional(), notes },
    run: (c, a) => c.recordCashSwap(a),
  }),
  def({
    name: "money_record_card_purchase",
    mutating: true,
    description: "A charge on a credit card: spending and card debt go up, cash doesn't move.",
    input: { idempotency_key: key, occurred_at: when, card_account_id: account("Card"), amount_minor: minor, category: z.string(), description: z.string(), reimbursable_minor: z.number().int().optional(), reimbursable_from_owner_id: z.string().nullable().optional(), notes },
    run: (c, a) => c.recordCardPurchase(a),
  }),
  def({
    name: "money_record_card_payment",
    mutating: true,
    description: "A CONFIRMED payment to a card: cash and card debt go down. Not new spending. Pass obligation_id to mark the minimum paid in the same step.",
    input: { idempotency_key: key, occurred_at: when, card_account_id: account("Card"), funding_account_id: account("Paying"), amount_minor: minor, obligation_id: z.string().nullable().optional(), notes },
    run: (c, a) => c.recordCardPayment(a),
  }),
  def({
    name: "money_record_reimbursement_received",
    mutating: true,
    description: "Someone paid back what they owed the user. Settles the receivable; never income. receivable_id may be the person's id (e.g. 'alex') or the account id (e.g. 'recv_alex_USD'). To forgive a small remainder, add waive_minor + waive_reason.",
    input: { idempotency_key: key, occurred_at: when, receivable_id: z.string(), destination_account_id: account("Receiving"), amount_minor: z.number().int(), waive_minor: z.number().int().optional(), waive_reason: z.string().optional(), notes },
    run: (c, a) => c.recordReimbursementReceived(a),
  }),
  def({
    name: "money_set_balance_checkpoint",
    mutating: true,
    description: "A fresh balance the user reported (screenshot, statement, cash count). It becomes authoritative. If it disagrees with the ledger a reconciliation issue opens — never invent a transaction to explain it.",
    input: { idempotency_key: key, account_id: account("Reported"), as_of: when, reported_balance_minor: z.number().int(), source_kind: z.enum(["user", "screenshot", "statement", "import"]), source_ref: z.string().nullable().optional(), notes },
    run: (c, a) => c.setBalanceCheckpoint(a),
  }),
  def({
    name: "money_set_card_snapshot",
    mutating: true,
    description: "Fresh card screen: debt becomes authoritative (reconciliation issue if it differs; don't assume interest), plus available credit, limit, minimum and due date.",
    input: { idempotency_key: key, card_account_id: account("Card"), as_of: when, debt_minor: z.number().int(), available_credit_minor: z.number().int().nullable().optional(), credit_limit_minor: z.number().int().nullable().optional(), minimum_minor: z.number().int().nullable().optional(), minimum_due_date: z.string().nullable().optional(), statement_close_date: z.string().nullable().optional(), source_ref: z.string().nullable().optional() },
    run: (c, a) => c.setCardSnapshot(a),
  }),
  def({
    name: "money_upsert_obligation",
    mutating: true,
    description: "Create or edit something that must be paid (not a payment itself). Use money_mark_obligation_paid when money actually moves.",
    input: {
      idempotency_key: key,
      obligation_id: z.string().nullable().optional(),
      name: z.string(),
      amount_minor: z.number().int(),
      currency,
      due_date: z.string().nullable().optional(),
      kind: z.enum(["card_minimum", "loan", "utility", "tax", "family_debt", "subscription", "other"]),
      linked_account_id: z.string().nullable().optional(),
      status: z.enum(["planned", "pending", "paid", "cancelled", "disputed"]),
      confidence: z.enum(["confirmed", "working", "inferred"]),
      notes,
    },
    run: (c, a) => c.upsertObligation(a),
  }),
  def({
    name: "money_mark_obligation_paid",
    mutating: true,
    description: "Atomically record the payment AND mark the obligation paid (and spend any linked reservation). Card/loan/personal-debt payments reduce what's owed; bills are expenses.",
    input: { idempotency_key: key, obligation_id: z.string(), paid_at: when, funding_account_id: account("Paying"), actual_amount_minor: z.number().int().nullable().optional(), notes },
    run: (c, a) => c.markObligationPaid(a),
  }),
  def({
    name: "money_add_expected_inflow",
    mutating: true,
    description: "Money that may arrive later. Never affects balances or free money. Record it with money_record_income (expected_inflow_id) when it lands.",
    input: { idempotency_key: key, source: z.string(), amount_minor: z.number().int().nullable().optional(), currency, expected_from: z.string().nullable().optional(), expected_to: z.string().nullable().optional(), status: z.enum(["scenario", "expected", "confirmed_arrangement"]), confidence: z.string().optional(), notes },
    run: (c, a) => c.addExpectedInflow(a),
  }),
  def({
    name: "money_reserve_funds",
    mutating: true,
    description: "Earmark money that exists but isn't free (e.g. $300 in checking held for rent). Bank balance unchanged; free money goes down.",
    input: { idempotency_key: key, label: z.string(), amount_minor: minor, currency, account_id: z.string().nullable().optional(), obligation_id: z.string().nullable().optional(), due_date: z.string().nullable().optional() },
    run: (c, a) => c.reserveFunds(a),
  }),
  def({
    name: "money_resolve_reconciliation",
    mutating: true,
    description: "Close a reconciliation issue once explained: identified_transaction (link it), accept_checkpoint (the reported number simply wins), or other.",
    input: { idempotency_key: key, issue_id: z.string(), resolution_type: z.enum(["identified_transaction", "accept_checkpoint", "other"]), explanation: z.string(), transaction_id: z.string().nullable().optional() },
    run: (c, a) => c.resolveReconciliation(a),
  }),
  def({
    name: "money_reverse_transaction",
    mutating: true,
    description: "Undo a wrong transaction with an opposite entry dated now. The original stays in history, marked reversed. Nothing is ever deleted.",
    input: { idempotency_key: key, transaction_id: z.string(), reason: z.string() },
    run: (c, a) => c.reverseTransaction(a),
  }),
  def({
    name: "money_close_month",
    mutating: true,
    description: "Freeze a finished month: end balances, obligations, open issues and summary become an immutable export. Later entries dated in that month are refused.",
    input: { idempotency_key: key, month: z.string(), notes },
    run: async (c, a) => {
      const { renderClosedMonth } = await import("./report-closed.ts");
      return c.closeMonth(a, renderClosedMonth);
    },
  }),

  // ---- more writes ----------------------------------------------------------------
  def({
    name: "money_record_pass_through",
    mutating: true,
    description: "Someone else's money passing through the user's account (e.g. a roommate sends their share of rent for the user to forward). Record direction 'in' when it arrives and 'out' when it leaves. Never income or spending.",
    input: { idempotency_key: key, occurred_at: when, amount_minor: minor, account_id: account("The user's"), owner_id: z.string().describe("Whose money it is (person id)"), direction: z.enum(["in", "out"]), counterparty: z.string().optional(), notes },
    run: (c, a) => c.recordPassThrough(a),
  }),
  def({
    name: "money_complete_draft",
    mutating: true,
    description: "Finish a draft expense once the paying account is known.",
    input: { idempotency_key: key, transaction_id: z.string(), payment_account_id: account("Paying") },
    run: (c, a) => c.completeDraft(a),
  }),
  def({
    name: "money_record_batch",
    mutating: true,
    description: "Several movements, all-or-nothing. items: [{tool, args}] using income, expense, card purchase, split purchase, transfer, reimbursement, pass-through or obligation-paid tools. Item keys are derived from the batch key.",
    input: { idempotency_key: key, items: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()) })) },
    run: (c, a) => c.recordBatch(a as never),
  }),
  def({
    name: "money_set_field",
    mutating: true,
    description: "Add, change or remove (value: null) a free-form field on any account, obligation, transaction, expected inflow, reservation, recurring rule or reconciliation issue — for organising, tagging, notes. Never changes money.",
    input: { idempotency_key: key, entity_type: z.string(), entity_id: z.string(), key: z.string(), value: z.unknown() },
    run: (c, a) => c.setField(a),
  }),
  def({
    name: "money_update_note",
    mutating: true,
    description: "Edit a note's text and/or archive (archived: true) or unarchive it. Ids from money_get_notes.",
    input: { idempotency_key: key, note_id: z.string(), body: z.string().optional(), archived: z.boolean().optional() },
    run: (c, a) => c.updateNote(a),
  }),
  def({
    name: "money_update_reservation",
    mutating: true,
    description: "Change an active reservation's label, amount or due date — or release/cancel it (status) when the money no longer needs holding. Payments draw reservations down on their own.",
    input: { idempotency_key: key, reservation_id: z.string(), label: z.string().optional(), amount_minor: z.number().int().optional(), due_date: z.string().nullable().optional(), status: z.enum(["released", "cancelled"]).optional() },
    run: (c, a) => c.updateReservation(a),
  }),
  def({
    name: "money_update_expected_inflow",
    mutating: true,
    description: "Change an expected inflow (amount, dates, confidence, notes) or cancel it (status: cancelled) when it won't arrive. Never affects balances. When the money lands, use money_record_income with expected_inflow_id instead.",
    input: {
      idempotency_key: key,
      expected_inflow_id: z.string(),
      source: z.string().optional(),
      amount_minor: z.number().int().nullable().optional(),
      currency: currency.optional(),
      expected_from: z.string().nullable().optional(),
      expected_to: z.string().nullable().optional(),
      status: z.enum(["scenario", "expected", "confirmed_arrangement", "cancelled"]).optional(),
      confidence: z.string().nullable().optional(),
      notes: z.string().nullable().optional(),
    },
    run: (c, a) => c.updateExpectedInflow(a),
  }),
  def({
    name: "money_upsert_recurring_rule",
    mutating: true,
    description: "Add or edit a recurring rule (subscription, contribution, family support...). For an existing rule pass only what changes, e.g. { rule_id, active: false } to pause or cancel a subscription. New rules need name, owner_id, currency, cadence (weekly|biweekly|monthly|quarterly|yearly) and kind. Plans only — no balance changes.",
    input: {
      idempotency_key: key,
      rule_id: z.string().nullable().optional(),
      name: z.string().optional(),
      owner_id: z.string().optional(),
      amount_minor: z.number().int().nullable().optional(),
      currency: currency.optional(),
      cadence: z.string().optional(),
      next_due_date: z.string().nullable().optional(),
      end_date: z.string().nullable().optional(),
      kind: z.string().optional(),
      active: z.boolean().optional(),
      confidence: z.string().optional(),
      notes: z.string().nullable().optional(),
    },
    run: (c, a) => c.upsertRecurringRule(a),
  }),
  def({
    name: "money_update_account",
    mutating: true,
    description: "Rename an account, update institution/last4/notes, or close/reopen it (active). Closing is refused while it still has a balance, open obligations or reservations — money never disappears from totals. last4 only; never full numbers.",
    input: { idempotency_key: key, account_id: z.string(), name: z.string().optional(), institution: z.string().nullable().optional(), last4: z.string().nullable().optional(), notes: z.string().nullable().optional(), active: z.boolean().optional() },
    run: (c, a) => c.updateAccount(a),
  }),
  def({
    name: "money_add_note",
    mutating: true,
    description: "Pin a short note to the report's notes section (reminders, goals, encouragement).",
    input: { idempotency_key: key, author: z.string(), icon: z.string().optional(), body: z.string() },
    run: (c, a) => c.addNote(a),
  }),
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/** Validate and run a tool by name. Returns { ok, result } or { ok: false, error }. */
export async function callTool(core: Core, name: string, args: unknown, opts: { readOnly: boolean }): Promise<{ ok: true; result: unknown } | { ok: false; error: string; status: number }> {
  const tool = findTool(name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}".`, status: 404 };
  if (tool.mutating && opts.readOnly) return { ok: false, error: "This token is read-only.", status: 403 };
  const parsed = z.object(tool.input).safeParse(args ?? {});
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; "), status: 400 };
  try {
    return { ok: true, result: await tool.run(core, parsed.data) };
  } catch (e) {
    const err = e as Error;
    if (err.name === "LedgerError") return { ok: false, error: err.message, status: 422 };
    throw e;
  }
}
