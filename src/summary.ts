import type { Txn, TxnKind } from "./view.ts";

// Period numbers for the report, from Core.periodSummary (derived from
// postings). Reimbursements reduce what something cost you; they are never income.

export interface MonthNumbers {
  source: "journal" | "none";
  count: number;
  income: number;
  /** Economic spending, including card purchases. */
  spending: number;
  reimbursements: number;
  debtPayments: number;
  cashIn: number | null;
  cashOut: number | null;
  cardPurchases: number | null;
  /** income − spending. Debt paydown is separate. */
  net: number;
  byGroup: { group: string; amount: number; count: number }[];
}

export const EMPTY: MonthNumbers = {
  source: "none", count: 0, income: 0, spending: 0, reimbursements: 0, debtPayments: 0, cashIn: null, cashOut: null, cardPurchases: null, net: 0, byGroup: [],
};

export interface JournalSummary {
  cash_in: number;
  cash_out: number;
  economic_spending: number;
  income: number;
  debt_payments: number;
  card_purchases: number;
  reimbursements_received: number;
  by_category: { category: string; amount_minor: number }[];
  transactions: number;
}

export function fromJournal(s: JournalSummary): MonthNumbers {
  return {
    source: "journal",
    count: s.transactions,
    income: s.income,
    spending: s.economic_spending,
    reimbursements: s.reimbursements_received,
    debtPayments: s.debt_payments,
    cashIn: s.cash_in,
    cashOut: s.cash_out,
    cardPurchases: s.card_purchases,
    net: s.income - s.economic_spending,
    byGroup: s.by_category.filter((c) => c.amount_minor > 0).map((c) => ({ group: c.category, amount: c.amount_minor, count: 0 })),
  };
}

export function inMonth(txns: Txn[], ym: string): Txn[] {
  return txns.filter((t) => t.date.startsWith(ym));
}

/** Case- and accent-insensitive search across text fields; digit-only queries also match amounts. */
export function search(txns: Txn[], q: string): Txn[] {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return txns.filter((t) => {
    const hay = fold(`${t.description} ${t.category} ${t.group} ${t.account ?? ""} ${t.note} ${t.kind} ${t.dateLabel}`);
    const amount = String(t.amount);
    return terms.every((term) => hay.includes(term) || (/^\d+$/.test(term) && amount.includes(term)));
  });
}

export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}\s.-]/gu, "");
}

export function signFor(kind: TxnKind): string {
  return kind === "income" || kind === "reimbursement" ? "+" : kind === "expense" || kind === "debt_payment" ? "−" : "";
}

/** Chronological; entries without a known day sort after the dated ones of their month. */
export function byDate(a: Txn, b: Txn): number {
  const k = (t: Txn) => (t.date.length === 7 ? `${t.date}-99` : t.date);
  return k(a).localeCompare(k(b)) || a.id.localeCompare(b.id);
}
