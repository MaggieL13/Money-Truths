// The shape the Money Truths report and widget render. Built from the
// database by src/core/report-data.ts; renderers never compute accounting.
// Every amount is an integer in its currency's minor unit (cents, or whole
// units for currencies without decimals). Amounts without their own
// `currency` field are in the view's main currency.

/** paid · upcoming (amber) · overdue (red, past due and unpaid) · disputed (red). */
export type Status = "paid" | "upcoming" | "overdue" | "disputed";
export type Severity = "high" | "medium" | "low";

export interface Account {
  id: string;
  label: string;
  amount: number;
  color: string;
}

export interface Separate {
  label: string;
  amount: number;
  currency: string;
  note: string;
}

export interface Earmark {
  label: string;
  amount: number;
  accountId: string | null;
}

export interface Obligation {
  id: string;
  /** Day of the report month; null = no fixed date. */
  day: number | null;
  dueDate: string | null;
  dateConfirmed: boolean;
  confidence: string;
  label: string;
  /** null = amount not known yet. */
  amount: number | null;
  currency: string;
  status: Status;
  kind: "card" | "loan" | "bill" | "family";
  linkedAccount: string | null;
  note?: string;
}

/** Derived "needs attention" items (not reconciliation issues). */
export interface Issue {
  severity: Severity;
  title: string;
  detail: string;
}

export interface Reconciliation {
  id: string;
  account: string;
  currency: string;
  difference: number | null;
  expected: number | null;
  reported: number;
  ageDays: number;
  note: string;
}

export interface CardDebt {
  id: string;
  label: string;
  bank: string;
  currency: string;
  debt: number;
  available: number | null;
  /** True when available is limit − ledger debt rather than the bank's reported figure. */
  availableEstimated: boolean;
  limit: number | null;
  minimum: number | null;
  due: string | null;
  snapshotAt: string | null;
  note?: string;
}

export interface Loan {
  id: string;
  label: string;
  bank: string;
  currency: string;
  balance: number | null;
  installment: number | null;
  paid: number | null;
  total: number | null;
  nextDue: string | null;
  rate?: string;
  asOf: string | null;
  confidence: string;
  priority: boolean;
  note?: string;
}

export interface ExpectedIncome {
  source: string;
  amount: number | null;
  currency: string;
  approx: boolean;
  status: "confirmed" | "expected" | "scenario" | "cancelled" | "prospective";
  overdue: boolean;
  note?: string;
}

export interface Received {
  date: string;
  source: string;
  amount: number;
  currency: string;
  account: string;
}

export interface Subscription {
  name: string;
  amount: number | null;
  currency: string;
  payer: string;
  status: string;
  tone: "ok" | "wait" | "bad" | "muted";
  /** Paid by someone else; costs the user nothing. */
  covered: boolean;
  note?: string;
}

export interface HouseNote {
  icon: string;
  author: string;
  text: string;
}

export interface MoneyTruthsView {
  mock: boolean;
  /** Report header/footer text, stored as data (schema_meta). */
  eyebrow: string;
  footer: string;
  generatedAt: string;
  /** Main currency (ISO 4217) and IANA timezone of this ledger. */
  currency: string;
  timezone: string;
  /** The primary owner's display name. */
  ownerName: string;
  /** Local date the view describes. */
  asOf: string;
  /** Local date of the first ledger entry (or setup). */
  since: string;
  monthLabel: string;
  daysInMonth: number;
  accounts: Account[];
  separate: Separate[];
  heldTotal: number;
  earmarks: Earmark[];
  obligations: Obligation[];
  issues: Issue[];
  reconciliation: Reconciliation[];
  cards: CardDebt[];
  loans: Loan[];
  received: Received[];
  expected: ExpectedIncome[];
  subscriptions: Subscription[];
  notes: HouseNote[];
}

export type TxnKind =
  | "income"
  | "expense"
  | "debt_payment"
  | "reimbursement"
  | "receivable"
  | "transfer"
  | "passthrough"
  | "expected"
  | "reversal";

export interface Txn {
  id: string;
  /** YYYY-MM-DD, or YYYY-MM when the day is unknown. */
  date: string;
  dateLabel: string;
  kind: TxnKind;
  group: string;
  category: string;
  description: string;
  amount: number;
  currency: string;
  account: string | null;
  note: string;
  splits?: { label: string; amount: number; owner: string; reimbursable: boolean }[];
}
