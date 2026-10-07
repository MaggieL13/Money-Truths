import { PAID_SQL, type Core } from "./index.ts";
import { daysBetween, localDate } from "./time.ts";
import type { MoneyTruthsView, Obligation, Issue, Txn, TxnKind, Subscription, ExpectedIncome } from "../view.ts";
import { colorFor, fmt } from "../money.ts";

// Builds the report/widget view model from the canonical database. All
// numbers come from Core; this file only selects and labels.

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export async function loadView(core: Core): Promise<MoneyTruthsView> {
  const today = core.today();
  const ym = today.slice(0, 7);
  const snap = await core.snapshot();
  const base = snap.currency;
  const money = (n: number, currency = base) => fmt(n, currency);
  const accFields = await core.fields("account");
  const oblFields = await core.fields("obligation");
  const recFields = await core.fields("recurring_rule");
  const meta = new Map((await core.db.all<{ key: string; value: string }>("SELECT key, value FROM schema_meta")).map((r) => [r.key, r.value]));
  const first = await core.db.get<{ at: string | null }>("SELECT MIN(occurred_at) AS at FROM transactions");
  const since = meta.get("setup_at") ?? first?.at ?? snap.as_of;
  const owners = new Map((await core.db.all<{ id: string; name: string }>("SELECT id, name FROM owners")).map((o) => [o.id, o.name]));
  const balances = await core.allBalances();
  const name = (id: string | null) => (id ? (balances.find((b) => b.id === id)?.name ?? id) : null);

  // --- obligations for the month (+ undated open ones) ---------------------
  const obligationRows = await core.db.all<{ id: string; name: string; amount_minor: number; currency: string; due_date: string | null; kind: string; linked_account_id: string | null; status: string; confidence: string; notes: string | null; paid_at: string | null; paid_minor: number }>(
    `SELECT o.*, ${PAID_SQL} AS paid_minor FROM obligations o WHERE o.status <> 'cancelled' AND (o.due_date LIKE ? OR (o.due_date IS NULL AND o.status <> 'paid')) ORDER BY o.due_date IS NULL, o.due_date, o.name`,
    [`${ym}%`],
  );
  const obligations: Obligation[] = obligationRows.map((o) => {
    const unknown = oblFields.get(o.id)?.amount_unknown === true;
    const overdue = o.status !== "paid" && !!o.due_date && o.due_date < today;
    return {
      id: o.id,
      day: o.due_date ? Number(o.due_date.slice(8, 10)) : null,
      dueDate: o.due_date,
      dateConfirmed: o.confidence === "confirmed",
      confidence: o.confidence,
      label: o.name,
      // A partly paid obligation shows what's left; the note says how much was paid.
      amount: unknown ? null : o.status !== "paid" && o.paid_minor > 0 ? Math.max(0, o.amount_minor - o.paid_minor) : o.amount_minor,
      currency: o.currency,
      status: o.status === "paid" ? "paid" : o.status === "disputed" ? "disputed" : overdue ? "overdue" : "upcoming",
      kind: o.kind === "card_minimum" ? "card" : o.kind === "loan" ? "loan" : o.kind === "family_debt" ? "family" : "bill",
      linkedAccount: name(o.linked_account_id),
      note:
        o.status !== "paid" && o.paid_minor > 0
          ? `${money(o.paid_minor, o.currency)} paid of ${money(o.amount_minor, o.currency)} · ${money(Math.max(0, o.amount_minor - o.paid_minor), o.currency)} left${o.notes ? ` · ${o.notes}` : ""}`
          : o.status === "paid" && o.paid_at && !/^paid/i.test(o.notes ?? "")
            ? `Paid ${shortDate(localDate(o.paid_at, core.tz))}${o.notes ? ` · ${o.notes}` : ""}`
            : (o.notes ?? undefined),
    };
  });

  // --- cards & loans ---------------------------------------------------------
  // The next unpaid obligation per account, in any month: a loan whose October
  // installment is paid still has a November one.
  const nextUnpaid = new Map<string, { id: string; amount_minor: number; due_date: string | null; kind: string; status: string; paid_minor: number }>();
  for (const o of await core.db.all<{ id: string; linked_account_id: string; amount_minor: number; due_date: string | null; kind: string; status: string; paid_minor: number }>(
    `SELECT o.*, ${PAID_SQL} AS paid_minor FROM obligations o WHERE o.linked_account_id IS NOT NULL AND o.status IN ('planned','pending','disputed') ORDER BY o.due_date IS NULL, o.due_date`,
  )) {
    if (!nextUnpaid.has(o.linked_account_id)) nextUnpaid.set(o.linked_account_id, o);
  }
  const cardSnaps = await core.db.all<{ card_account_id: string; as_of: string; debt_minor: number; available_credit_minor: number | null; credit_limit_minor: number | null; minimum_minor: number | null; minimum_due_date: string | null }>(
    `SELECT * FROM (SELECT cs.*, ROW_NUMBER() OVER (PARTITION BY card_account_id ORDER BY as_of DESC, id DESC) rn FROM card_snapshots cs) WHERE rn = 1`,
  );
  const liab = snap.liabilities;
  // Cards with any posting after their latest snapshot.
  const movedAfter = new Set(
    (
      await core.db.all<{ account_id: string }>(
        `SELECT DISTINCT p.account_id FROM postings p JOIN transactions t ON t.id = p.transaction_id
         JOIN (SELECT card_account_id, MAX(as_of) AS as_of FROM card_snapshots GROUP BY card_account_id) cs ON cs.card_account_id = p.account_id
         WHERE t.status <> 'draft' AND t.occurred_at > cs.as_of`,
      )
    ).map((r) => r.account_id),
  );
  const cards = liab
    .filter((l) => accFields.get(l.id)?.kind === "card")
    .map((l) => {
      const cs = cardSnaps.find((c) => c.card_account_id === l.id);
      const limit = cs?.credit_limit_minor ?? (accFields.get(l.id)?.credit_limit_minor as number | undefined) ?? null;
      // Prefer the next unpaid minimum in any month; otherwise this month's (to say it's paid).
      const upcoming = nextUnpaid.get(l.id);
      const open = upcoming?.kind === "card_minimum" ? upcoming : obligationRows.find((o) => o.linked_account_id === l.id && o.kind === "card_minimum");
      // Available credit: the bank's own figure while nothing has touched the card
      // since its snapshot; once anything has, an estimate (limit − ledger debt).
      const reported = !!cs && cs.available_credit_minor !== null && l.checkpoint_as_of === cs.as_of && !movedAfter.has(l.id);
      return {
        id: l.id,
        label: l.name,
        bank: l.institution ?? "",
        currency: l.currency,
        debt: l.balance_minor,
        available: reported ? cs!.available_credit_minor : limit !== null ? limit - l.balance_minor : null,
        availableEstimated: !reported && limit !== null,
        limit,
        minimum: open && !oblFields.get(open.id)?.amount_unknown ? (open.status === "paid" ? open.amount_minor : Math.max(0, open.amount_minor - open.paid_minor)) : null,
        due: open?.due_date ? shortDate(open.due_date) : null,
        snapshotAt: l.checkpoint_as_of ? localDate(l.checkpoint_as_of, core.tz) : null,
        note: open ? (open.status === "paid" ? "Minimum paid" : open.paid_minor > 0 ? `Minimum partly paid (${money(open.paid_minor, l.currency)} of ${money(open.amount_minor, l.currency)})` : open.status === "pending" ? "Minimum pending" : undefined) : undefined,
      };
    })
    .sort((a, b) => b.debt - a.debt);

  const loans = liab
    .filter((l) => accFields.get(l.id)?.kind === "loan" || accFields.get(l.id)?.kind === "family_debt")
    .map((l) => {
      const f = accFields.get(l.id) ?? {};
      const next = nextUnpaid.get(l.id);
      return {
        id: l.id,
        label: l.name,
        bank: l.institution ?? (f.kind === "family_debt" ? "Family" : ""),
        currency: l.currency,
        balance: l.balance_known ? l.balance_minor : null,
        installment: (f.installment_minor as number | undefined) ?? next?.amount_minor ?? null,
        paid: (f.installments_paid as number | undefined) ?? null,
        total: (f.installments_total as number | undefined) ?? null,
        nextDue: next?.due_date ? shortDate(next.due_date) : null,
        rate: f.rate as string | undefined,
        asOf: l.checkpoint_as_of ? localDate(l.checkpoint_as_of, core.tz) : null,
        confidence: "",
        priority: f.priority === true,
        note: f.note as string | undefined,
      };
    });
  const checkpointSources = await core.db.all<{ account_id: string; source_kind: string }>(
    "SELECT account_id, source_kind FROM (SELECT account_id, source_kind, ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY as_of DESC, id DESC) rn FROM balance_checkpoints WHERE accepted = 1) WHERE rn = 1",
  );
  for (const l of loans) l.confidence = checkpointSources.find((c) => c.account_id === l.id)?.source_kind ?? "";

  // --- income ----------------------------------------------------------------
  const monthTx = await core.history({ from_date: `${ym}-01`, to_date: `${ym}-31`, limit: 500 });
  const received = monthTx
    .filter((t) => t.kind === "income" && t.status !== "reversed")
    .map((t) => {
      const asset = t.postings.find((p) => p.side === "debit")!;
      const acc = balances.find((b) => b.id === asset.account_id);
      return { date: t.local_date, source: t.description, amount: asset.amount_minor, currency: acc?.currency ?? base, account: acc?.name ?? asset.account_id };
    });
  const expectedRows = await core.db.all<{ source: string; amount_minor: number | null; currency: string; expected_to: string | null; status: string; confidence: string | null; notes: string | null }>(
    "SELECT * FROM expected_inflows WHERE status <> 'received' ORDER BY CASE status WHEN 'confirmed_arrangement' THEN 0 WHEN 'expected' THEN 1 WHEN 'scenario' THEN 2 ELSE 3 END, amount_minor DESC",
  );
  const expected: ExpectedIncome[] = expectedRows.map((e) => ({
    source: e.source,
    amount: e.amount_minor,
    currency: e.currency,
    approx: e.confidence === "working" || e.status === "scenario",
    status: e.status === "confirmed_arrangement" ? "confirmed" : e.status === "cancelled" ? "cancelled" : e.status === "scenario" && e.confidence === "low" && e.amount_minor === null ? "prospective" : (e.status as "expected" | "scenario"),
    overdue: (e.status === "expected" || e.status === "confirmed_arrangement") && !!e.expected_to && e.expected_to < today,
    note: e.notes ?? undefined,
  }));

  // --- attention (derived) & reconciliation ------------------------------------
  const issues: Issue[] = [];
  for (const o of obligations.filter((o) => o.status !== "paid" && o.dueDate && daysBetween(today, o.dueDate) <= 7 && o.amount !== null)) {
    const d = daysBetween(today, o.dueDate!);
    issues.push({ severity: o.status === "overdue" ? "high" : d <= 7 && o.kind === "card" ? "high" : "medium", title: `${o.label} — ${money(o.amount!, o.currency)} ${o.status === "overdue" ? "OVERDUE" : d === 0 ? "due today" : `due in ${d}d`}`, detail: o.note ?? "" });
  }
  for (const o of obligations.filter((o) => o.amount === null && o.status !== "paid")) issues.push({ severity: "low", title: `${o.label}: amount unknown`, detail: "Add it when the statement shows it." });
  for (const o of obligations.filter((o) => o.status !== "paid" && o.confidence === "inferred" && o.amount !== null && o.dueDate && daysBetween(today, o.dueDate) > 7)) {
    issues.push({ severity: "low", title: `${o.label}: date inferred`, detail: `Assumed ${shortDate(o.dueDate!)} from last month's pattern — confirm.` });
  }
  for (const e of expected.filter((e) => e.overdue)) issues.push({ severity: "medium", title: `${e.source} is late`, detail: `${e.amount !== null ? money(e.amount, e.currency) : "Amount TBD"} — ${e.note ?? "expected earlier"}` });
  for (const d of snap.drafts as { description: string }[]) issues.push({ severity: "medium", title: `Draft: ${d.description}`, detail: "Needs the paying account before it counts." });
  const recurring = await core.db.all<{ id: string; name: string; amount_minor: number | null; currency: string; confidence: string; kind: string; notes: string | null; owner_id: string }>(
    "SELECT * FROM recurring_rules WHERE active = 1 AND kind <> 'subscription'",
  );
  for (const r of recurring.filter((r) => r.confidence === "inferred")) issues.push({ severity: "low", title: `${r.name}${r.amount_minor ? ` ${money(r.amount_minor, r.currency)}` : ""}: not confirmed`, detail: r.notes ?? "" });
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);

  const reconciliation = (snap.reconciliation_issues as { id: string; account_id: string; detected_at: string; expected_balance_minor: number | null; reported_balance_minor: number; difference_minor: number | null; explanation: string }[]).map((r) => {
    const acc = balances.find((b) => b.id === r.account_id);
    return {
      id: r.id,
      account: acc?.name ?? r.account_id,
      currency: acc?.currency ?? base,
      difference: r.difference_minor,
      expected: r.expected_balance_minor,
      reported: r.reported_balance_minor,
      ageDays: daysBetween(localDate(r.detected_at, core.tz), today),
      note: r.explanation,
    };
  });

  // --- subscriptions & notes -----------------------------------------------------
  const subRows = await core.db.all<{ id: string; name: string; amount_minor: number | null; currency: string; active: number; notes: string | null }>(
    "SELECT * FROM recurring_rules WHERE kind = 'subscription' ORDER BY active DESC, currency <> ?, currency, amount_minor DESC",
    [base],
  );
  const subscriptions: Subscription[] = subRows.map((s) => {
    const f = recFields.get(s.id) ?? {};
    return {
      name: s.name,
      amount: s.amount_minor,
      currency: s.currency,
      payer: (f.payer as string) ?? "",
      // A paused rule says so even if an older label said "Active"; a "Cancelled" label is kept.
      status: s.active ? ((f.status_label as string) ?? "Active") : /cancel/i.test(String(f.status_label ?? "")) ? (f.status_label as string) : "Paused",
      tone: (s.active ? ((f.tone as string) ?? "ok") : "muted") as Subscription["tone"],
      covered: f.covered === true,
      note: s.notes ?? undefined,
    };
  });
  const notes = (await core.db.all<{ author: string; icon: string | null; body: string }>("SELECT author, icon, body FROM notes WHERE archived = 0 ORDER BY created_at DESC LIMIT 6")).map((n) => ({ icon: n.icon ?? "•", author: n.author, text: n.body }));

  const [y, m] = ym.split("-").map(Number);
  return {
    mock: false,
    eyebrow: meta.get("report_eyebrow") ?? "Household ledger",
    footer: meta.get("report_footer") ?? "",
    generatedAt: snap.generated_at,
    currency: base,
    timezone: core.tz,
    ownerName: owners.get(snap.me.id) ?? "You",
    asOf: today,
    since: localDate(since, core.tz),
    monthLabel: `${MONTH_NAMES[m - 1]} ${y}`,
    daysInMonth: new Date(Date.UTC(y, m, 0)).getUTCDate(),
    accounts: [...snap.me.accounts].sort((x, y) => y.balance_minor - x.balance_minor).map((a) => ({ id: a.id, label: a.name, amount: a.balance_minor, color: (a.fields.color as string) ?? colorFor(a.id) })),
    separate: [
      ...snap.others.map((o) => {
        const who = owners.get(o.owner_id) ?? o.owner_id;
        return { label: `${who} — ${o.name}`, amount: o.balance_minor, currency: o.currency, note: `${who}'s money. Never counted as yours.` };
      }),
      ...snap.foreign_currency.map((f) => {
        const res = snap.reservations.filter((r) => r.account_id === f.id);
        return { label: f.name, amount: f.balance_minor, currency: f.currency, note: `${res.length ? res.map((r) => r.label).join(", ") + ". " : ""}Not added to your ${base} total.` };
      }),
    ],
    heldTotal: snap.held_total,
    earmarks: snap.reservations.filter((r) => r.currency === base).map((r) => ({ label: r.label, amount: r.amount_minor, accountId: r.account_id })),
    obligations,
    issues,
    reconciliation,
    cards,
    loans,
    received,
    expected,
    subscriptions,
    notes,
  };
}

/** Journal entries as report rows. */
export async function loadTxns(core: Core, opts: { from?: string; to?: string } = {}): Promise<Txn[]> {
  const journal = await core.history({ from_date: opts.from ?? null, to_date: opts.to ?? null, limit: 500 });
  const balances = await core.allBalances();
  const accName = (id: string) => balances.find((b) => b.id === id)?.name ?? id;
  return journal.map((t) => {
    const kind = viewKind(t.kind);
    const money = t.postings.find((p) => {
      const a = balances.find((b) => b.id === p.account_id);
      return a && (a.account_type === "asset" || a.account_type === "liability");
    }) ?? t.postings[0];
    const acc = balances.find((b) => b.id === money?.account_id);
    return {
      id: t.id,
      date: t.local_date,
      dateLabel: shortDate(t.local_date),
      kind: t.status === "reversed" ? "reversal" : kind,
      group: groupFor(t.kind),
      category: t.category ?? "",
      description: t.description,
      amount: money?.amount_minor ?? 0,
      currency: acc?.currency ?? core.base,
      account: money ? accName(money.account_id) : null,
      note: [t.status === "reversed" ? "Reversed" : "", t.notes ?? ""].filter(Boolean).join(" · "),
      splits: t.splits.map((s) => ({ label: s.label, amount: s.amount_minor, owner: s.economic_owner_id, reimbursable: s.reimbursable === 1 })),
    };
  });
}

function viewKind(k: string): TxnKind {
  switch (k) {
    case "income":
      return "income";
    case "expense":
    case "card_purchase":
    case "bill_payment":
    case "waiver":
      return "expense";
    case "debt_payment":
      return "debt_payment";
    case "reimbursement":
      return "reimbursement";
    case "passthrough":
      return "passthrough";
    case "reversal":
      return "reversal";
    default:
      return "transfer";
  }
}

function groupFor(k: string): string {
  return { income: "Income", expense: "Spending", card_purchase: "Spending", bill_payment: "Bills", waiver: "Reimbursements", debt_payment: "Debt payments", reimbursement: "Reimbursements", passthrough: "Pass-through", reversal: "Corrections" }[k] ?? "Transfers";
}

function shortDate(d: string): string {
  const [, m, day] = d.split("-").map(Number);
  return `${MONTH_NAMES[m - 1].slice(0, 3)} ${day}`;
}
