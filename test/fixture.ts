import type { Stmt } from "../src/db.ts";

// A made-up household for tests: "Sam", who keeps a ledger in USD and
// sometimes fronts money for a roommate, "Alex". Every name and number here
// is fictional. Amounts are cents.

export const CUTOVER = "2026-09-30T14:38:00.000Z";

type Row = Record<string, string | number | null>;

const OWNERS: Row[] = [
  { id: "me", name: "Sam", is_primary: 1 },
  { id: "alex", name: "Alex", is_primary: 0 },
];

const asset = (id: string, name: string, institution: string | null, currency = "USD", owner = "me"): Row => ({
  id, owner_id: owner, name, institution, account_type: "asset", normal_side: "debit", currency, is_liquid: 1, include_in_owner_total: 1, active: 1, last4: null, notes: null,
});
const liability = (id: string, name: string, institution: string | null, last4: string | null = null): Row => ({
  id, owner_id: "me", name, institution, account_type: "liability", normal_side: "credit", currency: "USD", is_liquid: 0, include_in_owner_total: 1, active: 1, last4, notes: null,
});

const ACCOUNTS: Row[] = [
  asset("asset_checking", "Checking", "First Demo Bank"),
  asset("asset_savings", "Savings", "First Demo Bank"),
  asset("asset_bills", "Bills account", "Second Demo Bank"),
  asset("asset_cash", "Cash", null),
  asset("asset_euro", "Euro wallet", "Demo Wallet", "EUR"),
  asset("asset_alex_shop", "Alex's shop money", null, "USD", "alex"),
  liability("liab_visa", "Visa", "Second Demo Bank", "4242"),
  liability("liab_mastercard", "Mastercard", "First Demo Bank"),
  liability("liab_store_card", "Store card", "Demo Store"),
  liability("liab_car_loan", "Car loan", "First Demo Bank"),
  liability("liab_home_loan", "Home loan", "Demo Credit Union"),
];

/** Balances as of the cutover (cents; debts are positive amounts owed). */
export const BALANCES: Record<string, number> = {
  asset_checking: 250_000,
  asset_savings: 70_000,
  asset_bills: 27_500,
  asset_cash: 1_000,
  asset_euro: 2_000,
  asset_alex_shop: 4_600,
  liab_visa: 412_350,
  liab_mastercard: 0,
  liab_store_card: 200_000,
  liab_home_loan: 18_750_000,
};

export const LIQUID = 250_000 + 70_000 + 27_500 + 1_000;
export const RESERVED = 27_500;

const OBLIGATIONS: Row[] = [
  { id: "obl_phone_2026_10", name: "Phone bill", amount_minor: 6_499, currency: "USD", due_date: "2026-10-03", kind: "utility", linked_account_id: null, status: "planned", confidence: "inferred", paid_at: null, notes: null },
  { id: "obl_car_loan_2026_10", name: "Car loan October", amount_minor: 41_275, currency: "USD", due_date: "2026-10-05", kind: "loan", linked_account_id: "liab_car_loan", status: "pending", confidence: "confirmed", paid_at: null, notes: null },
  { id: "obl_visa_2026_10", name: "Visa October minimum", amount_minor: 38_000, currency: "USD", due_date: "2026-10-06", kind: "card_minimum", linked_account_id: "liab_visa", status: "pending", confidence: "confirmed", paid_at: null, notes: null },
  { id: "obl_store_2026_10", name: "Store card October minimum", amount_minor: 3_500, currency: "USD", due_date: "2026-10-06", kind: "card_minimum", linked_account_id: "liab_store_card", status: "paid", confidence: "confirmed", paid_at: "2026-09-25T15:00:00.000Z", notes: "Paid before the ledger started" },
  { id: "obl_home_2026_10", name: "Home loan October", amount_minor: 132_000, currency: "USD", due_date: "2026-10-11", kind: "loan", linked_account_id: "liab_home_loan", status: "planned", confidence: "confirmed", paid_at: null, notes: null },
];

const FIELDS: [string, string, unknown][] = [
  ["liab_visa", "kind", "card"],
  ["liab_mastercard", "kind", "card"],
  ["liab_store_card", "kind", "card"],
  ["liab_car_loan", "kind", "loan"],
  ["liab_car_loan", "balance_unknown", true],
  ["liab_car_loan", "installments_paid", 6],
  ["liab_car_loan", "installments_total", 24],
  ["liab_home_loan", "kind", "loan"],
];

function insert(table: string, row: Row): Stmt {
  const cols = Object.keys(row);
  return { sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, params: cols.map((c) => row[c]) };
}

const META: Row[] = [
  { key: "base_currency", value: "USD" },
  { key: "timezone", value: "America/Sao_Paulo" },
];

/** Owners and accounts only: no balances, plans or fields. */
export function accountsOnly(): Stmt[] {
  return [...META.map((m) => insert("schema_meta", m)), ...OWNERS.map((o) => insert("owners", o)), ...ACCOUNTS.map((a) => insert("accounts", a))];
}

/** The whole demo household as of the cutover. */
export function demoHousehold(): Stmt[] {
  return [
    ...accountsOnly(),
    { sql: "INSERT INTO schema_meta (key, value) VALUES ('setup_at', ?)", params: [CUTOVER] },
    // Cash had been counted the day before; it came up short, unexplained.
    insert("balance_checkpoints", { account_id: "asset_cash", as_of: "2026-09-29T15:00:00.000Z", balance_minor: 3_640, source_kind: "user", source_ref: null, note: null, accepted: 1 }),
    ...Object.entries(BALANCES).map(([account_id, balance_minor]) => insert("balance_checkpoints", { account_id, as_of: CUTOVER, balance_minor, source_kind: "statement", source_ref: null, note: "cutover", accepted: 1 })),
    insert("reconciliation_issues", { id: "rec_cash_sep", account_id: "asset_cash", detected_at: CUTOVER, expected_balance_minor: 3_640, reported_balance_minor: 1_000, difference_minor: -2_640, status: "open", explanation: "Cash count came up short.", resolved_at: null, resolution_transaction_id: null }),
    ...OBLIGATIONS.map((o) => insert("obligations", o)),
    insert("reservations", { id: "res_visa", label: "Visa minimum", amount_minor: 27_500, currency: "USD", account_id: "asset_bills", obligation_id: "obl_visa_2026_10", due_date: "2026-10-06", status: "active", notes: null }),
    insert("reservations", { id: "res_euro", label: "Trip deposit", amount_minor: 1_500, currency: "EUR", account_id: "asset_euro", obligation_id: null, due_date: null, status: "active", notes: null }),
    insert("recurring_rules", { id: "rr_music", name: "Music streaming", owner_id: "me", amount_minor: 1_099, currency: "USD", cadence: "monthly", next_due_date: "2026-10-15", end_date: null, kind: "subscription", linked_account_id: null, active: 1, confidence: "confirmed", notes: null }),
    insert("expected_inflows", { id: "exp_invoice", source: "Freelance invoice", amount_minor: 120_000, currency: "USD", expected_from: "2026-10-01", expected_to: "2026-10-10", status: "expected", confidence: "working", received_transaction_id: null, notes: null }),
    ...FIELDS.map(([id, key, value]) => insert("entity_fields", { entity_type: "account", entity_id: id, key, value_json: JSON.stringify(value), updated_at: CUTOVER })),
  ];
}
