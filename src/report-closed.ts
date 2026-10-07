import { CSS } from "./report-css.ts";
import { fmt } from "./money.ts";

// Frozen month-close page (money_truths_YYYY-MM_closed.html). Rendered once
// from the close snapshot and stored in month_close_exports.report_html;
// never re-rendered from live data.

interface ClosedSnapshot {
  month: string;
  closed_at: string;
  currency: string;
  timezone: string;
  notes: string | null;
  end_balances: { id: string; name: string; owner_id: string; is_primary: number; account_type: string; currency: string; balance_minor: number; active: number }[];
  summary: {
    cash_in: number;
    cash_out: number;
    economic_spending: number;
    income: number;
    debt_payments: number;
    card_purchases: number;
    reimbursements_received: number;
    waived: number;
    earned_minus_spent: number;
    transactions: number;
  };
  obligations: { name: string; due_date: string | null; amount_minor: number; currency: string; status_at_month_end: string; remaining_at_month_end_minor: number }[];
  open_reconciliation_issues: { account_id: string; difference_minor: number | null; explanation: string | null }[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function renderClosedMonth(snapshot: unknown): string {
  const s = snapshot as ClosedSnapshot;
  const label = `${MONTHS[Number(s.month.slice(5, 7)) - 1]} ${s.month.slice(0, 4)}`;
  const m = (n: number, cur = s.currency) => fmt(n, cur);
  const t = s.summary;
  const tiles: [string, string][] = [
    ["Income", m(t.income)],
    ["Spent", m(t.economic_spending)],
    ["Earned − spent", m(t.earned_minus_spent)],
    ["Debt payments", m(t.debt_payments)],
    ["Card purchases", m(t.card_purchases)],
    ["Reimbursed", m(t.reimbursements_received)],
    ["Cash in", m(t.cash_in)],
    ["Cash out", m(t.cash_out)],
  ];
  const shown = (b: ClosedSnapshot["end_balances"][number]) => b.active === 1 || b.balance_minor !== 0;
  const assets = s.end_balances.filter((b) => b.account_type === "asset" && shown(b));
  const debts = s.end_balances.filter((b) => (b.account_type === "liability" || b.account_type === "payable") && !b.id.startsWith("clear_") && shown(b));
  const table = (rows: typeof s.end_balances) =>
    rows.map((b) => `<tr><td>${esc(b.name)}${b.is_primary ? "" : ` <span class="muted tiny">(${esc(b.owner_id)})</span>`}</td><td class="num">${m(b.balance_minor, b.currency)}</td></tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Money Truths — ${esc(label)} (closed)</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header class="top">
  <div>
    <p class="eyebrow">Month close</p>
    <h1>${esc(label)}</h1>
    <p class="muted">Closed ${esc(new Date(s.closed_at).toLocaleString("en-US", { timeZone: s.timezone, dateStyle: "medium", timeStyle: "short" }))} · frozen, never recalculated</p>
    <p class="gen">Generated from canonical Money Truths database</p>
  </div>
  <span class="mock">Closed</span>
</header>

<section class="card">
  <h2>Month summary <span class="count">${t.transactions} entries</span></h2>
  <div class="tiles">${tiles.map(([l, v]) => `<div><span class="label">${l}</span><b>${v}</b></div>`).join("")}</div>
</section>

<div class="two">
<section class="card"><h2>End balances — money</h2><table><tbody>${table(assets)}</tbody></table></section>
<section class="card"><h2>End balances — debts</h2><table><tbody>${table(debts)}</tbody></table></section>
</div>

<section class="card">
  <h2>Obligations due in ${esc(label)}</h2>
  <table><thead><tr><th>Due</th><th>Obligation</th><th class="num">Amount</th><th>At month-end</th></tr></thead><tbody>
  ${s.obligations.map((o) => `<tr><td>${esc(o.due_date ?? "")}</td><td>${esc(o.name)}</td><td class="num">${m(o.amount_minor, o.currency)}</td><td>${esc(o.status_at_month_end)}${o.remaining_at_month_end_minor > 0 && o.status_at_month_end !== "paid" ? ` · ${m(o.remaining_at_month_end_minor, o.currency)} left` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">None.</td></tr>`}
  </tbody></table>
</section>

<section class="card">
  <h2>Unresolved at month-end <span class="count">${s.open_reconciliation_issues.length}</span></h2>
  ${s.open_reconciliation_issues.length ? `<ul class="issues">${s.open_reconciliation_issues.map((i) => `<li class="medium"><span class="sev"></span><div><b>${esc(i.account_id)} ${i.difference_minor === null ? "" : m(i.difference_minor)}</b><div class="muted">${esc(i.explanation ?? "")}</div></div></li>`).join("")}</ul>` : `<p class="muted">None.</p>`}
</section>
${s.notes ? `<section class="card"><h2>Notes</h2><p>${esc(s.notes)}</p></section>` : ""}
</main>
</body>
</html>`;
}

function esc(x: string): string {
  return x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
