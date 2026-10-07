import type { Db, Param, Stmt } from "../db.ts";
import { LedgerError, dateRangeBounds, localDate, localMonth, monthBounds, toInstant } from "./time.ts";
import { fmt, isCurrencyCode } from "../money.ts";

export { LedgerError } from "./time.ts";

// The Money Truths service. Owns every accounting rule in
// docs/ACCOUNTING_RULES.md; MCP tools, the HTTP API, the report, the cards and
// the widget are thin clients.
//
// "You" are the primary owner (owners.is_primary = 1). Liquidity and free money
// count only your liquid accounts in the base currency; other owners' money and
// other currencies are tracked but never added in.
//
// Balance model: an account's balance is its newest accepted
// checkpoint plus postings dated after that checkpoint. A fresh checkpoint that
// disagrees with that figure opens a reconciliation issue; it never invents a
// transaction.

export interface CoreOptions {
  timezone: string;
  /** ISO 4217 code of the main currency, e.g. "USD". */
  baseCurrency: string;
  /** Recorded in the audit log: "mcp", "api", "seed", "test"... */
  actor?: string;
  now?: () => Date;
}

export type Side = "debit" | "credit";

export interface AccountRow {
  id: string;
  owner_id: string;
  name: string;
  institution: string | null;
  account_type: "asset" | "liability" | "receivable" | "payable" | "income" | "expense" | "equity";
  normal_side: Side;
  currency: string;
  is_liquid: number;
  include_in_owner_total: number;
  active: number;
  last4: string | null;
  notes: string | null;
}

export interface AccountBalance extends AccountRow {
  is_primary: number;
  balance_minor: number;
  checkpoint_as_of: string | null;
}

export interface Posting {
  account_id: string;
  side: Side;
  amount_minor: number;
  memo?: string;
}

/** What a transaction is, stored in transactions.source_kind. */
export type TxnKind =
  | "income"
  | "expense"
  | "card_purchase"
  | "transfer"
  | "cash_swap"
  | "debt_payment"
  | "bill_payment"
  | "reimbursement"
  | "waiver"
  | "passthrough"
  | "reversal";

export interface BalanceReport {
  accounts: { id: string; name: string; currency: string; balance_minor: number }[];
  currency: string;
  liquid: number;
  free: number;
}

export interface MutationResult {
  ok: true;
  replayed: boolean;
  summary: string;
  transaction_id: string | null;
  audit_id: string;
  entity: { type: string; id: string } | null;
  before: BalanceReport;
  after: BalanceReport;
  obligations_changed: unknown[];
  reconciliation_issues: unknown[];
  warnings: string[];
}

interface Plan {
  action: string;
  /** What changed, in words. Balance movement is appended automatically. */
  summary: string;
  stmts: Stmt[];
  transactionId?: string | null;
  accounts: string[];
  occurredAt?: string;
  obligationsChanged?: unknown[];
  issues?: unknown[];
  warnings?: string[];
  entity?: { type: string; id: string } | null;
  payload: unknown;
}

/** Posted (non-reversed) payments applied to obligation `o`. */
export const PAID_SQL =
  "COALESCE((SELECT SUM(op.amount_minor) FROM obligation_payments op JOIN transactions tx ON tx.id = op.transaction_id WHERE op.obligation_id = o.id AND tx.status = 'posted'), 0)";

/**
 * What is still owed on obligation `o`. Paid or cancelled means nothing is owed,
 * even when it was settled before the ledger existed and has no payment rows.
 */
const REMAINING_SQL = `CASE WHEN o.status IN ('paid','cancelled') THEN 0 ELSE MAX(o.amount_minor - ${PAID_SQL}, 0) END`;

const CARD_WORDS = /\b(amex|visa|master ?card|card|tarjeta|minimum|m[ií]nimo)\b/i;

export class Core {
  readonly db: Db;
  readonly tz: string;
  readonly base: string;
  readonly actor: string;
  private readonly clock: () => Date;

  constructor(db: Db, opts: CoreOptions) {
    this.db = db;
    this.tz = opts.timezone;
    this.base = opts.baseCurrency;
    this.actor = opts.actor ?? "unknown";
    this.clock = opts.now ?? (() => new Date());
  }

  now(): string {
    return this.clock().toISOString();
  }

  today(): string {
    return localDate(this.now(), this.tz);
  }

  async describe(): Promise<string> {
    const row = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM accounts");
    return `${row?.n ?? 0} accounts · tz ${this.tz}`;
  }

  // =========================================================================
  // Accounts & balances
  // =========================================================================

  async account(id: string): Promise<AccountRow> {
    if (!id) throw new LedgerError("An account id is required.");
    const row = await this.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ?", [id]);
    if (!row) {
      const known = await this.db.all<{ id: string }>(
        "SELECT id FROM accounts WHERE active = 1 AND account_type IN ('asset','liability','receivable','payable') ORDER BY id",
      );
      if (!known.length) {
        throw new LedgerError(
          `Unknown account "${id}": this ledger has no accounts yet. Set it up first — ask the user which accounts, cards and loans they have and create each with money_create_account (call money_get_snapshot for the getting_started steps).`,
        );
      }
      throw new LedgerError(`Unknown account "${id}". Known accounts: ${known.map((k) => k.id).join(", ")}.`);
    }
    return row;
  }

  private async owner(id: string): Promise<{ id: string; name: string; is_primary: number }> {
    const row = await this.db.get<{ id: string; name: string; is_primary: number }>("SELECT * FROM owners WHERE id = ?", [id]);
    if (!row) throw new LedgerError(`Unknown owner "${id}".`);
    return row;
  }

  /** Every account with its balance at `at` (default now). One query. */
  async allBalances(at?: string): Promise<AccountBalance[]> {
    const t = at ?? this.now();
    const rows = await this.db.all<AccountRow & { is_primary: number; cp_balance: number | null; cp_as_of: string | null; delta: number }>(
      `WITH cp AS (
         SELECT account_id, balance_minor, as_of FROM (
           SELECT account_id, balance_minor, as_of,
                  ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of DESC, id DESC) AS rn
           FROM balance_checkpoints WHERE accepted = 1 AND as_of <= ?
         ) WHERE rn = 1
       )
       SELECT a.*, o.is_primary, cp.balance_minor AS cp_balance, cp.as_of AS cp_as_of,
         COALESCE((
           SELECT SUM(CASE WHEN p.side = 'debit' THEN p.amount_minor ELSE -p.amount_minor END)
           FROM postings p JOIN transactions t ON t.id = p.transaction_id
           WHERE p.account_id = a.id AND t.status <> 'draft'
             AND t.occurred_at > COALESCE(cp.as_of, '') AND t.occurred_at <= ?
         ), 0) AS delta
       FROM accounts a
       JOIN owners o ON o.id = a.owner_id
       LEFT JOIN cp ON cp.account_id = a.id
       ORDER BY a.id`,
      [t, t],
    );
    return rows.map((r) => ({
      ...r,
      balance_minor: (r.cp_balance ?? 0) + (r.normal_side === "debit" ? r.delta : -r.delta),
      checkpoint_as_of: r.cp_as_of,
    }));
  }

  async balanceOf(accountId: string, at?: string): Promise<number> {
    const all = await this.allBalances(at);
    const a = all.find((x) => x.id === accountId);
    if (!a) throw new LedgerError(`Unknown account "${accountId}".`);
    return a.balance_minor;
  }

  /** Your liquid, included asset accounts in the base currency. */
  readonly isMyLiquid = (a: AccountBalance): boolean =>
    a.is_primary === 1 && a.account_type === "asset" && a.is_liquid === 1 && a.include_in_owner_total === 1 && a.currency === this.base;

  private primaryId: string | null = null;

  /** Id of the primary owner ("you"). */
  async me(): Promise<string> {
    if (this.primaryId) return this.primaryId;
    const row = await this.db.get<{ id: string }>("SELECT id FROM owners WHERE is_primary = 1 ORDER BY rowid LIMIT 1");
    if (!row) throw new LedgerError("Money Truths isn't set up yet — open the setup page first.");
    this.primaryId = row.id;
    return row.id;
  }

  async activeReservations(): Promise<number> {
    const row = await this.db.get<{ s: number | null }>(
      `SELECT SUM(r.amount_minor) AS s FROM reservations r
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN owners o ON o.id = a.owner_id
       WHERE r.status = 'active' AND r.currency = ? AND (r.account_id IS NULL OR o.is_primary = 1)`,
      [this.base],
    );
    return row?.s ?? 0;
  }

  private async balanceReport(ids: string[], all?: AccountBalance[]): Promise<BalanceReport> {
    const balances = all ?? (await this.allBalances());
    const liquid = balances.filter(this.isMyLiquid).reduce((s, a) => s + a.balance_minor, 0);
    const reserved = await this.activeReservations();
    return {
      accounts: ids
        .map((id) => balances.find((b) => b.id === id))
        .filter((b): b is AccountBalance => !!b)
        .map((b) => ({ id: b.id, name: b.name, currency: b.currency, balance_minor: b.balance_minor })),
      currency: this.base,
      liquid,
      free: liquid - reserved,
    };
  }

  // =========================================================================
  // Mutation pipeline: idempotency → plan → closed-month guard → one atomic
  // batch (+ audit + idempotency record) → before/after report.
  // =========================================================================

  private async mutate(key: unknown, action: string, build: () => Promise<Plan>): Promise<MutationResult> {
    const k = requireKey(key);
    const prior = await this.db.get<{ action: string; result_json: string }>(
      "SELECT action, result_json FROM idempotency_keys WHERE key = ?",
      [k],
    );
    if (prior) return this.replay(k, action, prior);

    const plan = await build();
    if (plan.occurredAt) await this.assertMonthOpen(plan.occurredAt);
    return this.commit(k, [plan]);
  }

  private async commit(key: string, plans: Plan[]): Promise<MutationResult> {
    const before = await this.allBalances();
    const auditId = newId("aud");
    const now = this.now();
    const action = plans.length === 1 ? plans[0].action : "money_record_batch";
    const txIds = plans.map((p) => p.transactionId).filter((x): x is string => !!x);
    const entity = plans.length === 1 ? (plans[0].entity ?? null) : { type: "batch", id: key };
    const summary = plans.map((p) => p.summary).join(" ");
    const stored = { transaction_id: txIds[0] ?? null, transaction_ids: txIds, audit_id: auditId, entity, summary };

    const stmts: Stmt[] = [
      ...plans.flatMap((p) => p.stmts),
      {
        sql: "INSERT INTO audit_log (id, occurred_at, actor, action, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params: [
          auditId,
          now,
          this.actor,
          action,
          entity?.type ?? null,
          entity?.id ?? null,
          JSON.stringify({ idempotency_key: key, transaction_ids: txIds, payload: plans.map((p) => p.payload) }),
        ],
      },
      {
        sql: "INSERT INTO idempotency_keys (key, action, result_json, created_at) VALUES (?, ?, ?, ?)",
        params: [key, action, JSON.stringify(stored), now],
      },
    ];

    try {
      await this.db.batch(stmts);
    } catch (e) {
      // A concurrent retry with the same key may have won the race.
      const prior = await this.db.get<{ action: string; result_json: string }>(
        "SELECT action, result_json FROM idempotency_keys WHERE key = ?",
        [key],
      );
      if (prior) return this.replay(key, action, prior);
      throw e;
    }

    const after = await this.allBalances();
    const ids = [...new Set(plans.flatMap((p) => p.accounts))];
    const beforeR = await this.balanceReport(ids, before);
    const afterR = await this.balanceReport(ids, after);
    const issues = plans.flatMap((p) => p.issues ?? []);
    return {
      ok: true,
      replayed: false,
      summary: composeSummary(summary, beforeR, afterR, issues),
      transaction_id: stored.transaction_id,
      audit_id: auditId,
      entity,
      before: beforeR,
      after: afterR,
      obligations_changed: plans.flatMap((p) => p.obligationsChanged ?? []),
      reconciliation_issues: issues,
      warnings: plans.flatMap((p) => p.warnings ?? []),
    };
  }

  private async replay(key: string, action: string, prior: { action: string; result_json: string }): Promise<MutationResult> {
    if (prior.action !== action) {
      throw new LedgerError(`idempotency_key "${key}" was already used for ${prior.action}; use a new key for a different action.`);
    }
    const stored = JSON.parse(prior.result_json);
    const now = await this.balanceReport([]);
    return {
      ok: true,
      replayed: true,
      summary: `Already recorded under this idempotency key — nothing changed. (${stored.summary})`,
      transaction_id: stored.transaction_id ?? null,
      audit_id: stored.audit_id,
      entity: stored.entity ?? null,
      before: now,
      after: now,
      obligations_changed: [],
      reconciliation_issues: [],
      warnings: [],
    };
  }

  private async assertMonthOpen(iso: string): Promise<void> {
    const month = localMonth(iso, this.tz);
    const closed = await this.db.get("SELECT month FROM month_closures WHERE month = ?", [month]);
    if (closed) {
      throw new LedgerError(
        `${month} is closed. Its export is immutable; record a correction dated in an open month (e.g. a reversal today) instead.`,
      );
    }
  }

  /** Statements for one balanced journal entry. Validates balance, currency and amounts. */
  private async txnStmts(
    t: { id: string; occurredAt: string; description: string; category?: string | null; key: string; kind: TxnKind; action: string; notes?: string | null; status?: "posted" | "draft" },
    postings: Posting[],
  ): Promise<Stmt[]> {
    if (t.status !== "draft") {
      if (postings.length < 2) throw new LedgerError("A transaction needs at least two postings.");
      let debit = 0;
      let credit = 0;
      const currencies = new Set<string>();
      for (const p of postings) {
        if (!Number.isInteger(p.amount_minor) || p.amount_minor <= 0) throw new LedgerError("Posting amounts must be positive integers.");
        if (p.side === "debit") debit += p.amount_minor;
        else credit += p.amount_minor;
        currencies.add(await this.currencyOf(p.account_id));
      }
      if (debit !== credit) throw new LedgerError(`Unbalanced entry: debits ${debit} ≠ credits ${credit}.`);
      if (currencies.size > 1) {
        throw new LedgerError(`One entry can't mix currencies (${[...currencies].join(" + ")}). Record FX conversions explicitly as two legs.`);
      }
    }
    return [
      {
        sql: `INSERT INTO transactions (id, occurred_at, description, category, status, idempotency_key, source_kind, source_ref, notes, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [t.id, t.occurredAt, t.description, t.category ?? null, t.status ?? "posted", t.key, t.kind, t.action, t.notes ?? null, this.now()],
      },
      ...postings.map((p) => ({
        sql: "INSERT INTO postings (transaction_id, account_id, side, amount_minor, memo) VALUES (?, ?, ?, ?, ?)",
        params: [t.id, p.account_id, p.side, p.amount_minor, p.memo ?? null] as Param[],
      })),
    ];
  }

  private pendingAccounts = new Map<string, string>();

  private async currencyOf(accountId: string): Promise<string> {
    const pending = this.pendingAccounts.get(accountId);
    if (pending) return pending;
    const acc = await this.account(accountId);
    if (!acc.active) throw new LedgerError(`${acc.name} is closed. Reopen it with money_update_account (active: true) before recording against it.`);
    return acc.currency;
  }

  /**
   * System accounts are created lazily, inside the same batch as the entry
   * that first needs them: exp_<owner>_<CUR>, inc_<owner>_<CUR>,
   * recv_<owner>_<CUR> (owed to you), clear_<owner>_<CUR> (pass-through).
   * All are yours; `subject` is the other person for recv/clear.
   */
  private async systemAccount(
    kind: "exp" | "inc" | "recv" | "clear",
    subject: string | null,
    currency: string,
  ): Promise<{ id: string; stmt: Stmt }> {
    const mine = await this.me();
    const who = subject ?? mine;
    const id = `${kind}_${who}_${currency}`;
    const spec = {
      exp: ["Expenses", "expense", "debit"],
      inc: ["Income", "income", "credit"],
      recv: ["Owed to you by", "receivable", "debit"],
      clear: ["Pass-through for", "payable", "credit"],
    }[kind];
    let label = who;
    if (kind === "recv" || kind === "clear") label = (await this.db.get<{ name: string }>("SELECT name FROM owners WHERE id = ?", [who]))?.name ?? who;
    const name = kind === "recv" || kind === "clear" ? `${spec[0]} ${label} (${currency})` : `${spec[0]} (${currency})`;
    this.pendingAccounts.set(id, currency);
    return {
      id,
      stmt: {
        sql: `INSERT OR IGNORE INTO accounts (id, owner_id, name, institution, account_type, normal_side, currency, is_liquid, include_in_owner_total, active, notes)
              VALUES (?, ?, ?, NULL, ?, ?, ?, 0, 1, 1, 'system account')`,
        params: [id, mine, name, spec[1], spec[2], currency],
      },
    };
  }

  private async instant(input: unknown, field: string, affected: string[], warnings: string[]): Promise<string> {
    if (typeof input !== "string" || !input) throw new LedgerError(`${field} is required (ISO date or datetime).`);
    const inst = toInstant(input, this.tz);
    if (inst.iso > this.now()) {
      warnings.push(`Dated in the future (${localDate(inst.iso, this.tz)}): it won't show in balances until then.`);
    }
    const balances = await this.allBalances();
    for (const id of affected) {
      const cp = balances.find((b) => b.id === id)?.checkpoint_as_of;
      if (!cp) continue;
      if (inst.iso <= cp) {
        warnings.push(
          `Dated at or before ${id}'s latest checkpoint (${localDate(cp, this.tz)}): that checkpoint already reflects it, so the balance doesn't change. Recorded for history.`,
        );
      } else if (inst.dateOnly && localDate(cp, this.tz) === localDate(inst.iso, this.tz)) {
        warnings.push(
          `Same day as ${id}'s checkpoint and no time given — assumed after the checkpoint. Pass a time if the checkpoint already included it.`,
        );
      }
    }
    return inst.iso;
  }

  // =========================================================================
  // Mutations — one per tool in src/tools.ts
  // =========================================================================

  async recordIncome(a: {
    idempotency_key: string;
    occurred_at: string;
    amount_minor: number;
    currency: string;
    destination_account_id: string;
    source: string;
    category?: string;
    notes?: string;
    expected_inflow_id?: string | null;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_income", () => this.planIncome(a));
  }

  private async planIncome(a: Parameters<Core["recordIncome"]>[0], keyOverride?: string): Promise<Plan> {
    const amount = positiveInt(a.amount_minor, "amount_minor");
    const dest = await this.account(a.destination_account_id);
    await this.requireMyAsset(dest, "destination_account_id");
    requireCurrency(dest, a.currency);
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.occurred_at, "occurred_at", [dest.id], warnings);
    const inc = await this.systemAccount("inc", null, dest.currency);
    const id = newId("txn");
    const stmts = [
      inc.stmt,
      ...(await this.txnStmts(
        { id, occurredAt, description: `${a.source}`, category: a.category ?? "income", key: keyOverride ?? a.idempotency_key, kind: "income", action: "money_record_income", notes: a.notes },
        [
          { account_id: dest.id, side: "debit", amount_minor: amount },
          { account_id: inc.id, side: "credit", amount_minor: amount },
        ],
      )),
    ];
    if (a.expected_inflow_id) {
      const exp = await this.db.get<{ id: string; status: string }>("SELECT id, status FROM expected_inflows WHERE id = ?", [a.expected_inflow_id]);
      if (!exp) throw new LedgerError(`Unknown expected inflow "${a.expected_inflow_id}".`);
      stmts.push({ sql: "UPDATE expected_inflows SET status = 'received', received_transaction_id = ? WHERE id = ?", params: [id, exp.id] });
    }
    return {
      action: "money_record_income",
      summary: `Recorded ${a.source} +${money(amount, dest.currency)} to ${dest.name}.`,
      stmts,
      transactionId: id,
      accounts: [dest.id],
      occurredAt,
      warnings,
      entity: { type: "transaction", id },
      payload: a,
    };
  }

  async recordExpense(a: {
    idempotency_key: string;
    occurred_at: string;
    amount_minor: number;
    currency: string;
    payment_account_id?: string | null;
    category: string;
    description: string;
    reimbursable_minor?: number;
    reimbursable_from_owner_id?: string | null;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_expense", () => this.planExpense(a));
  }

  private async planExpense(a: Parameters<Core["recordExpense"]>[0], keyOverride?: string): Promise<Plan> {
    const amount = positiveInt(a.amount_minor, "amount_minor");
    const reimb = nonNegInt(a.reimbursable_minor ?? 0, "reimbursable_minor");
    if (reimb > amount) throw new LedgerError("reimbursable_minor can't exceed the amount.");
    if (reimb > 0 && !a.reimbursable_from_owner_id) throw new LedgerError("reimbursable_from_owner_id is required when part of it is reimbursable.");
    if (!a.description) throw new LedgerError("description is required.");

    // Test 24: unknown funding account → draft, never a guess.
    if (!a.payment_account_id) {
      const id = newId("txn");
      const occurredAt = toInstant(requireString(a.occurred_at, "occurred_at"), this.tz).iso;
      return {
        action: "money_record_expense",
        summary: `Saved "${a.description}" (${money(amount, a.currency)}) as a DRAFT — no balance changed.`,
        stmts: await this.txnStmts(
          { id, occurredAt, description: a.description, category: a.category, key: keyOverride ?? a.idempotency_key, kind: "expense", action: "money_record_expense", notes: JSON.stringify({ draft: a }), status: "draft" },
          [],
        ),
        transactionId: id,
        accounts: [],
        occurredAt,
        warnings: ["Which account paid for it? Complete the draft with money_complete_draft once that's known."],
        entity: { type: "transaction", id },
        payload: a,
      };
    }

    const pay = await this.account(a.payment_account_id);
    if (pay.account_type === "liability") {
      return this.planCardPurchase(
        { ...a, card_account_id: pay.id, reimbursable_minor: reimb, notes: a.notes },
        keyOverride,
        "money_record_expense",
      );
    }
    await this.requireMyAsset(pay, "payment_account_id");
    requireCurrency(pay, a.currency);
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.occurred_at, "occurred_at", [pay.id], warnings);
    const id = newId("txn");
    const { postings, pre } = await this.expenseLegs(amount, reimb, a.reimbursable_from_owner_id ?? null, pay.currency);
    postings.push({ account_id: pay.id, side: "credit", amount_minor: amount });
    return {
      action: "money_record_expense",
      summary: `Recorded ${a.description} −${money(amount, pay.currency)} from ${pay.name}${reimb ? ` (${money(reimb, pay.currency)} owed back by ${a.reimbursable_from_owner_id}; your cost ${money(amount - reimb, pay.currency)})` : ""}.`,
      stmts: [...pre, ...(await this.txnStmts({ id, occurredAt, description: a.description, category: a.category, key: keyOverride ?? a.idempotency_key, kind: "expense", action: "money_record_expense", notes: a.notes }, postings))],
      transactionId: id,
      accounts: [pay.id, ...(reimb ? [`recv_${a.reimbursable_from_owner_id}_${pay.currency}`] : [])],
      occurredAt,
      warnings,
      entity: { type: "transaction", id },
      payload: a,
    };
  }

  /** Debit legs for a purchase: your economic share to expense, the rest to a receivable (rule G). */
  private async expenseLegs(amount: number, reimb: number, fromOwner: string | null, currency: string): Promise<{ postings: Posting[]; pre: Stmt[] }> {
    const exp = await this.systemAccount("exp", null, currency);
    const postings: Posting[] = [];
    const pre: Stmt[] = [exp.stmt];
    if (amount - reimb > 0) postings.push({ account_id: exp.id, side: "debit", amount_minor: amount - reimb });
    if (reimb > 0) {
      const recv = await this.systemAccount("recv", fromOwner!, currency);
      pre.push(recv.stmt);
      postings.push({ account_id: recv.id, side: "debit", amount_minor: reimb, memo: `owed by ${fromOwner}` });
    }
    return { postings, pre };
  }

  async recordCardPurchase(a: {
    idempotency_key: string;
    occurred_at: string;
    card_account_id: string;
    amount_minor: number;
    category: string;
    description: string;
    reimbursable_minor?: number;
    reimbursable_from_owner_id?: string | null;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_card_purchase", () => this.planCardPurchase(a));
  }

  private async planCardPurchase(
    a: Parameters<Core["recordCardPurchase"]>[0],
    keyOverride?: string,
    action = "money_record_card_purchase",
  ): Promise<Plan> {
    const amount = positiveInt(a.amount_minor, "amount_minor");
    const reimb = nonNegInt(a.reimbursable_minor ?? 0, "reimbursable_minor");
    if (reimb > amount) throw new LedgerError("reimbursable_minor can't exceed the amount.");
    if (reimb > 0 && !a.reimbursable_from_owner_id) throw new LedgerError("reimbursable_from_owner_id is required when part of it is reimbursable.");
    const fromOwner = a.reimbursable_from_owner_id ?? null;
    if (reimb > 0) await this.owner(fromOwner!);
    const card = await this.account(a.card_account_id);
    if (card.account_type !== "liability") throw new LedgerError(`${card.name} isn't a card/liability account.`);
    await this.requireMine(card, "card_account_id");
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.occurred_at, "occurred_at", [card.id], warnings);
    const id = newId("txn");
    const { postings, pre } = await this.expenseLegs(amount, reimb, fromOwner, card.currency);
    postings.push({ account_id: card.id, side: "credit", amount_minor: amount });
    return {
      action,
      summary: `Charged ${a.description} ${money(amount, card.currency)} to ${card.name} — card debt up, cash unchanged${reimb ? `; ${money(reimb, card.currency)} owed back by ${fromOwner}` : ""}.`,
      stmts: [...pre, ...(await this.txnStmts({ id, occurredAt, description: a.description, category: a.category, key: keyOverride ?? a.idempotency_key, kind: "card_purchase", action, notes: a.notes }, postings))],
      transactionId: id,
      accounts: [card.id],
      occurredAt,
      warnings,
      entity: { type: "transaction", id },
      payload: a,
    };
  }

  async recordSplitPurchase(a: {
    idempotency_key: string;
    occurred_at: string;
    gross_amount_minor: number;
    payment_account_id: string;
    splits: { label: string; amount_minor: number; economic_owner_id: string; reimbursable: boolean }[];
    description: string;
    category?: string;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_split_purchase", () => this.planSplitPurchase(a));
  }

  private async planSplitPurchase(a: Parameters<Core["recordSplitPurchase"]>[0], keyOverride?: string): Promise<Plan> {
    const gross = positiveInt(a.gross_amount_minor, "gross_amount_minor");
    if (!Array.isArray(a.splits) || a.splits.length === 0) throw new LedgerError("splits are required.");
    const total = a.splits.reduce((s, x) => s + nonNegInt(x.amount_minor, "splits[].amount_minor"), 0);
    if (total !== gross) {
      throw new LedgerError(`Splits add up to ${total.toLocaleString("en-US")} but the gross is ${gross.toLocaleString("en-US")} — they must match exactly.`);
    }
    const pay = await this.account(a.payment_account_id);
    await this.requireMine(pay, "payment_account_id");
    if (pay.account_type !== "asset" && pay.account_type !== "liability") throw new LedgerError("payment_account_id must be a bank/cash account or a card.");
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.occurred_at, "occurred_at", [pay.id], warnings);
    const id = newId("txn");
    const exp = await this.systemAccount("exp", null, pay.currency);
    const pre: Stmt[] = [exp.stmt];
    const debits = new Map<string, number>();
    for (const s of a.splits) {
      const owner = await this.owner(s.economic_owner_id);
      if (owner.is_primary || !s.reimbursable) {
        // Your/household share, or someone else's share you absorb.
        debits.set(exp.id, (debits.get(exp.id) ?? 0) + s.amount_minor);
      } else {
        const recv = await this.systemAccount("recv", owner.id, pay.currency);
        pre.push(recv.stmt);
        debits.set(recv.id, (debits.get(recv.id) ?? 0) + s.amount_minor);
      }
    }
    const postings: Posting[] = [...debits].filter(([, v]) => v > 0).map(([account_id, amount_minor]) => ({ account_id, side: "debit" as const, amount_minor }));
    postings.push({ account_id: pay.id, side: "credit", amount_minor: gross });
    const kind: TxnKind = pay.account_type === "liability" ? "card_purchase" : "expense";
    const stmts = [
      ...pre,
      ...(await this.txnStmts({ id, occurredAt, description: a.description, category: a.category ?? "split purchase", key: keyOverride ?? a.idempotency_key, kind, action: "money_record_split_purchase", notes: a.notes }, postings)),
      ...a.splits.map((s) => ({
        sql: "INSERT INTO transaction_splits (transaction_id, label, amount_minor, economic_owner_id, reimbursable) VALUES (?, ?, ?, ?, ?)",
        params: [id, s.label, s.amount_minor, s.economic_owner_id, s.reimbursable ? 1 : 0] as Param[],
      })),
    ];
    const mine = await this.me();
    const owed = a.splits.filter((s) => s.reimbursable && s.economic_owner_id !== mine).reduce((x, s) => x + s.amount_minor, 0);
    return {
      action: "money_record_split_purchase",
      summary: `Recorded ${a.description} ${money(gross, pay.currency)} on ${pay.name} as ONE purchase split ${a.splits.length} ways${owed ? `; ${money(owed, pay.currency)} owed back` : ""}.`,
      stmts,
      transactionId: id,
      accounts: [pay.id],
      occurredAt,
      warnings,
      entity: { type: "transaction", id },
      payload: a,
    };
  }

  async recordTransfer(a: {
    idempotency_key: string;
    occurred_at: string;
    amount_minor: number;
    currency: string;
    from_account_id: string;
    to_account_id: string;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_transfer", () => this.planTransfer(a, undefined, "money_record_transfer", "transfer"));
  }

  async recordCashSwap(a: {
    idempotency_key: string;
    occurred_at: string;
    amount_minor: number;
    from_account_id: string;
    to_account_id: string;
    counterparty_owner_id?: string | null;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_cash_swap", async () => {
      const from = await this.account(a.from_account_id);
      if (a.counterparty_owner_id) await this.owner(a.counterparty_owner_id);
      return this.planTransfer(
        { ...a, currency: from.currency, notes: [a.counterparty_owner_id ? `swap with ${a.counterparty_owner_id}` : "", a.notes ?? ""].filter(Boolean).join(" · ") },
        undefined,
        "money_record_cash_swap",
        "cash_swap",
      );
    });
  }

  private async planTransfer(
    a: { idempotency_key: string; occurred_at: string; amount_minor: number; currency: string; from_account_id: string; to_account_id: string; notes?: string },
    keyOverride: string | undefined,
    action: string,
    kind: TxnKind,
  ): Promise<Plan> {
    const amount = positiveInt(a.amount_minor, "amount_minor");
    const from = await this.account(a.from_account_id);
    const to = await this.account(a.to_account_id);
    if (from.id === to.id) throw new LedgerError("from and to are the same account.");
    for (const [acc, f] of [[from, "from_account_id"], [to, "to_account_id"]] as const) {
      if (acc.account_type !== "asset") {
        throw new LedgerError(
          acc.account_type === "liability"
            ? `${acc.name} is a card/loan — use money_record_card_payment or money_mark_obligation_paid.`
            : `${f} must be a bank, cash or wallet account.`,
        );
      }
    }
    // Rule C / test 19: a transfer only moves money between one owner's own accounts.
    if (from.owner_id !== to.owner_id) {
      throw new LedgerError(
        `${from.name} belongs to ${from.owner_id} and ${to.name} to ${to.owner_id}. Money crossing owners isn't a transfer: use money_record_cash_swap (your own accounts on both legs), money_record_expense with reimbursement, or money_record_pass_through.`,
      );
    }
    if (from.currency !== to.currency) throw new LedgerError("Cross-currency moves need an explicit FX conversion (not supported yet); currencies never mix.");
    requireCurrency(from, a.currency);
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.occurred_at, "occurred_at", [from.id, to.id], warnings);
    // Rule F / test 6: intent to pay a card is not a card payment.
    if (CARD_WORDS.test(a.notes ?? "")) {
      const pending = await this.db.all<{ name: string }>("SELECT name FROM obligations WHERE kind = 'card_minimum' AND status IN ('pending','planned')");
      if (pending.length) {
        warnings.push(
          `Recorded as a transfer only. ${pending.map((p) => p.name).join(", ")} stays unpaid until the card-side payment is confirmed (money_record_card_payment or money_mark_obligation_paid).`,
        );
      }
    }
    const id = newId("txn");
    return {
      action,
      summary: `Moved ${money(amount, from.currency)} ${from.name} → ${to.name}.`,
      stmts: await this.txnStmts(
        { id, occurredAt, description: `${from.name} → ${to.name}`, category: kind === "cash_swap" ? "cash swap" : "transfer", key: keyOverride ?? a.idempotency_key, kind, action, notes: a.notes },
        [
          { account_id: to.id, side: "debit", amount_minor: amount },
          { account_id: from.id, side: "credit", amount_minor: amount },
        ],
      ),
      transactionId: id,
      accounts: [from.id, to.id],
      occurredAt,
      warnings,
      entity: { type: "transaction", id },
      payload: a,
    };
  }

  async recordCardPayment(a: {
    idempotency_key: string;
    occurred_at: string;
    card_account_id: string;
    funding_account_id: string;
    amount_minor: number;
    obligation_id?: string | null;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_card_payment", async () => {
      const card = await this.account(a.card_account_id);
      if (card.account_type !== "liability") throw new LedgerError(`${card.name} isn't a card/liability account.`);
      return this.planDebtPayment({
        key: a.idempotency_key,
        occurred_at: a.occurred_at,
        liability: card,
        funding_account_id: a.funding_account_id,
        amount_minor: a.amount_minor,
        obligation_id: a.obligation_id ?? null,
        notes: a.notes,
        action: "money_record_card_payment",
      });
    });
  }

  /** Cash down, liability down, never a new expense (rule E). Optionally settles an obligation atomically. */
  private async planDebtPayment(p: {
    key: string;
    occurred_at: string;
    liability: AccountRow;
    funding_account_id: string;
    amount_minor: number;
    obligation_id: string | null;
    notes?: string;
    action: string;
  }): Promise<Plan> {
    const amount = positiveInt(p.amount_minor, "amount_minor");
    const fund = await this.account(p.funding_account_id);
    await this.requireMyAsset(fund, "funding_account_id");
    if (fund.currency !== p.liability.currency) throw new LedgerError("Funding account and card/loan currencies differ.");
    const warnings: string[] = [];
    const occurredAt = await this.instant(p.occurred_at, "occurred_at", [fund.id, p.liability.id], warnings);
    const id = newId("txn");
    const stmts = await this.txnStmts(
      { id, occurredAt, description: `Payment to ${p.liability.name}`, category: "debt payment", key: p.key, kind: "debt_payment", action: p.action, notes: p.notes },
      [
        { account_id: p.liability.id, side: "debit", amount_minor: amount },
        { account_id: fund.id, side: "credit", amount_minor: amount },
      ],
    );
    const obligationsChanged: unknown[] = [];
    let settled = "";
    if (p.obligation_id) {
      const o = await this.obligation(p.obligation_id);
      if (o.status === "paid") throw new LedgerError(`${o.name} is already marked paid.`);
      if (o.status === "cancelled") throw new LedgerError(`${o.name} is cancelled.`);
      const applied = await this.applyObligationPayment(o, amount, occurredAt, id);
      stmts.push(...applied.stmts);
      obligationsChanged.push(applied.change);
      warnings.push(...applied.warnings);
      settled = ` ${applied.sentence}`;
    }
    return {
      action: p.action,
      summary: `Paid ${money(amount, fund.currency)} from ${fund.name} to ${p.liability.name} (debt down, not new spending).${settled}`,
      stmts,
      transactionId: id,
      accounts: [fund.id, p.liability.id],
      occurredAt,
      obligationsChanged,
      warnings,
      entity: { type: "transaction", id },
      payload: { ...p, liability: p.liability.id },
    };
  }

  async recordReimbursementReceived(a: {
    idempotency_key: string;
    occurred_at: string;
    receivable_id: string;
    destination_account_id: string;
    amount_minor: number;
    waive_minor?: number;
    waive_reason?: string;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_reimbursement_received", () => this.planReimbursement(a));
  }

  private async planReimbursement(a: Parameters<Core["recordReimbursementReceived"]>[0], keyOverride?: string): Promise<Plan> {
    const amount = nonNegInt(a.amount_minor, "amount_minor");
    const waive = nonNegInt(a.waive_minor ?? 0, "waive_minor");
    if (amount + waive === 0) throw new LedgerError("Nothing to settle: amount_minor and waive_minor are both 0.");
    if (waive > 0 && !a.waive_reason) throw new LedgerError("waive_reason is required when waiving part of a reimbursement (test 13).");
    const recv = await this.account(this.receivableId(a.receivable_id));
    if (recv.account_type !== "receivable") throw new LedgerError(`${recv.name} isn't a receivable.`);
    const dest = await this.account(a.destination_account_id);
    await this.requireMyAsset(dest, "destination_account_id");
    if (dest.currency !== recv.currency) throw new LedgerError("Receivable and destination currencies differ.");
    const outstanding = await this.balanceOf(recv.id);
    if (amount + waive > outstanding) {
      throw new LedgerError(`${recv.name} only has ${money(outstanding, recv.currency)} outstanding; ${money(amount + waive, recv.currency)} would over-settle it.`);
    }
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.occurred_at, "occurred_at", [dest.id], warnings);
    const stmts: Stmt[] = [];
    let txId: string | null = null;
    if (amount > 0) {
      txId = newId("txn");
      stmts.push(
        ...(await this.txnStmts(
          { id: txId, occurredAt, description: `Reimbursement from ${recv.name.replace(/^Owed to you by /, "").replace(/ \([A-Z]{3}\)$/, "")}`, category: "reimbursement", key: keyOverride ?? a.idempotency_key, kind: "reimbursement", action: "money_record_reimbursement_received", notes: a.notes },
          [
            { account_id: dest.id, side: "debit", amount_minor: amount },
            { account_id: recv.id, side: "credit", amount_minor: amount },
          ],
        )),
      );
    }
    if (waive > 0) {
      const exp = await this.systemAccount("exp", null, recv.currency);
      const wid = newId("txn");
      txId ??= wid;
      stmts.push(
        exp.stmt,
        ...(await this.txnStmts(
          { id: wid, occurredAt, description: `Waived remainder: ${a.waive_reason}`, category: "waived reimbursement", key: `${keyOverride ?? a.idempotency_key}#waive`, kind: "waiver", action: "money_record_reimbursement_received", notes: a.waive_reason },
          [
            { account_id: exp.id, side: "debit", amount_minor: waive, memo: "waived" },
            { account_id: recv.id, side: "credit", amount_minor: waive, memo: "waived" },
          ],
        )),
      );
    }
    return {
      action: "money_record_reimbursement_received",
      summary: `Received ${money(amount, dest.currency)} reimbursement into ${dest.name} (settles what was owed — not income)${waive ? `; waived ${money(waive, dest.currency)}: ${a.waive_reason}` : ""}.`,
      stmts,
      transactionId: txId,
      accounts: [dest.id, recv.id],
      occurredAt,
      warnings,
      entity: txId ? { type: "transaction", id: txId } : null,
      payload: a,
    };
  }

  /** Extension: money that belongs to someone else passing through your account (rule H, test 14). */
  async recordPassThrough(a: {
    idempotency_key: string;
    occurred_at: string;
    amount_minor: number;
    account_id: string;
    owner_id: string;
    direction: "in" | "out";
    counterparty?: string;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_record_pass_through", () => this.planPassThrough(a));
  }

  private async planPassThrough(a: Parameters<Core["recordPassThrough"]>[0], keyOverride?: string): Promise<Plan> {
    const amount = positiveInt(a.amount_minor, "amount_minor");
    if (a.direction !== "in" && a.direction !== "out") throw new LedgerError('direction must be "in" or "out".');
    const acc = await this.account(a.account_id);
    await this.requireMyAsset(acc, "account_id");
    const owner = await this.owner(a.owner_id);
    if (owner.is_primary) throw new LedgerError("Pass-through is for someone else's money; owner_id can't be you.");
    const clear = await this.systemAccount("clear", owner.id, acc.currency);
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.occurred_at, "occurred_at", [acc.id], warnings);
    const id = newId("txn");
    const inbound = a.direction === "in";
    return {
      action: "money_record_pass_through",
      summary: inbound
        ? `Holding ${money(amount, acc.currency)} of ${owner.name}'s money in ${acc.name}${a.counterparty ? ` to route to ${a.counterparty}` : ""} (not income).`
        : `Routed ${money(amount, acc.currency)} of ${owner.name}'s money out of ${acc.name}${a.counterparty ? ` to ${a.counterparty}` : ""} (not spending).`,
      stmts: [
        clear.stmt,
        ...(await this.txnStmts(
          { id, occurredAt, description: `${owner.name} pass-through ${inbound ? "in" : "out"}${a.counterparty ? ` — ${a.counterparty}` : ""}`, category: "pass-through", key: keyOverride ?? a.idempotency_key, kind: "passthrough", action: "money_record_pass_through", notes: a.notes },
          inbound
            ? [
                { account_id: acc.id, side: "debit", amount_minor: amount },
                { account_id: clear.id, side: "credit", amount_minor: amount },
              ]
            : [
                { account_id: clear.id, side: "debit", amount_minor: amount },
                { account_id: acc.id, side: "credit", amount_minor: amount },
              ],
        )),
      ],
      transactionId: id,
      accounts: [acc.id],
      occurredAt,
      warnings,
      entity: { type: "transaction", id },
      payload: a,
    };
  }

  async setBalanceCheckpoint(a: {
    idempotency_key: string;
    account_id: string;
    as_of: string;
    reported_balance_minor: number;
    source_kind: string;
    source_ref?: string | null;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_set_balance_checkpoint", () => this.planCheckpoint(a, "money_set_balance_checkpoint"));
  }

  private async planCheckpoint(
    a: { account_id: string; as_of: string; reported_balance_minor: number; source_kind: string; source_ref?: string | null; notes?: string },
    action: string,
  ): Promise<Plan> {
    const acc = await this.account(a.account_id);
    if (!acc.active) throw new LedgerError(`${acc.name} is closed. Reopen it with money_update_account (active: true) first.`);
    if (!Number.isInteger(a.reported_balance_minor)) throw new LedgerError("reported_balance_minor must be an integer.");
    const sourceKind = requireString(a.source_kind, "source_kind");
    const asOf = toInstant(requireString(a.as_of, "as_of"), this.tz).iso;
    const prior = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM balance_checkpoints WHERE account_id = ? AND accepted = 1 AND as_of <= ?", [acc.id, asOf]);
    const priorPostings = await this.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = ? AND t.status <> 'draft' AND t.occurred_at <= ?",
      [acc.id, asOf],
    );
    const hasHistory = (prior?.n ?? 0) > 0 || (priorPostings?.n ?? 0) > 0;
    const expected = await this.balanceOf(acc.id, asOf);
    const diff = a.reported_balance_minor - expected;
    const stmts: Stmt[] = [
      {
        sql: "INSERT INTO balance_checkpoints (account_id, as_of, balance_minor, source_kind, source_ref, note, accepted) VALUES (?, ?, ?, ?, ?, ?, 1)",
        params: [acc.id, asOf, a.reported_balance_minor, sourceKind, a.source_ref ?? null, a.notes ?? null],
      },
    ];
    const issues: unknown[] = [];
    if (hasHistory && diff !== 0) {
      const issueId = newId("iss");
      stmts.push({
        sql: `INSERT INTO reconciliation_issues (id, account_id, detected_at, expected_balance_minor, reported_balance_minor, difference_minor, status, explanation)
              VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        params: [issueId, acc.id, asOf, expected, a.reported_balance_minor, diff, `Reported ${money(a.reported_balance_minor, acc.currency)} vs ledger ${money(expected, acc.currency)}. Unexplained until identified — no transaction invented.`],
      });
      issues.push({ id: issueId, account_id: acc.id, currency: acc.currency, expected_balance_minor: expected, reported_balance_minor: a.reported_balance_minor, difference_minor: diff });
    }
    return {
      action,
      summary: `${acc.name} checkpoint: ${money(a.reported_balance_minor, acc.currency)} (${sourceKind}) is now authoritative.`,
      occurredAt: asOf,
      stmts,
      transactionId: null,
      accounts: [acc.id],
      issues,
      entity: { type: "account", id: acc.id },
      payload: a,
    };
  }

  async setCardSnapshot(a: {
    idempotency_key: string;
    card_account_id: string;
    as_of: string;
    debt_minor: number;
    available_credit_minor?: number | null;
    credit_limit_minor?: number | null;
    minimum_minor?: number | null;
    minimum_due_date?: string | null;
    statement_close_date?: string | null;
    source_ref?: string | null;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_set_card_snapshot", async () => {
      const card = await this.account(a.card_account_id);
      if (card.account_type !== "liability") throw new LedgerError(`${card.name} isn't a card.`);
      const plan = await this.planCheckpoint(
        { account_id: card.id, as_of: a.as_of, reported_balance_minor: a.debt_minor, source_kind: "screenshot", source_ref: a.source_ref, notes: "card snapshot" },
        "money_set_card_snapshot",
      );
      const limit = a.credit_limit_minor ?? (a.available_credit_minor != null ? a.debt_minor + a.available_credit_minor : null);
      plan.stmts.push({
        sql: `INSERT INTO card_snapshots (card_account_id, as_of, debt_minor, available_credit_minor, credit_limit_minor, minimum_minor, minimum_due_date, statement_close_date, source_ref, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [card.id, toInstant(a.as_of, this.tz).iso, a.debt_minor, a.available_credit_minor ?? null, limit, a.minimum_minor ?? null, a.minimum_due_date ?? null, a.statement_close_date ?? null, a.source_ref ?? null, this.now()],
      });
      plan.summary = `${card.name} snapshot: debt ${money(a.debt_minor, card.currency)}${a.available_credit_minor != null ? `, ${money(a.available_credit_minor, card.currency)} available` : ""}${a.minimum_minor != null ? `, minimum ${money(a.minimum_minor, card.currency)}${a.minimum_due_date ? ` due ${a.minimum_due_date}` : ""}` : ""}.`;
      plan.payload = a;
      return plan;
    });
  }

  async upsertObligation(a: {
    idempotency_key: string;
    obligation_id?: string | null;
    name: string;
    amount_minor: number;
    currency: string;
    due_date?: string | null;
    kind: string;
    linked_account_id?: string | null;
    status: string;
    confidence: string;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_upsert_obligation", async () => {
      const KINDS = ["card_minimum", "loan", "utility", "tax", "family_debt", "subscription", "other"];
      if (!KINDS.includes(a.kind)) throw new LedgerError(`kind must be one of ${KINDS.join(", ")}.`);
      if (!["planned", "pending", "paid", "cancelled", "disputed"].includes(a.status)) throw new LedgerError("status must be planned|pending|paid|cancelled|disputed.");
      if (!["confirmed", "working", "inferred"].includes(a.confidence)) throw new LedgerError("confidence must be confirmed|working|inferred.");
      nonNegInt(a.amount_minor, "amount_minor");
      if (a.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(a.due_date)) throw new LedgerError("due_date must be YYYY-MM-DD.");
      if (a.linked_account_id) await this.account(a.linked_account_id);
      const existing = a.obligation_id ? await this.db.get<{ id: string; status: string }>("SELECT id, status FROM obligations WHERE id = ?", [a.obligation_id]) : null;
      const id = existing?.id ?? a.obligation_id ?? newId("obl");
      const warnings: string[] = [];
      if (a.status === "paid" && existing?.status !== "paid") {
        warnings.push("Marked paid without a payment transaction. For a payment that moved money, use money_mark_obligation_paid so the balance changes too.");
      }
      const history: Stmt[] = existing && existing.status !== a.status ? [statusChange(id, existing.status, a.status, this.now(), "edited")] : [];
      const stmt: Stmt = existing
        ? {
            sql: "UPDATE obligations SET name = ?, amount_minor = ?, currency = ?, due_date = ?, kind = ?, linked_account_id = ?, status = ?, confidence = ?, notes = ? WHERE id = ?",
            params: [a.name, a.amount_minor, a.currency, a.due_date ?? null, a.kind, a.linked_account_id ?? null, a.status, a.confidence, a.notes ?? null, id],
          }
        : {
            sql: "INSERT INTO obligations (id, name, amount_minor, currency, due_date, kind, linked_account_id, status, confidence, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params: [id, a.name, a.amount_minor, a.currency, a.due_date ?? null, a.kind, a.linked_account_id ?? null, a.status, a.confidence, a.notes ?? null],
          };
      return {
        action: "money_upsert_obligation",
        summary: `${existing ? "Updated" : "Added"} obligation "${a.name}" ${money(a.amount_minor, a.currency)}${a.due_date ? ` due ${a.due_date}` : ""} (${a.status}, ${a.confidence}).`,
        stmts: [stmt, ...history],
        transactionId: null,
        accounts: [],
        obligationsChanged: [{ id, name: a.name, status: a.status, due_date: a.due_date ?? null }],
        warnings,
        entity: { type: "obligation", id },
        payload: a,
      };
    });
  }

  async markObligationPaid(a: {
    idempotency_key: string;
    obligation_id: string;
    paid_at: string;
    funding_account_id: string;
    actual_amount_minor?: number | null;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_mark_obligation_paid", () => this.planObligationPaid(a));
  }

  private async planObligationPaid(a: Parameters<Core["markObligationPaid"]>[0], keyOverride?: string): Promise<Plan> {
    const o = await this.obligation(a.obligation_id);
    if (o.status === "paid") throw new LedgerError(`${o.name} is already marked paid${o.paid_at ? ` (${localDate(o.paid_at, this.tz)})` : ""}.`);
    if (o.status === "cancelled") throw new LedgerError(`${o.name} is cancelled.`);
    const remaining = Math.max(0, o.amount_minor - o.paid_minor);
    const amount = positiveInt(a.actual_amount_minor ?? (remaining || o.amount_minor), "actual_amount_minor");
    const key = keyOverride ?? a.idempotency_key;

    // Debt-like obligations reduce a liability; bills are expenses.
    if (["card_minimum", "loan", "family_debt"].includes(o.kind)) {
      if (!o.linked_account_id) throw new LedgerError(`${o.name} has no linked card/loan account; link one with money_upsert_obligation first.`);
      const liab = await this.account(o.linked_account_id);
      const plan = await this.planDebtPayment({ key, occurred_at: a.paid_at, liability: liab, funding_account_id: a.funding_account_id, amount_minor: amount, obligation_id: o.id, notes: a.notes, action: "money_mark_obligation_paid" });
      const status = (plan.obligationsChanged?.[0] as { sentence?: string } | undefined)?.sentence ?? "";
      plan.summary = `Paid ${money(amount, o.currency)} toward ${o.name}${o.due_date ? ` (due ${o.due_date})` : ""} from ${(await this.account(a.funding_account_id)).name}; ${liab.name} debt down. ${status}`.trim();
      plan.entity = { type: "obligation", id: o.id };
      return plan;
    }

    const fund = await this.account(a.funding_account_id);
    await this.requireMyAsset(fund, "funding_account_id");
    const warnings: string[] = [];
    const occurredAt = await this.instant(a.paid_at, "paid_at", [fund.id], warnings);
    const exp = await this.systemAccount("exp", null, fund.currency);
    const id = newId("txn");
    const applied = await this.applyObligationPayment(o, amount, occurredAt, id);
    warnings.push(...applied.warnings);
    const stmts = [
      exp.stmt,
      ...(await this.txnStmts(
        { id, occurredAt, description: o.name, category: o.kind, key, kind: "bill_payment", action: "money_mark_obligation_paid", notes: a.notes },
        [
          { account_id: exp.id, side: "debit", amount_minor: amount },
          { account_id: fund.id, side: "credit", amount_minor: amount },
        ],
      )),
      ...applied.stmts,
    ];
    return {
      action: "money_mark_obligation_paid",
      summary: `Paid ${money(amount, fund.currency)} toward ${o.name}${o.due_date ? ` (due ${o.due_date})` : ""} from ${fund.name}. ${applied.sentence}`,
      stmts,
      transactionId: id,
      accounts: [fund.id],
      occurredAt,
      obligationsChanged: [applied.change],
      warnings,
      entity: { type: "obligation", id: o.id },
      payload: a,
    };
  }

  /**
   * Apply a payment to an obligation inside the caller's batch (test 22).
   * The obligation becomes paid only when posted payments reach its amount;
   * a partial payment leaves it pending with the remainder visible. Linked
   * reservations are drawn down by what was actually paid; once the
   * obligation is fully paid, anything still reserved for it is released.
   */
  private async applyObligationPayment(
    o: { id: string; name: string; amount_minor: number; currency: string; due_date: string | null; kind: string; status: string; paid_minor: number },
    amount: number,
    paidAt: string,
    txId: string,
  ): Promise<{ stmts: Stmt[]; change: unknown; warnings: string[]; sentence: string }> {
    // Only the part of the payment the obligation still needed is applied to it.
    // Any extra still moved money (the card/loan balance went down, or it was
    // spent), but it isn't part of this obligation's history.
    const owed = Math.max(0, o.amount_minor - o.paid_minor);
    const applied = o.amount_minor === 0 ? amount : Math.min(amount, owed);
    const paid = o.paid_minor + applied;
    const remaining = Math.max(0, o.amount_minor - paid);
    const full = remaining === 0;
    const newStatus = full ? "paid" : o.status === "disputed" ? "disputed" : "pending";
    const warnings: string[] = [];
    const stmts: Stmt[] = [];
    if (applied > 0) {
      stmts.push({ sql: "INSERT INTO obligation_payments (obligation_id, transaction_id, amount_minor, paid_at) VALUES (?, ?, ?, ?)", params: [o.id, txId, applied, paidAt] });
    }
    stmts.push(
      full
        ? { sql: "UPDATE obligations SET status = 'paid', paid_at = ?, paid_transaction_id = ? WHERE id = ?", params: [paidAt, txId, o.id] }
        : { sql: "UPDATE obligations SET status = ? WHERE id = ?", params: [newStatus, o.id] },
    );
    if (newStatus !== o.status) stmts.push(statusChange(o.id, o.status, newStatus, paidAt, "payment"));

    const reservations = await this.db.all<{ id: string; label: string; amount_minor: number }>(
      "SELECT id, label, amount_minor FROM reservations WHERE obligation_id = ? AND status = 'active' ORDER BY due_date, id",
      [o.id],
    );
    let left = applied;
    for (const r of reservations) {
      if (left >= r.amount_minor) {
        stmts.push({ sql: "UPDATE reservations SET status = 'spent' WHERE id = ?", params: [r.id] });
        left -= r.amount_minor;
      } else if (left > 0) {
        if (full) {
          stmts.push({ sql: "UPDATE reservations SET status = 'released' WHERE id = ?", params: [r.id] });
          warnings.push(`Released the rest of "${r.label}" (${money(r.amount_minor - left, o.currency)}) — ${o.name} is fully paid.`);
        } else {
          stmts.push({ sql: "UPDATE reservations SET amount_minor = ? WHERE id = ?", params: [r.amount_minor - left, r.id] });
        }
        left = 0;
      } else if (full) {
        stmts.push({ sql: "UPDATE reservations SET status = 'released' WHERE id = ?", params: [r.id] });
        warnings.push(`Released "${r.label}" (${money(r.amount_minor, o.currency)}) — ${o.name} is fully paid.`);
      }
    }

    if (o.amount_minor === 0) warnings.push(`${o.name} had no known amount; marked paid with this payment.`);
    else if (amount > applied) {
      const extra = money(amount - applied, o.currency);
      warnings.push(
        o.kind === "card_minimum" || o.kind === "loan" || o.kind === "family_debt"
          ? `${extra} beyond ${o.name} went to the balance itself, not to the obligation.`
          : `Paid ${extra} more than ${o.name} needed; only ${money(applied, o.currency)} counts toward it.`,
      );
    }

    const sentence = full
      ? `${o.name} is now fully paid.`
      : `${o.name} stays pending: ${money(remaining, o.currency)} of ${money(o.amount_minor, o.currency)} still due.`;
    return {
      stmts,
      change: { id: o.id, name: o.name, status: full ? "paid" : "pending", due_date: o.due_date, paid_minor: paid, remaining_minor: remaining, sentence },
      warnings,
      sentence,
    };
  }

  async addExpectedInflow(a: {
    idempotency_key: string;
    source: string;
    amount_minor?: number | null;
    currency: string;
    expected_from?: string | null;
    expected_to?: string | null;
    status: string;
    confidence?: string;
    notes?: string;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_add_expected_inflow", async () => {
      if (!["scenario", "expected", "confirmed_arrangement"].includes(a.status)) {
        throw new LedgerError("status must be scenario|expected|confirmed_arrangement. Received money is recorded with money_record_income.");
      }
      const id = newId("exp");
      return {
        action: "money_add_expected_inflow",
        summary: `Noted expected ${a.source}${a.amount_minor != null ? ` ${money(a.amount_minor, a.currency)}` : ""} (${a.status}) — not cash, no balance changed.`,
        stmts: [
          {
            sql: "INSERT INTO expected_inflows (id, source, amount_minor, currency, expected_from, expected_to, status, confidence, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params: [id, a.source, a.amount_minor ?? null, a.currency, a.expected_from ?? null, a.expected_to ?? null, a.status, a.confidence ?? null, a.notes ?? null],
          },
        ],
        transactionId: null,
        accounts: [],
        entity: { type: "expected_inflow", id },
        payload: a,
      };
    });
  }

  async reserveFunds(a: {
    idempotency_key: string;
    label: string;
    amount_minor: number;
    currency: string;
    account_id?: string | null;
    obligation_id?: string | null;
    due_date?: string | null;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_reserve_funds", async () => {
      const amount = positiveInt(a.amount_minor, "amount_minor");
      const warnings: string[] = [];
      if (a.account_id) {
        const acc = await this.account(a.account_id);
        await this.requireMyAsset(acc, "account_id");
        const bal = await this.balanceOf(acc.id);
        if (amount > bal) warnings.push(`Reserving more than ${acc.name} holds (${money(bal, acc.currency)}).`);
      }
      if (a.obligation_id) await this.obligation(a.obligation_id);
      const id = newId("res");
      return {
        action: "money_reserve_funds",
        summary: `Reserved ${money(amount, a.currency)} for ${a.label} — bank balance unchanged, free money down.`,
        stmts: [
          {
            sql: "INSERT INTO reservations (id, label, amount_minor, currency, account_id, obligation_id, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')",
            params: [id, a.label, amount, a.currency, a.account_id ?? null, a.obligation_id ?? null, a.due_date ?? null],
          },
        ],
        transactionId: null,
        accounts: a.account_id ? [a.account_id] : [],
        warnings,
        entity: { type: "reservation", id },
        payload: a,
      };
    });
  }

  async resolveReconciliation(a: {
    idempotency_key: string;
    issue_id: string;
    resolution_type: string;
    explanation: string;
    transaction_id?: string | null;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_resolve_reconciliation", async () => {
      const issue = await this.db.get<{ id: string; status: string; account_id: string }>("SELECT * FROM reconciliation_issues WHERE id = ?", [a.issue_id]);
      if (!issue) throw new LedgerError(`Unknown reconciliation issue "${a.issue_id}".`);
      if (issue.status !== "open") throw new LedgerError(`Issue ${issue.id} is already ${issue.status}.`);
      if (!["identified_transaction", "accept_checkpoint", "other"].includes(a.resolution_type)) throw new LedgerError("resolution_type must be identified_transaction|accept_checkpoint|other.");
      if (a.resolution_type === "identified_transaction" && !a.transaction_id) throw new LedgerError("transaction_id is required for identified_transaction.");
      if (a.transaction_id && !(await this.db.get("SELECT id FROM transactions WHERE id = ?", [a.transaction_id]))) throw new LedgerError(`Unknown transaction "${a.transaction_id}".`);
      return {
        action: "money_resolve_reconciliation",
        summary: `Resolved reconciliation issue ${issue.id} (${a.resolution_type}): ${a.explanation}`,
        stmts: [
          {
            sql: "UPDATE reconciliation_issues SET status = 'resolved', explanation = ?, resolved_at = ?, resolution_transaction_id = ? WHERE id = ?",
            params: [`${a.resolution_type}: ${a.explanation}`, this.now(), a.transaction_id ?? null, issue.id],
          },
        ],
        transactionId: null,
        accounts: [issue.account_id],
        entity: { type: "reconciliation_issue", id: issue.id },
        payload: a,
      };
    });
  }

  async reverseTransaction(a: { idempotency_key: string; transaction_id: string; reason: string }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_reverse_transaction", async () => {
      const t = await this.db.get<{ id: string; status: string; description: string; occurred_at: string }>("SELECT * FROM transactions WHERE id = ?", [a.transaction_id]);
      if (!t) throw new LedgerError(`Unknown transaction "${a.transaction_id}".`);
      if (t.status === "reversed") throw new LedgerError("That transaction is already reversed.");
      if (t.status === "draft") throw new LedgerError("Drafts have no postings to reverse.");
      if (!a.reason) throw new LedgerError("reason is required.");
      const postings = await this.db.all<Posting>("SELECT account_id, side, amount_minor, memo FROM postings WHERE transaction_id = ?", [t.id]);
      const id = newId("txn");
      const occurredAt = this.now();
      const stmts = [
        ...(await this.txnStmts(
          { id, occurredAt, description: `Reversal of: ${t.description}`, category: "reversal", key: a.idempotency_key, kind: "reversal", action: "money_reverse_transaction", notes: a.reason },
          postings.map((p) => ({ ...p, side: p.side === "debit" ? ("credit" as const) : ("debit" as const), memo: "reversal" })),
        )),
        { sql: "UPDATE transactions SET status = 'reversed', reversed_by = ? WHERE id = ?", params: [id, t.id] as Param[] },
      ];
      // Payments this transaction applied to obligations no longer count once it's reversed.
      const applied = await this.db.all<{ obligation_id: string; amount_minor: number }>("SELECT obligation_id, amount_minor FROM obligation_payments WHERE transaction_id = ?", [t.id]);
      const warnings: string[] = [];
      const linked: { id: string; name: string; due_date: string | null; remaining_minor: number }[] = [];
      for (const ap of applied) {
        const o = await this.obligation(ap.obligation_id);
        const remaining = Math.max(0, o.amount_minor - (o.paid_minor - ap.amount_minor));
        if (remaining > 0) {
          const reopened = o.status === "disputed" ? "disputed" : "pending";
          stmts.push({ sql: "UPDATE obligations SET status = ?, paid_at = NULL, paid_transaction_id = NULL WHERE id = ?", params: [reopened, o.id] });
          if (reopened !== o.status) stmts.push(statusChange(o.id, o.status, reopened, occurredAt, "payment reversed"));
          warnings.push(`${o.name} is pending again: ${money(remaining, o.currency)} due. Re-reserve funds for it if needed.`);
          linked.push({ id: o.id, name: o.name, due_date: o.due_date, remaining_minor: remaining });
        }
      }
      // Dated now: the reversed entry may be dated before a checkpoint that already reflects it.
      const before = new Date(Date.parse(t.occurred_at)).toISOString();
      const cps = await this.allBalances();
      for (const p of postings) {
        const cp = cps.find((c) => c.id === p.account_id)?.checkpoint_as_of;
        if (cp && before <= cp) warnings.push(`The original was dated before ${p.account_id}'s latest checkpoint; reversing it today moves that balance. Check against a fresh balance.`);
      }
      return {
        action: "money_reverse_transaction",
        summary: `Reversed "${t.description}" (${a.reason}). The original stays in history, marked reversed.`,
        stmts,
        transactionId: id,
        accounts: [...new Set(postings.map((p) => p.account_id))],
        occurredAt,
        obligationsChanged: linked.map((o) => ({ id: o.id, name: o.name, status: "pending", due_date: o.due_date, remaining_minor: o.remaining_minor })),
        warnings,
        entity: { type: "transaction", id: t.id },
        payload: a,
      };
    });
  }

  /** Extension: finish a draft once the paying account is known. */
  async completeDraft(a: { idempotency_key: string; transaction_id: string; payment_account_id: string }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_complete_draft", async () => {
      const t = await this.db.get<{ id: string; status: string; notes: string }>("SELECT * FROM transactions WHERE id = ?", [a.transaction_id]);
      if (!t || t.status !== "draft") throw new LedgerError(`"${a.transaction_id}" isn't an open draft.`);
      const original = JSON.parse(t.notes).draft as Parameters<Core["recordExpense"]>[0];
      const plan = await this.planExpense({ ...original, payment_account_id: a.payment_account_id }, a.idempotency_key);
      // The draft row keeps its key; the completed entry replaces it in balances, and the draft is marked reversed by it.
      plan.stmts.push({ sql: "UPDATE transactions SET status = 'reversed', reversed_by = ? WHERE id = ?", params: [plan.transactionId!, t.id] });
      plan.summary = `Completed draft: ${plan.summary}`;
      return plan;
    });
  }

  /** Extension: several movements, all-or-nothing (test 17). */
  async recordBatch(a: { idempotency_key: string; items: { tool: string; args: Record<string, unknown> }[] }): Promise<MutationResult> {
    const key = requireKey(a.idempotency_key);
    const prior = await this.db.get<{ action: string; result_json: string }>("SELECT action, result_json FROM idempotency_keys WHERE key = ?", [key]);
    if (prior) return this.replay(key, "money_record_batch", prior);
    if (!Array.isArray(a.items) || a.items.length === 0) throw new LedgerError("items are required.");
    // Items are planned against pre-batch state, so two items settling the same
    // obligation or receivable would each see the other's money as unpaid.
    const touched = new Map<string, number>();
    for (const [i, item] of a.items.entries()) {
      const args = item.args ?? {};
      const target =
        item.tool === "money_mark_obligation_paid" && typeof args.obligation_id === "string"
          ? `obligation ${args.obligation_id}`
          : item.tool === "money_record_reimbursement_received" && typeof args.receivable_id === "string"
            ? `receivable ${this.receivableId(args.receivable_id)}`
            : null;
      if (!target) continue;
      if (touched.has(target)) {
        throw new LedgerError(`Batch items ${touched.get(target)! + 1} and ${i + 1} both settle ${target}. Record those one call at a time so each sees the other; nothing was recorded.`);
      }
      touched.set(target, i);
    }
    const plans: Plan[] = [];
    for (const [i, item] of a.items.entries()) {
      const itemKey = `${key}#${i}`;
      const args = { ...item.args, idempotency_key: itemKey } as never;
      try {
        const plan = await this.planFor(item.tool, args, itemKey);
        if (plan.occurredAt) await this.assertMonthOpen(plan.occurredAt);
        plans.push(plan);
      } catch (e) {
        throw new LedgerError(`Batch rejected at item ${i + 1} (${item.tool}): ${(e as Error).message} Nothing was recorded.`);
      }
    }
    return this.commit(key, plans);
  }

  private planFor(tool: string, args: never, key: string): Promise<Plan> {
    switch (tool) {
      case "money_record_income":
        return this.planIncome(args, key);
      case "money_record_expense":
        return this.planExpense(args, key);
      case "money_record_card_purchase":
        return this.planCardPurchase(args, key);
      case "money_record_split_purchase":
        return this.planSplitPurchase(args, key);
      case "money_record_transfer":
        return this.planTransfer(args, key, "money_record_transfer", "transfer");
      case "money_record_reimbursement_received":
        return this.planReimbursement(args, key);
      case "money_record_pass_through":
        return this.planPassThrough(args, key);
      case "money_mark_obligation_paid":
        return this.planObligationPaid(args, key);
      default:
        throw new LedgerError(`${tool} can't be batched. Batchable: income, expense, card purchase, split purchase, transfer, reimbursement, pass-through, obligation paid. Setup tools (money_create_person, money_create_account, money_upsert_obligation…) are called one at a time, in order. Nothing was recorded.`);
    }
  }

  async closeMonth(a: { idempotency_key: string; month: string; notes?: string }, renderHtml?: (summary: unknown) => string): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_close_month", async () => {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)) throw new LedgerError("month must be YYYY-MM.");
      if (await this.db.get("SELECT month FROM month_closures WHERE month = ?", [a.month])) throw new LedgerError(`${a.month} is already closed.`);
      const [, end] = monthBounds(a.month, this.tz);
      if (end > this.now()) throw new LedgerError(`${a.month} hasn't ended yet.`);
      const summary = await this.periodSummary({ month: a.month });
      const balances = (await this.allBalances(new Date(Date.parse(end) - 1).toISOString()))
        .filter((b) => ["asset", "liability", "receivable", "payable"].includes(b.account_type))
        .map((b) => ({ id: b.id, name: b.name, owner_id: b.owner_id, is_primary: b.is_primary, account_type: b.account_type, active: b.active, currency: b.currency, balance_minor: b.balance_minor }));
      // Everything below is as of month-end, not as of the moment the close runs:
      // a bill paid after month-end was still unpaid then, and issues detected
      // after month-end don't belong to this month.
      const paidByEnd = PAID_SQL.replace("tx.status = 'posted'", "tx.status = 'posted' AND op.paid_at < ?");
      const later = await this.db.all<{ obligation_id: string; from_status: string }>(
        "SELECT obligation_id, from_status FROM obligation_status_history WHERE changed_at >= ? ORDER BY changed_at DESC, id DESC",
        [end],
      );
      const obligations = (
        await this.db.all<{ id: string; status: string; paid_at: string | null; amount_minor: number; paid_minor: number }>(
          `SELECT o.*, ${paidByEnd} AS paid_minor FROM obligations o WHERE o.due_date LIKE ? ORDER BY o.due_date`,
          [end, `${a.month}%`],
        )
      ).map((o) => {
        // Newest-first, each later change is undone: the last from_status seen is the month-end status.
        let status = o.status;
        for (const h of later) if (h.obligation_id === o.id) status = h.from_status;
        // Obligations paid before the history table existed: fall back to payment timing.
        if (status === "paid" && o.paid_at && o.paid_at >= end) status = "pending";
        return {
          ...o,
          status_at_month_end: status,
          remaining_at_month_end_minor: status === "paid" || status === "cancelled" ? 0 : Math.max(0, o.amount_minor - o.paid_minor),
        };
      });
      const issues = await this.db.all(
        "SELECT * FROM reconciliation_issues WHERE detected_at < ? AND (status = 'open' OR (resolved_at IS NOT NULL AND resolved_at >= ?)) ORDER BY detected_at",
        [end, end],
      );
      const snapshot = { month: a.month, closed_at: this.now(), currency: this.base, timezone: this.tz, end_balances: balances, summary, obligations, open_reconciliation_issues: issues, notes: a.notes ?? null };
      const json = JSON.stringify(snapshot);
      return {
        action: "money_close_month",
        summary: `Closed ${a.month}: snapshot frozen (${balances.length} balances, ${obligations.length} obligations, ${issues.length} open issues). Later entries can't change it.`,
        stmts: [
          { sql: "INSERT INTO month_closures (month, closed_at, summary_json, report_path, notes) VALUES (?, ?, ?, ?, ?)", params: [a.month, this.now(), json, `money_truths_${a.month}_closed.html`, a.notes ?? null] },
          { sql: "INSERT INTO month_close_exports (month, export_json, report_html) VALUES (?, ?, ?)", params: [a.month, json, renderHtml ? renderHtml(snapshot) : ""] },
        ],
        transactionId: null,
        accounts: [],
        entity: { type: "month", id: a.month },
        payload: a,
      };
    });
  }

  // ---- Extensions: organisation & notes (no accounting effect) -------------

  async setField(a: { idempotency_key: string; entity_type: string; entity_id: string; key: string; value: unknown }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_set_field", async () => {
      const ENTITIES = ["account", "obligation", "transaction", "expected_inflow", "reservation", "recurring_rule", "reconciliation_issue"];
      if (!ENTITIES.includes(a.entity_type)) throw new LedgerError(`entity_type must be one of ${ENTITIES.join(", ")}.`);
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(a.key ?? "")) throw new LedgerError("key must be snake_case, up to 40 chars.");
      const remove = a.value === null || a.value === undefined;
      return {
        action: "money_set_field",
        summary: remove ? `Removed field "${a.key}" from ${a.entity_type} ${a.entity_id}.` : `Set ${a.entity_type} ${a.entity_id} · ${a.key} = ${JSON.stringify(a.value)}.`,
        stmts: [
          remove
            ? { sql: "DELETE FROM entity_fields WHERE entity_type = ? AND entity_id = ? AND key = ?", params: [a.entity_type, a.entity_id, a.key] }
            : {
                sql: "INSERT INTO entity_fields (entity_type, entity_id, key, value_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(entity_type, entity_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params: [a.entity_type, a.entity_id, a.key, JSON.stringify(a.value), this.now()],
              },
        ],
        transactionId: null,
        accounts: [],
        entity: { type: a.entity_type, id: a.entity_id },
        payload: a,
      };
    });
  }

  async addNote(a: { idempotency_key: string; author: string; icon?: string; body: string }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_add_note", async () => {
      if (!a.body?.trim()) throw new LedgerError("body is required.");
      if (a.body.length > 500) throw new LedgerError("Keep notes under 500 characters.");
      const id = newId("note");
      return {
        action: "money_add_note",
        summary: `Pinned a note from ${a.author}.`,
        stmts: [{ sql: "INSERT INTO notes (id, author, icon, body, created_at) VALUES (?, ?, ?, ?, ?)", params: [id, a.author, a.icon ?? null, a.body.trim(), this.now()] }],
        transactionId: null,
        accounts: [],
        entity: { type: "note", id },
        payload: a,
      };
    });
  }

  // ---- Setup by chat: people and accounts -------------------------------------
  // New users describe their money in conversation; the assistant turns each
  // account into one call. An opening balance is a checkpoint (what the bank
  // says now), never invented income.

  async createPerson(a: { idempotency_key: string; name: string; person_id?: string | null }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_create_person", async () => {
      await this.me();
      const name = requireString(a.name, "name").trim();
      if (name.length > 60) throw new LedgerError("Keep names under 60 characters.");
      const wanted = slug(a.person_id || name);
      if (a.person_id && (await this.db.get("SELECT id FROM owners WHERE id = ?", [wanted]))) throw new LedgerError(`There's already a person with id "${wanted}".`);
      const same = await this.db.get<{ id: string }>("SELECT id FROM owners WHERE lower(name) = lower(?)", [name]);
      if (same) throw new LedgerError(`${name} already exists (id "${same.id}").`);
      const id = await this.freeId("owners", wanted);
      return {
        action: "money_create_person",
        summary: `Added ${name} (id "${id}"). Money that belongs to them is never counted as yours.`,
        stmts: [{ sql: "INSERT INTO owners (id, name, is_primary) VALUES (?, ?, 0)", params: [id, name] }],
        transactionId: null,
        accounts: [],
        entity: { type: "owner", id },
        payload: { ...a, person_id: id },
      };
    });
  }

  async createAccount(a: {
    idempotency_key: string;
    name: string;
    type: AccountKind;
    currency?: string | null;
    owner_id?: string | null;
    institution?: string | null;
    last4?: string | null;
    balance_minor?: number | null;
    as_of?: string | null;
    credit_limit_minor?: number | null;
    installment_minor?: number | null;
    installments_paid?: number | null;
    installments_total?: number | null;
    rate?: string | null;
    color?: string | null;
    notes?: string | null;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_create_account", async () => {
      const mine = await this.me();
      const kind = ACCOUNT_KINDS[a.type];
      if (!kind) throw new LedgerError(`type must be one of: ${Object.keys(ACCOUNT_KINDS).join(", ")}.`);
      const name = requireString(a.name, "name").trim();
      const currency = (a.currency ?? this.base).toUpperCase();
      if (!isCurrencyCode(currency)) throw new LedgerError(`currency must be a 3-letter ISO code like USD, EUR or MXN (got "${a.currency}").`);
      if (a.last4 != null && !/^\d{4}$/.test(a.last4)) throw new LedgerError("last4 must be exactly the last 4 digits — never store a full card or account number.");
      if (a.balance_minor != null && !Number.isInteger(a.balance_minor)) throw new LedgerError("balance_minor must be a whole number in minor units.");
      if (a.color != null && !/^#[0-9a-fA-F]{6}$/.test(a.color)) throw new LedgerError("color must look like #a1b2c3.");
      for (const f of ["credit_limit_minor", "installment_minor", "installments_paid", "installments_total"] as const) {
        const v = a[f];
        if (v != null && (!Number.isInteger(v) || v < 0)) throw new LedgerError(`${f} must be a whole number, 0 or more.`);
      }
      if (a.credit_limit_minor != null && a.type !== "credit_card") throw new LedgerError("credit_limit_minor is only for credit cards.");

      // Whose account: debts and receivables are always yours; money you track
      // for someone else (owner_id) is shown separately and never counted.
      let owner = mine;
      if (a.owner_id && a.owner_id !== mine && a.type !== "owed_to_me") {
        if (kind.account_type !== "asset") throw new LedgerError("Only bank, cash, wallet and savings accounts can belong to someone else. Debts and money owed to you are always yours.");
        owner = (await this.db.get<{ id: string }>("SELECT id FROM owners WHERE id = ?", [a.owner_id]))?.id ?? "";
        if (!owner) throw new LedgerError(`Unknown person "${a.owner_id}". Add them first with money_create_person.`);
      }

      const stmts: Stmt[] = [];
      let id: string;
      if (a.type === "owed_to_me") {
        // One receivable per person and currency, shared with split purchases and reimbursements.
        const from = a.owner_id && a.owner_id !== mine ? a.owner_id : null;
        if (!from) throw new LedgerError("owed_to_me needs owner_id: the person who owes you (add them with money_create_person first).");
        if (!(await this.db.get("SELECT id FROM owners WHERE id = ?", [from]))) throw new LedgerError(`Unknown person "${from}". Add them first with money_create_person.`);
        const recv = await this.systemAccount("recv", from, currency);
        if (await this.db.get("SELECT id FROM accounts WHERE id = ?", [recv.id])) {
          throw new LedgerError(`You already track what ${from} owes you in ${currency} (${recv.id}). Use money_set_balance_checkpoint to update the amount.`);
        }
        id = recv.id;
        stmts.push(recv.stmt);
        owner = mine;
      } else {
        id = await this.freeId("accounts", `${kind.prefix}_${slug(name)}`);
        stmts.push({
          sql: `INSERT INTO accounts (id, owner_id, name, institution, account_type, normal_side, currency, is_liquid, include_in_owner_total, active, last4, notes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
          params: [id, owner, name, a.institution ?? null, kind.account_type, kind.normal_side, currency, kind.liquid ? 1 : 0, a.last4 ?? null, a.notes ?? null],
        });
      }

      const asOf = toInstant(a.as_of ?? this.now(), this.tz).iso;
      const known = a.balance_minor != null;
      if (known) {
        if (kind.account_type !== "asset" && a.balance_minor! < 0) throw new LedgerError("For debts and money owed to you, balance_minor is the positive amount owed.");
        stmts.push({
          sql: "INSERT INTO balance_checkpoints (account_id, as_of, balance_minor, source_kind, source_ref, note, accepted) VALUES (?, ?, ?, 'user', NULL, 'opening balance', 1)",
          params: [id, asOf, a.balance_minor!],
        });
      }
      if (a.type === "credit_card" && a.credit_limit_minor != null && known) {
        stmts.push({
          sql: "INSERT INTO card_snapshots (card_account_id, as_of, debt_minor, available_credit_minor, credit_limit_minor, minimum_minor, minimum_due_date, statement_close_date, source_ref, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'opening balance', ?)",
          params: [id, asOf, a.balance_minor!, Math.max(0, a.credit_limit_minor - a.balance_minor!), a.credit_limit_minor, this.now()],
        });
      }
      const fields: Record<string, unknown> = { kind: kind.field };
      if (!known && a.type !== "owed_to_me") fields.balance_unknown = true;
      if (a.type === "credit_card" && a.credit_limit_minor != null && !known) fields.credit_limit_minor = a.credit_limit_minor;
      if (a.installment_minor != null) fields.installment_minor = a.installment_minor;
      if (a.installments_paid != null) fields.installments_paid = a.installments_paid;
      if (a.installments_total != null) fields.installments_total = a.installments_total;
      if (a.rate) fields.rate = a.rate;
      if (a.color) fields.color = a.color;
      for (const [k, v] of Object.entries(fields)) {
        stmts.push({
          sql: "INSERT INTO entity_fields (entity_type, entity_id, key, value_json, updated_at) VALUES ('account', ?, ?, ?, ?) ON CONFLICT(entity_type, entity_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
          params: [id, k, JSON.stringify(v), this.now()],
        });
      }

      const whose = owner === mine ? "" : ` (belongs to ${owner}; never counted as yours)`;
      const bal = known ? ` with ${money(a.balance_minor!, currency)}${kind.account_type === "asset" ? "" : " owed"} as of ${localDate(asOf, this.tz)}` : " — balance not known yet (add it any time with money_set_balance_checkpoint)";
      return {
        action: "money_create_account",
        summary: `Created ${kind.label} "${name}" (id ${id}, ${currency})${whose}${bal}.`,
        occurredAt: known ? asOf : undefined,
        stmts,
        transactionId: null,
        accounts: [id],
        entity: { type: "account", id },
        payload: { ...a, account_id: id },
      };
    });
  }

  /**
   * Change the ledger's own settings: the user's name, timezone, or main
   * currency. The main currency can only change while no account or entry
   * uses the old one — totals are never converted.
   */
  async updateSettings(a: { idempotency_key: string; name?: string; currency?: string; timezone?: string }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_update_settings", async () => {
      const mine = await this.me();
      const stmts: Stmt[] = [];
      const changes: string[] = [];
      const meta = (k: string, v: string) => ({ sql: "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [k, v] });
      if (a.name !== undefined) {
        const name = requireString(a.name, "name").trim();
        if (name.length > 60) throw new LedgerError("Keep the name under 60 characters.");
        stmts.push({ sql: "UPDATE owners SET name = ? WHERE id = ?", params: [name, mine] }, meta("report_eyebrow", `${name}'s ledger`));
        changes.push(`name → ${name}`);
      }
      if (a.timezone !== undefined) {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: a.timezone });
        } catch {
          throw new LedgerError(`"${a.timezone}" isn't a timezone. Use a name like America/New_York or Europe/Madrid.`);
        }
        stmts.push(meta("timezone", a.timezone));
        changes.push(`timezone → ${a.timezone}`);
      }
      if (a.currency !== undefined && a.currency.toUpperCase() !== this.base) {
        const cur = a.currency.toUpperCase();
        if (!isCurrencyCode(cur)) throw new LedgerError(`currency must be a 3-letter ISO code like USD, EUR or MXN (got "${a.currency}").`);
        const used = await this.db.get<{ n: number }>(
          `SELECT (SELECT count(*) FROM accounts WHERE currency = ? AND account_type IN ('asset','liability','receivable','payable'))
                + (SELECT count(*) FROM obligations WHERE currency = ?) + (SELECT count(*) FROM reservations WHERE currency = ?) AS n`,
          [this.base, this.base, this.base],
        );
        if (used?.n) {
          throw new LedgerError(
            `Can't switch the main currency from ${this.base} to ${cur}: ${used.n} account${used.n === 1 ? "" : "s"}/plan${used.n === 1 ? "" : "s"} already use ${this.base}, and Money Truths never converts amounts. Add ${cur} accounts with currency: "${cur}" instead (they show separately), or start a fresh ledger.`,
          );
        }
        stmts.push(meta("base_currency", cur));
        changes.push(`main currency ${this.base} → ${cur}`);
      }
      if (!stmts.length) throw new LedgerError("Pass name, currency and/or timezone to change.");
      return {
        action: "money_update_settings",
        summary: `Settings updated: ${changes.join(", ")}. Balances unchanged.`,
        stmts,
        transactionId: null,
        accounts: [],
        entity: { type: "settings", id: "ledger" },
        payload: { ...a, before: { currency: this.base, timezone: this.tz } },
      };
    });
  }

  /** `base`, or `base_2`, `base_3`… — the first id not used in `table`. */
  private async freeId(table: "owners" | "accounts", base: string): Promise<string> {
    for (let i = 1; ; i++) {
      const id = i === 1 ? base : `${base}_${i}`;
      if (!(await this.db.get(`SELECT id FROM ${table} WHERE id = ?`, [id]))) return id;
    }
  }

  // ---- Extensions: housekeeping on non-money entities -----------------------
  // These edit labels, plans and status. Money that moved is never edited here:
  // corrections to transactions are reversals.

  async updateNote(a: { idempotency_key: string; note_id: string; body?: string; archived?: boolean }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_update_note", async () => {
      const n = await this.db.get<{ id: string; author: string; body: string; archived: number }>("SELECT * FROM notes WHERE id = ?", [a.note_id]);
      if (!n) throw new LedgerError(`Unknown note "${a.note_id}". money_get_notes lists them.`);
      if (a.body === undefined && a.archived === undefined) throw new LedgerError("Pass body and/or archived.");
      const body = a.body === undefined ? n.body : a.body.trim();
      if (!body) throw new LedgerError("body can't be empty — archive the note instead.");
      if (body.length > 500) throw new LedgerError("Keep notes under 500 characters.");
      const archived = a.archived === undefined ? n.archived : a.archived ? 1 : 0;
      const what = [a.body !== undefined ? "edited" : "", a.archived === true ? "archived" : a.archived === false ? "unarchived" : ""].filter(Boolean).join(" and ");
      return {
        action: "money_update_note",
        summary: `Note from ${n.author} ${what}.`,
        stmts: [{ sql: "UPDATE notes SET body = ?, archived = ? WHERE id = ?", params: [body, archived, n.id] }],
        transactionId: null,
        accounts: [],
        entity: { type: "note", id: n.id },
        payload: { ...a, before: n },
      };
    });
  }

  async updateReservation(a: {
    idempotency_key: string;
    reservation_id: string;
    label?: string;
    amount_minor?: number;
    due_date?: string | null;
    status?: "released" | "cancelled";
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_update_reservation", async () => {
      const r = await this.db.get<{ id: string; label: string; amount_minor: number; currency: string; account_id: string | null; due_date: string | null; status: string }>("SELECT * FROM reservations WHERE id = ?", [a.reservation_id]);
      if (!r) throw new LedgerError(`Unknown reservation "${a.reservation_id}". money_get_snapshot lists active ones.`);
      if (r.status !== "active") throw new LedgerError(`That reservation is already ${r.status}.`);
      if (a.status && !["released", "cancelled"].includes(a.status)) throw new LedgerError("status can only be released or cancelled here; payments spend reservations automatically.");
      if (a.status && (a.amount_minor !== undefined || a.label !== undefined)) throw new LedgerError("Release/cancel and edits are separate calls.");
      if (a.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(a.due_date)) throw new LedgerError("due_date must be YYYY-MM-DD.");
      const warnings: string[] = [];
      let summary: string;
      let stmt: Stmt;
      if (a.status) {
        stmt = { sql: "UPDATE reservations SET status = ? WHERE id = ?", params: [a.status, r.id] };
        summary = `${a.status === "released" ? "Released" : "Cancelled"} reservation "${r.label}" (${money(r.amount_minor, r.currency)}) — free money up, bank balance unchanged.`;
      } else {
        const amount = a.amount_minor === undefined ? r.amount_minor : positiveInt(a.amount_minor, "amount_minor");
        const label = a.label?.trim() || r.label;
        if (r.account_id && amount > r.amount_minor) {
          const bal = await this.balanceOf(r.account_id);
          if (amount > bal) warnings.push(`Reserving more than the account holds (${money(bal, r.currency)}).`);
        }
        stmt = { sql: "UPDATE reservations SET label = ?, amount_minor = ?, due_date = ? WHERE id = ?", params: [label, amount, a.due_date === undefined ? r.due_date : a.due_date, r.id] };
        summary = `Reservation "${label}" ${amount !== r.amount_minor ? `${money(r.amount_minor, r.currency)} → ${money(amount, r.currency)}` : "updated"}.`;
      }
      return {
        action: "money_update_reservation",
        summary,
        stmts: [stmt],
        transactionId: null,
        accounts: r.account_id ? [r.account_id] : [],
        warnings,
        entity: { type: "reservation", id: r.id },
        payload: { ...a, before: r },
      };
    });
  }

  async updateExpectedInflow(a: {
    idempotency_key: string;
    expected_inflow_id: string;
    source?: string;
    amount_minor?: number | null;
    currency?: string;
    expected_from?: string | null;
    expected_to?: string | null;
    status?: "scenario" | "expected" | "confirmed_arrangement" | "cancelled";
    confidence?: string | null;
    notes?: string | null;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_update_expected_inflow", async () => {
      const e = await this.db.get<{ id: string; source: string; amount_minor: number | null; currency: string; expected_from: string | null; expected_to: string | null; status: string; confidence: string | null; notes: string | null }>(
        "SELECT * FROM expected_inflows WHERE id = ?",
        [a.expected_inflow_id],
      );
      if (!e) throw new LedgerError(`Unknown expected inflow "${a.expected_inflow_id}". money_get_snapshot lists them.`);
      if (e.status === "received") throw new LedgerError("That money already arrived; it's a transaction now. Reverse the income if it was wrong.");
      if ((a.status as string) === "received") throw new LedgerError("Money arriving is recorded with money_record_income (expected_inflow_id), which marks this received.");
      if (a.status && !["scenario", "expected", "confirmed_arrangement", "cancelled"].includes(a.status)) throw new LedgerError("status must be scenario|expected|confirmed_arrangement|cancelled.");
      if (a.amount_minor !== undefined && a.amount_minor !== null) nonNegInt(a.amount_minor, "amount_minor");
      for (const d of [a.expected_from, a.expected_to]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new LedgerError("Dates must be YYYY-MM-DD.");
      const next = {
        source: a.source?.trim() || e.source,
        amount_minor: a.amount_minor === undefined ? e.amount_minor : a.amount_minor,
        currency: a.currency ?? e.currency,
        expected_from: a.expected_from === undefined ? e.expected_from : a.expected_from,
        expected_to: a.expected_to === undefined ? e.expected_to : a.expected_to,
        status: a.status ?? e.status,
        confidence: a.confidence === undefined ? e.confidence : a.confidence,
        notes: a.notes === undefined ? e.notes : a.notes,
      };
      return {
        action: "money_update_expected_inflow",
        summary:
          next.status === "cancelled" && e.status !== "cancelled"
            ? `Cancelled expected ${e.source} — it won't be counted anywhere. No balance changed.`
            : `Updated expected ${next.source}${next.amount_minor != null ? ` (${money(next.amount_minor, next.currency)})` : ""}, ${next.status} — still not cash.`,
        stmts: [
          {
            sql: "UPDATE expected_inflows SET source = ?, amount_minor = ?, currency = ?, expected_from = ?, expected_to = ?, status = ?, confidence = ?, notes = ? WHERE id = ?",
            params: [next.source, next.amount_minor, next.currency, next.expected_from, next.expected_to, next.status, next.confidence, next.notes, e.id],
          },
        ],
        transactionId: null,
        accounts: [],
        entity: { type: "expected_inflow", id: e.id },
        payload: { ...a, before: e },
      };
    });
  }

  async upsertRecurringRule(a: {
    idempotency_key: string;
    rule_id?: string | null;
    name?: string;
    owner_id?: string;
    amount_minor?: number | null;
    currency?: string;
    cadence?: string;
    next_due_date?: string | null;
    end_date?: string | null;
    kind?: string;
    active?: boolean;
    confidence?: string;
    notes?: string | null;
  }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_upsert_recurring_rule", async () => {
      type Rule = { id: string; name: string; owner_id: string; amount_minor: number | null; currency: string; cadence: string; next_due_date: string | null; end_date: string | null; kind: string; active: number; confidence: string; notes: string | null };
      const existing = a.rule_id ? await this.db.get<Rule>("SELECT * FROM recurring_rules WHERE id = ?", [a.rule_id]) : null;
      if (a.rule_id && !existing && !a.name) throw new LedgerError(`Unknown recurring rule "${a.rule_id}". To create one, also pass name, owner_id, currency, cadence and kind.`);
      const pick = <K extends keyof Rule>(k: K, v: Rule[K] | undefined, fallback: Rule[K] | undefined): Rule[K] | undefined => (v === undefined ? (existing ? existing[k] : fallback) : v);
      const r = {
        name: pick("name", a.name?.trim(), undefined),
        owner_id: pick("owner_id", a.owner_id, undefined),
        amount_minor: pick("amount_minor", a.amount_minor, null),
        currency: pick("currency", a.currency, undefined),
        cadence: pick("cadence", a.cadence, undefined),
        next_due_date: pick("next_due_date", a.next_due_date, null),
        end_date: pick("end_date", a.end_date, null),
        kind: pick("kind", a.kind, undefined),
        active: a.active === undefined ? (existing ? existing.active : 1) : a.active ? 1 : 0,
        confidence: pick("confidence", a.confidence, "working"),
        notes: pick("notes", a.notes, null),
      };
      for (const f of ["name", "owner_id", "currency", "cadence", "kind"] as const) if (!r[f]) throw new LedgerError(`${f} is required for a new recurring rule.`);
      const CADENCES = ["weekly", "biweekly", "monthly", "quarterly", "yearly"];
      if (!CADENCES.includes(r.cadence!)) throw new LedgerError(`cadence must be one of ${CADENCES.join(", ")}.`);
      await this.owner(r.owner_id!);
      if (r.amount_minor != null) nonNegInt(r.amount_minor, "amount_minor");
      for (const d of [r.next_due_date, r.end_date]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new LedgerError("Dates must be YYYY-MM-DD.");
      const id = existing?.id ?? a.rule_id ?? newId("rule");
      const params: Param[] = [r.name!, r.owner_id!, r.amount_minor ?? null, r.currency!, r.cadence!, r.next_due_date ?? null, r.end_date ?? null, r.kind!, r.active, r.confidence!, r.notes ?? null];
      const stmt: Stmt = existing
        ? { sql: "UPDATE recurring_rules SET name = ?, owner_id = ?, amount_minor = ?, currency = ?, cadence = ?, next_due_date = ?, end_date = ?, kind = ?, active = ?, confidence = ?, notes = ? WHERE id = ?", params: [...params, id] }
        : { sql: "INSERT INTO recurring_rules (name, owner_id, amount_minor, currency, cadence, next_due_date, end_date, kind, active, confidence, notes, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", params: [...params, id] };
      const state = !existing ? "Added" : existing.active && !r.active ? "Paused" : !existing.active && r.active ? "Resumed" : "Updated";
      return {
        action: "money_upsert_recurring_rule",
        summary: `${state} recurring ${r.kind} "${r.name}"${r.amount_minor != null ? ` ${money(r.amount_minor, r.currency!)}/${r.cadence}` : ""}. Plans only — no balance changed.`,
        stmts: [stmt],
        transactionId: null,
        accounts: [],
        entity: { type: "recurring_rule", id },
        payload: { ...a, before: existing },
      };
    });
  }

  async updateAccount(a: { idempotency_key: string; account_id: string; name?: string; institution?: string | null; last4?: string | null; notes?: string | null; active?: boolean }): Promise<MutationResult> {
    return this.mutate(a.idempotency_key, "money_update_account", async () => {
      const acc = await this.account(a.account_id);
      if (a.last4 != null && !/^\d{4}$/.test(a.last4)) throw new LedgerError("last4 must be exactly the last 4 digits — never store a full card or account number.");
      const warnings: string[] = [];
      if (a.active === false && acc.active) {
        // Closing must never hide money or debt: refuse while anything is attached.
        const bal = await this.balanceOf(acc.id);
        if (bal !== 0) throw new LedgerError(`${acc.name} still shows ${money(bal, acc.currency)}. Record where that went (or a fresh zero-balance checkpoint) before closing it.`);
        const open = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM obligations WHERE linked_account_id = ? AND status IN ('planned','pending','disputed')", [acc.id]);
        if (open?.n) throw new LedgerError(`${acc.name} has ${open.n} open obligation${open.n > 1 ? "s" : ""}. Pay or cancel ${open.n > 1 ? "them" : "it"} first.`);
        const res = await this.db.get<{ n: number }>("SELECT count(*) AS n FROM reservations WHERE account_id = ? AND status = 'active'", [acc.id]);
        if (res?.n) throw new LedgerError(`${acc.name} has active reservations. Release them first.`);
      }
      const next = {
        name: a.name?.trim() || acc.name,
        institution: a.institution === undefined ? acc.institution : a.institution,
        last4: a.last4 === undefined ? acc.last4 : a.last4,
        notes: a.notes === undefined ? acc.notes : a.notes,
        active: a.active === undefined ? acc.active : a.active ? 1 : 0,
      };
      const changes = [
        next.name !== acc.name ? `renamed "${acc.name}" → "${next.name}"` : "",
        next.active !== acc.active ? (next.active ? "reopened" : "closed") : "",
        next.institution !== acc.institution || next.last4 !== acc.last4 || next.notes !== acc.notes ? "details updated" : "",
      ].filter(Boolean);
      return {
        action: "money_update_account",
        summary: `${acc.name}: ${changes.join(", ") || "no change"}. Balances unchanged.`,
        stmts: [{ sql: "UPDATE accounts SET name = ?, institution = ?, last4 = ?, notes = ?, active = ? WHERE id = ?", params: [next.name, next.institution, next.last4, next.notes, next.active, acc.id] }],
        transactionId: null,
        accounts: [acc.id],
        warnings,
        entity: { type: "account", id: acc.id },
        payload: { ...a, before: acc },
      };
    });
  }

  // =========================================================================
  // Reads
  // =========================================================================

  async notes(a: { include_archived?: boolean } = {}) {
    return this.db.all(
      `SELECT id, author, icon, body, created_at, archived FROM notes ${a.include_archived ? "" : "WHERE archived = 0"} ORDER BY created_at DESC`,
    );
  }

  async obligation(id: string) {
    const o = await this.db.get<{ id: string; name: string; amount_minor: number; currency: string; due_date: string | null; kind: string; linked_account_id: string | null; status: string; confidence: string; paid_at: string | null; notes: string | null; paid_minor: number }>(
      `SELECT o.*, ${PAID_SQL} AS paid_minor FROM obligations o WHERE o.id = ?`,
      [id],
    );
    if (!o) throw new LedgerError(`Unknown obligation "${id}".`);
    return o;
  }

  async fields(entityType: string): Promise<Map<string, Record<string, unknown>>> {
    const rows = await this.db.all<{ entity_id: string; key: string; value_json: string }>("SELECT entity_id, key, value_json FROM entity_fields WHERE entity_type = ?", [entityType]);
    const out = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const m = out.get(r.entity_id) ?? {};
      m[r.key] = JSON.parse(r.value_json);
      out.set(r.entity_id, m);
    }
    return out;
  }

  async snapshot(a: { as_of?: string; include_others?: boolean; include_expected?: boolean } = {}) {
    const asOf = a.as_of ? toInstant(a.as_of, this.tz).iso : this.now();
    const balances = await this.allBalances(asOf);
    const accFields = await this.fields("account");
    const myLiquid = balances.filter(this.isMyLiquid);
    const liquid = myLiquid.reduce((s, x) => s + x.balance_minor, 0);
    const reservations = await this.db.all<{ id: string; label: string; amount_minor: number; currency: string; account_id: string | null; obligation_id: string | null; due_date: string | null }>(
      "SELECT * FROM reservations WHERE status = 'active' ORDER BY due_date",
    );
    const reserved = await this.activeReservations();
    const foreign = balances.filter((b) => b.is_primary && b.account_type === "asset" && b.currency !== this.base && b.include_in_owner_total);
    const others = balances.filter((b) => !b.is_primary && b.account_type === "asset");
    const liabilities = balances.filter((b) => b.is_primary && (b.account_type === "liability" || b.account_type === "payable") && !b.id.startsWith("clear_"));
    const receivables = balances.filter((b) => b.account_type === "receivable" && b.balance_minor !== 0);
    const clearing = balances.filter((b) => b.id.startsWith("clear_") && b.balance_minor !== 0);
    const obligations = await this.db.all<{ id: string; name: string; amount_minor: number; currency: string; due_date: string | null; kind: string; status: string; confidence: string; linked_account_id: string | null; notes: string | null; paid_at: string | null }>(
      `SELECT o.*, ${PAID_SQL} AS paid_minor, ${REMAINING_SQL} AS remaining_minor FROM obligations o WHERE o.status IN ('planned','pending','disputed') ORDER BY o.due_date IS NULL, o.due_date`,
    );
    const expected = a.include_expected === false ? [] : await this.db.all("SELECT * FROM expected_inflows WHERE status IN ('scenario','expected','confirmed_arrangement') ORDER BY expected_to IS NULL, expected_to");
    const issues = await this.db.all("SELECT * FROM reconciliation_issues WHERE status = 'open' ORDER BY detected_at");
    const drafts = await this.db.all("SELECT id, occurred_at, description, notes FROM transactions WHERE status = 'draft' ORDER BY occurred_at");
    // balance_known is false only for accounts explicitly flagged balance_unknown that have no checkpoint yet:
    // postings alone can't establish a balance when the opening balance was never recorded.
    const open = (b: AccountBalance) => b.active === 1;
    const recurring = await this.db.all("SELECT * FROM recurring_rules ORDER BY active DESC, kind, name");
    const shape = (b: AccountBalance) => ({ id: b.id, name: b.name, owner_id: b.owner_id, currency: b.currency, balance_minor: b.balance_minor, balance_known: !!b.checkpoint_as_of || accFields.get(b.id)?.balance_unknown !== true, checkpoint_as_of: b.checkpoint_as_of, institution: b.institution, fields: accFields.get(b.id) ?? {} });
    const hasAccounts = balances.some((b) => b.account_type !== "income" && b.account_type !== "expense");
    return {
      ...(hasAccounts ? {} : { getting_started: this.gettingStarted() }),
      as_of: asOf,
      generated_at: this.now(),
      currency: this.base,
      timezone: this.tz,
      me: {
        id: await this.me(),
        liquid,
        reserved,
        free: liquid - reserved,
        accounts: myLiquid.filter(open).map(shape),
      },
      foreign_currency: foreign.filter(open).map(shape),
      others: a.include_others === false ? [] : others.filter(open).map(shape),
      held_total: liquid + (a.include_others === false ? 0 : others.filter((o) => o.currency === this.base).reduce((s, o) => s + o.balance_minor, 0)),
      reservations,
      liabilities: liabilities.filter(open).map(shape),
      receivables: receivables.map(shape),
      pass_through_held: clearing.map(shape),
      open_obligations: obligations,
      expected_inflows: expected,
      reconciliation_issues: issues,
      drafts,
      recurring_rules: recurring,
    };
  }

  /** First-run script for the assistant, returned while the ledger has no accounts. */
  gettingStarted(): string {
    return [
      "This ledger is brand new and empty. Before recording anything, set it up with the user, warmly and one question at a time:",
      `1. Confirm the basics: main currency ${this.base} and timezone ${this.tz} (picked on the setup page). If either is wrong, fix it with money_update_settings now.`,
      "2. Everyday money: which bank accounts, cash and payment apps they use, and what each shows right now → money_create_account (type bank/cash/wallet/savings, balance_minor).",
      "3. Credit cards: amount owed, limit, next minimum and due date → money_create_account type credit_card, then money_upsert_obligation kind card_minimum.",
      "4. Loans and personal debts: what's left (or unknown), monthly payment, payments made/total → type loan or personal_debt, then the next payment with money_upsert_obligation kind loan.",
      "5. People they share costs with or who owe them → money_create_person, and type owed_to_me for money already owed.",
      "6. Regular bills and subscriptions → money_upsert_obligation / money_upsert_recurring_rule.",
      "7. Show the result with money_show_ledger.",
      "Ask for real numbers from their apps; never guess. Amounts are integers in minor units (cents for 2-decimal currencies).",
    ].join("\n");
  }

  async upcomingObligations(a: { from_date: string; to_date: string; status?: string }) {
    const where = ["o.due_date >= ?", "o.due_date <= ?"];
    const params: Param[] = [a.from_date, a.to_date];
    if (a.status) {
      where.push("o.status = ?");
      params.push(a.status);
    }
    return this.db.all(`SELECT o.*, ${PAID_SQL} AS paid_minor, ${REMAINING_SQL} AS remaining_minor FROM obligations o WHERE ${where.join(" AND ")} ORDER BY o.due_date, o.name`, params);
  }

  async reconciliationIssues(a: { status?: "open" | "resolved" | "all" } = {}) {
    const s = a.status ?? "open";
    return s === "all"
      ? this.db.all("SELECT * FROM reconciliation_issues ORDER BY detected_at DESC")
      : this.db.all("SELECT * FROM reconciliation_issues WHERE status = ? ORDER BY detected_at DESC", [s]);
  }

  async history(a: { account_id?: string | null; from_date?: string | null; to_date?: string | null; limit?: number } = {}) {
    const where: string[] = [];
    const params: Param[] = [];
    if (a.from_date || a.to_date) {
      const [from, to] = dateRangeBounds(a.from_date ?? "1970-01-01", a.to_date ?? "2999-12-31", this.tz);
      where.push("t.occurred_at >= ? AND t.occurred_at < ?");
      params.push(from, to);
    }
    if (a.account_id) {
      where.push("t.id IN (SELECT transaction_id FROM postings WHERE account_id = ?)");
      params.push(a.account_id);
    }
    const limit = Math.min(Math.max(a.limit ?? 100, 1), 500);
    const txns = await this.db.all<{ id: string; occurred_at: string; description: string; category: string | null; status: string; source_kind: string; notes: string | null; reversed_by: string | null }>(
      `SELECT t.* FROM transactions t ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.occurred_at DESC, t.created_at DESC LIMIT ${limit}`,
      params,
    );
    if (txns.length === 0) return [];
    const ph = txns.map(() => "?").join(",");
    const postings = await this.db.all<{ transaction_id: string; account_id: string; side: Side; amount_minor: number; memo: string | null }>(
      `SELECT transaction_id, account_id, side, amount_minor, memo FROM postings WHERE transaction_id IN (${ph}) ORDER BY id`,
      txns.map((t) => t.id),
    );
    const splits = await this.db.all<{ transaction_id: string; label: string; amount_minor: number; economic_owner_id: string; reimbursable: number }>(
      `SELECT transaction_id, label, amount_minor, economic_owner_id, reimbursable FROM transaction_splits WHERE transaction_id IN (${ph}) ORDER BY id`,
      txns.map((t) => t.id),
    );
    return txns.map((t) => ({
      ...t,
      kind: t.source_kind,
      local_date: localDate(t.occurred_at, this.tz),
      postings: postings.filter((p) => p.transaction_id === t.id),
      splits: splits.filter((s) => s.transaction_id === t.id),
    }));
  }

  /**
   * Spec 09 month summary for a month or year. Derived from postings so the
   * accounting rules hold by construction: transfers between your liquid
   * accounts are excluded from cash flow; card purchases are spending but not
   * cash; card/loan payments are debt payments, not spending; reimbursements
   * settle receivables and are never income.
   */
  async periodSummary(a: { month?: string; year?: number }) {
    let from: string;
    let to: string;
    let label: string;
    if (a.month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)) throw new LedgerError("month must be YYYY-MM.");
      [from, to] = monthBounds(a.month, this.tz);
      label = a.month;
    } else if (a.year) {
      from = monthBounds(`${a.year}-01`, this.tz)[0];
      to = monthBounds(`${a.year}-12`, this.tz)[1];
      label = String(a.year);
    } else {
      throw new LedgerError("Pass month (YYYY-MM) or year.");
    }
    const rows = await this.db.all<{ transaction_id: string; source_kind: string; category: string | null; account_id: string; side: Side; amount_minor: number; account_type: string; is_liquid: number; currency: string; is_primary: number }>(
      `SELECT p.transaction_id, t.source_kind, t.category, p.account_id, p.side, p.amount_minor, a.account_type, a.is_liquid, a.currency, o.is_primary
       FROM postings p
       JOIN transactions t ON t.id = p.transaction_id
       JOIN accounts a ON a.id = p.account_id
       JOIN owners o ON o.id = a.owner_id
       WHERE t.status <> 'draft' AND t.occurred_at >= ? AND t.occurred_at < ?`,
      [from, to],
    );
    const s = { cash_in: 0, cash_out: 0, economic_spending: 0, income: 0, debt_payments: 0, card_purchases: 0, reimbursements_received: 0, newly_owed_to_you: 0, waived: 0 };
    const byCategory = new Map<string, number>();
    const byTxn = new Map<string, typeof rows>();
    for (const r of rows.filter((r) => r.currency === this.base)) byTxn.set(r.transaction_id, [...(byTxn.get(r.transaction_id) ?? []), r]);
    const liquidMine = (r: (typeof rows)[number]) => r.account_type === "asset" && r.is_liquid === 1 && r.is_primary === 1;
    for (const legs of byTxn.values()) {
      const internal = legs.every(liquidMine);
      const signed = (r: (typeof rows)[number]) => (r.side === "debit" ? r.amount_minor : -r.amount_minor);
      if (!internal) {
        for (const r of legs.filter(liquidMine)) {
          if (r.side === "debit") s.cash_in += r.amount_minor;
          else s.cash_out += r.amount_minor;
        }
      }
      // Signs follow the posting side, so a reversal nets its original out of every bucket.
      const hasPurchaseLeg = legs.some((x) => x.account_type === "expense" || x.account_type === "receivable");
      const hasCashLeg = legs.some(liquidMine);
      for (const r of legs) {
        if (r.account_type === "expense") {
          s.economic_spending += signed(r);
          const cat = legs[0].category ?? "uncategorised";
          byCategory.set(cat, (byCategory.get(cat) ?? 0) + signed(r));
          if (cat === "waived reimbursement") s.waived += signed(r);
        }
        if (r.account_type === "income") s.income -= signed(r);
        const isDebt = (r.account_type === "liability" || r.account_type === "payable") && !r.account_id.startsWith("clear_");
        if (isDebt && hasPurchaseLeg) s.card_purchases -= signed(r);
        else if (isDebt && hasCashLeg) s.debt_payments += signed(r);
        // Receivable credited with cash coming in = reimbursement received;
        // credited without cash = waived/settled otherwise; debited = newly owed.
        if (r.account_type === "receivable") {
          if (r.side === "credit" && hasCashLeg) s.reimbursements_received += r.amount_minor;
          else s.newly_owed_to_you += signed(r);
        }
      }
    }
    return {
      period: label,
      currency: this.base,
      ...s,
      earned_minus_spent: s.income - s.economic_spending,
      by_category: [...byCategory].map(([category, amount_minor]) => ({ category, amount_minor })).sort((x, y) => y.amount_minor - x.amount_minor),
      transactions: byTxn.size,
    };
  }

  /** Case/accent-insensitive search across the journal. */
  async search(a: { q: string; from_date?: string; to_date?: string; limit?: number }) {
    const terms = fold(a.q ?? "").split(/\s+/).filter(Boolean);
    if (terms.length === 0) throw new LedgerError("q is required.");
    const journal = await this.history({ from_date: a.from_date, to_date: a.to_date, limit: 500 });
    const hits = journal
      .filter((t) => matches(terms, `${t.description} ${t.category ?? ""} ${t.notes ?? ""} ${t.kind} ${t.postings.map((p) => p.account_id).join(" ")}`, t.postings.map((p) => p.amount_minor)))
      .map((t) => ({ source: "journal" as const, ...t }));
    const limit = Math.min(a.limit ?? 100, 300);
    return { q: a.q, journal: hits.slice(0, limit) };
  }

  /** Accept an owner id (e.g. "sam") as shorthand for their base-currency receivable. */
  receivableId(id: string): string {
    return /^recv_/.test(id) ? id : `recv_${id}_${this.base}`;
  }

  // ---- guards ---------------------------------------------------------------

  private async requireMine(acc: AccountRow, field: string): Promise<void> {
    const owner = await this.owner(acc.owner_id);
    if (!owner.is_primary) throw new LedgerError(`${field}: ${acc.name} belongs to ${owner.name}, not you.`);
  }

  private async requireMyAsset(acc: AccountRow, field: string): Promise<void> {
    await this.requireMine(acc, field);
    if (acc.account_type !== "asset") throw new LedgerError(`${field}: ${acc.name} isn't a bank, cash or wallet account.`);
  }
}

// ---------------------------------------------------------------------------

export function money(minor: number, currency: string): string {
  return fmt(minor, currency);
}

function composeSummary(base: string, before: BalanceReport, after: BalanceReport, issues: unknown[]): string {
  const parts = [base];
  for (const b of before.accounts) {
    const a = after.accounts.find((x) => x.id === b.id);
    if (a && a.balance_minor !== b.balance_minor) parts.push(`${b.name} ${money(b.balance_minor, b.currency)} → ${money(a.balance_minor, a.currency)}.`);
  }
  const d = after.liquid - before.liquid;
  parts.push(d === 0 ? "Your liquid money unchanged." : `Your liquid money ${d > 0 ? "+" : "−"}${money(Math.abs(d), after.currency)}.`);
  const f = after.free - before.free;
  if (f !== d) parts.push(`Free money ${f === 0 ? "unchanged" : `${f > 0 ? "+" : "−"}${money(Math.abs(f), after.currency)}`}.`);
  parts.push(
    issues.length
      ? `Opened ${issues.length} reconciliation issue${issues.length > 1 ? "s" : ""}: ${issues.map((i) => { const x = i as { account_id: string; currency: string; difference_minor: number }; return `${x.account_id} ${x.difference_minor > 0 ? "+" : "−"}${money(Math.abs(x.difference_minor), x.currency)}`; }).join(", ")}.`
      : "No reconciliation issue.",
  );
  return parts.join(" ");
}

function statusChange(obligationId: string, from: string, to: string, at: string, reason: string): Stmt {
  return {
    sql: "INSERT INTO obligation_status_history (obligation_id, from_status, to_status, changed_at, reason) VALUES (?, ?, ?, ?, ?)",
    params: [obligationId, from, to, at, reason],
  };
}

export type AccountKind = "bank" | "cash" | "wallet" | "savings" | "credit_card" | "loan" | "personal_debt" | "owed_to_me";

const ACCOUNT_KINDS: Record<AccountKind, { prefix: string; account_type: string; normal_side: Side; liquid: boolean; field: string; label: string }> = {
  bank: { prefix: "asset", account_type: "asset", normal_side: "debit", liquid: true, field: "bank", label: "bank account" },
  cash: { prefix: "asset", account_type: "asset", normal_side: "debit", liquid: true, field: "cash", label: "cash account" },
  wallet: { prefix: "asset", account_type: "asset", normal_side: "debit", liquid: true, field: "wallet", label: "wallet" },
  savings: { prefix: "asset", account_type: "asset", normal_side: "debit", liquid: true, field: "savings", label: "savings account" },
  credit_card: { prefix: "liab", account_type: "liability", normal_side: "credit", liquid: false, field: "card", label: "credit card" },
  loan: { prefix: "liab", account_type: "liability", normal_side: "credit", liquid: false, field: "loan", label: "loan" },
  personal_debt: { prefix: "liab", account_type: "liability", normal_side: "credit", liquid: false, field: "family_debt", label: "personal debt" },
  owed_to_me: { prefix: "recv", account_type: "receivable", normal_side: "debit", liquid: false, field: "owed_to_me", label: "money owed to you" },
};

/** "Chase Checking!" → "chase_checking" (ASCII, max 24 chars). */
export function slug(s: string): string {
  const out = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24).replace(/_+$/, "");
  return out || "item";
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function requireKey(key: unknown): string {
  if (typeof key !== "string" || !key.trim()) throw new LedgerError("idempotency_key is required (any unique string) so a retry can never double-record.");
  return key.trim();
}

function requireString(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) throw new LedgerError(`${field} is required.`);
  return v;
}

function positiveInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new LedgerError(`${field} must be a positive whole number in minor units (cents for USD/EUR; whole units for currencies without decimals).`);
  return v;
}

function nonNegInt(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new LedgerError(`${field} must be a whole number ≥ 0.`);
  return v;
}

function requireCurrency(acc: AccountRow, currency: string | undefined): void {
  if (currency && currency !== acc.currency) throw new LedgerError(`${acc.name} holds ${acc.currency}, not ${currency}.`);
}



export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, "");
}

function matches(terms: string[], text: string, amounts: number[]): boolean {
  const hay = fold(text);
  return terms.every((t) => hay.includes(t) || (/^\d+$/.test(t) && amounts.some((n) => String(n).includes(t))));
}
