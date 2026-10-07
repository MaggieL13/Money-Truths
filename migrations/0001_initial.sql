-- Money Truths schema. Based on the Money Truths blueprint schema, with the
-- ledger extensions, obligation payments and status history folded in, and
-- generic ownership (owners.is_primary) plus hashed access keys.
-- Schema changes go in new numbered migrations; never edit this file once applied.


PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1))
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  institution TEXT,
  account_type TEXT NOT NULL CHECK (
    account_type IN ('asset','liability','receivable','payable','income','expense','equity')
  ),
  normal_side TEXT NOT NULL CHECK (normal_side IN ('debit','credit')),
  currency TEXT NOT NULL,
  is_liquid INTEGER NOT NULL DEFAULT 0 CHECK (is_liquid IN (0,1)),
  include_in_owner_total INTEGER NOT NULL DEFAULT 1 CHECK (include_in_owner_total IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  last4 TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS balance_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of TEXT NOT NULL,
  balance_minor INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_ref TEXT,
  note TEXT,
  accepted INTEGER NOT NULL DEFAULT 1 CHECK (accepted IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_account_time
ON balance_checkpoints(account_id, as_of);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','posted','reversed')),
  idempotency_key TEXT NOT NULL UNIQUE,
  source_kind TEXT,
  source_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  reversed_by TEXT REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  account_id TEXT NOT NULL REFERENCES accounts(id),
  side TEXT NOT NULL CHECK (side IN ('debit','credit')),
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  memo TEXT
);

CREATE INDEX IF NOT EXISTS idx_postings_tx ON postings(transaction_id);
CREATE INDEX IF NOT EXISTS idx_postings_account ON postings(account_id);

CREATE TABLE IF NOT EXISTS obligations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  due_date TEXT,
  kind TEXT NOT NULL,
  linked_account_id TEXT REFERENCES accounts(id),
  status TEXT NOT NULL CHECK (status IN ('planned','pending','paid','cancelled','disputed')),
  confidence TEXT NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed','working','inferred')),
  paid_at TEXT,
  paid_transaction_id TEXT REFERENCES transactions(id),
  recurrence_id TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_obligations_due ON obligations(due_date, status);

CREATE TABLE IF NOT EXISTS recurring_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  amount_minor INTEGER,
  currency TEXT NOT NULL,
  cadence TEXT NOT NULL,
  next_due_date TEXT,
  end_date TEXT,
  kind TEXT NOT NULL,
  linked_account_id TEXT REFERENCES accounts(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  confidence TEXT NOT NULL DEFAULT 'working',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS expected_inflows (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  amount_minor INTEGER,
  currency TEXT NOT NULL,
  expected_from TEXT,
  expected_to TEXT,
  status TEXT NOT NULL CHECK (status IN ('scenario','expected','confirmed_arrangement','received','cancelled')),
  confidence TEXT,
  received_transaction_id TEXT REFERENCES transactions(id),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id),
  obligation_id TEXT REFERENCES obligations(id),
  due_date TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','released','spent','cancelled')),
  notes TEXT
);

CREATE TABLE IF NOT EXISTS reconciliation_issues (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  detected_at TEXT NOT NULL,
  expected_balance_minor INTEGER,
  reported_balance_minor INTEGER NOT NULL,
  difference_minor INTEGER,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','ignored')),
  explanation TEXT,
  resolved_at TEXT,
  resolution_transaction_id TEXT REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  occurred_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS month_closures (
  month TEXT PRIMARY KEY,
  closed_at TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  report_path TEXT,
  notes TEXT
);

CREATE VIEW IF NOT EXISTS latest_checkpoints AS
SELECT bc.*
FROM balance_checkpoints bc
JOIN (
  SELECT account_id, MAX(as_of) AS max_as_of
  FROM balance_checkpoints
  WHERE accepted = 1
  GROUP BY account_id
) x ON x.account_id = bc.account_id AND x.max_as_of = bc.as_of
WHERE bc.accepted = 1;

-- Ledger extensions

-- Idempotency for every mutation, including ones that create no transaction
-- (checkpoints, obligations, reservations, closes). transactions.idempotency_key
-- stays the guard for money movement; this table records the outcome so a
-- retry can return it.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Split detail for one gross purchase (rule J). The transaction keeps one
-- set of postings; splits describe who the money was economically for.
CREATE TABLE IF NOT EXISTS transaction_splits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  economic_owner_id TEXT NOT NULL REFERENCES owners(id),
  reimbursable INTEGER NOT NULL DEFAULT 0 CHECK (reimbursable IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_splits_tx ON transaction_splits(transaction_id);

-- Card-side facts that do not fit a balance checkpoint. The debt itself is
-- also written as a balance checkpoint on the card's liability account.
CREATE TABLE IF NOT EXISTS card_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of TEXT NOT NULL,
  debt_minor INTEGER NOT NULL,
  available_credit_minor INTEGER,
  credit_limit_minor INTEGER,
  minimum_minor INTEGER,
  minimum_due_date TEXT,
  statement_close_date TEXT,
  source_ref TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_card_snapshots ON card_snapshots(card_account_id, as_of);

-- Free-form fields, tags and organisation on any entity. Never affects
-- accounting; lets assistants add/remove/organise without schema changes.
CREATE TABLE IF NOT EXISTS entity_fields (
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id, key)
);

-- Short dated notes shown on the report.
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  icon TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);

-- Immutable month-close exports (spec 02 §13, test 21).
CREATE TABLE IF NOT EXISTS month_close_exports (
  month TEXT PRIMARY KEY REFERENCES month_closures(month),
  export_json TEXT NOT NULL,
  report_html TEXT NOT NULL
);

-- Obligation payments
CREATE TABLE IF NOT EXISTS obligation_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id TEXT NOT NULL REFERENCES obligations(id),
  transaction_id TEXT NOT NULL REFERENCES transactions(id),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obligation_payments ON obligation_payments(obligation_id);
CREATE INDEX IF NOT EXISTS idx_obligation_payments_tx ON obligation_payments(transaction_id);

-- Obligation status history
CREATE TABLE IF NOT EXISTS obligation_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id TEXT NOT NULL REFERENCES obligations(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obligation_status_history ON obligation_status_history(obligation_id, changed_at);

-- Access keys. Only SHA-256 hashes are stored; the keys themselves are shown
-- once, on the setup page. scope: write (full access) or read (view only).
CREATE TABLE IF NOT EXISTS access_keys (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('write','read')),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
