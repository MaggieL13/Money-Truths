import type { MoneyTruthsView, Obligation } from "./view.ts";
import { fmt } from "./money.ts";

// Compact phone surface: a JSON payload for native widget apps (KWGT on
// Android, Scriptable on iOS) and a tiny HTML card for a home-screen
// shortcut. Both derive from the same view as the full report.

export interface WidgetData {
  asOf: string;
  generatedAt: string;
  /** Main currency; amounts are minor units. `text` fields are preformatted. */
  currency: string;
  liquid: number;
  free: number;
  next: { date: string; label: string; amount: number | null; currency: string; text: string; status: string; daysAway: number }[];
  dueThisMonth: number;
  urgent: number;
  text: { liquid: string; free: string; dueThisMonth: string };
}

export function widgetData(v: MoneyTruthsView): WidgetData {
  const today = Number(v.asOf.slice(8, 10));
  const liquid = v.accounts.reduce((a, x) => a + x.amount, 0);
  const free = liquid - v.earmarks.reduce((a, x) => a + x.amount, 0);
  const open = v.obligations.filter((o) => o.status !== "paid");
  const next = open
    .filter((o): o is Obligation & { day: number } => o.day !== null && o.amount !== null && (o.day >= today || o.status === "overdue"))
    // Overdue items and card/loan payments due within a week outrank nearer routine bills.
    .sort((a, b) => urgency(a, today) - urgency(b, today) || a.day - b.day)
    .slice(0, 3)
    .map((o) => ({ date: o.dueDate!, label: o.label, amount: o.amount, currency: o.currency, text: o.amount === null ? "TBD" : fmt(o.amount, o.currency), status: o.status, daysAway: o.day - today }));
  const dueThisMonth = open.filter((o) => o.currency === v.currency).reduce((a, o) => a + (o.amount ?? 0), 0);
  return {
    asOf: v.asOf,
    generatedAt: v.generatedAt,
    currency: v.currency,
    liquid,
    free,
    next,
    dueThisMonth,
    urgent: v.issues.filter((i) => i.severity === "high").length,
    text: { liquid: fmt(liquid, v.currency), free: fmt(free, v.currency), dueThisMonth: fmt(dueThisMonth, v.currency) },
  };
}

function urgency(o: Obligation & { day: number }, today: number): number {
  if (o.status === "overdue") return 0;
  return (o.kind === "card" || o.kind === "loan") && o.day - today <= 7 ? 1 : 2;
}

export function renderWidget(v: MoneyTruthsView): string {
  const d = widgetData(v);
  const g = (n: number) => fmt(n, d.currency);
  const when = (n: number) => (n < 0 ? `${-n}d late` : n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n}d`);
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111014">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Ledger">
<title>Ledger</title>
<style>
:root{--bg:#111014;--card:#1a171e;--raised:#221d27;--border:#3a303e;--text:#f4edf5;--muted:#b7aeb9;--gold:#e0bd72;--good:#aee3bc;--warn:#f3d796;--bad:#ffb5bb;--violet:#9a78d1}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;padding:max(16px,env(safe-area-inset-top)) 16px 16px}
.w{max-width:420px;margin:auto;background:var(--card);border:1px solid var(--border);border-radius:22px;padding:18px}
.top{display:flex;justify-content:space-between;align-items:center;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold);font-weight:750}
.urgent{background:#3b2327;color:var(--bad);border-radius:999px;padding:2px 8px;letter-spacing:0;text-transform:none;font-size:12px}
.big{font-size:38px;font-weight:800;letter-spacing:-.02em;margin:8px 0 0;font-variant-numeric:tabular-nums}
.sub{color:var(--muted);font-size:13px}.sub b{color:var(--good)}
ul{list-style:none;padding:0;margin:14px 0 0;display:grid;grid-template-columns:minmax(0,1fr);gap:8px}
li{display:flex;justify-content:space-between;gap:10px;background:var(--raised);border-radius:12px;padding:10px 12px;font-size:14px}
li .l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
li .r small{display:block;color:var(--muted);font-size:11px}
li.upcoming .r small{color:var(--warn)}li.overdue .r small{color:var(--bad)}
.foot{display:flex;justify-content:space-between;margin-top:12px;color:var(--muted);font-size:12px}
a{color:var(--violet);text-decoration:none;font-weight:600}
</style>
</head>
<body>
<div class="w">
  <div class="top"><span>Ledger</span>${d.urgent ? `<span class="urgent">⚠ ${d.urgent} urgent</span>` : ""}</div>
  <div class="big">${g(d.liquid)}</div>
  <div class="sub">mine · <b>${g(d.free)}</b> free after earmarks</div>
  <ul>
    ${d.next
      .map(
        (n) => `<li class="${n.status}"><span class="l">${esc(n.label)}</span><span class="r">${esc(n.text)}<small>${when(n.daysAway)}${n.status === "overdue" ? " · overdue" : ""}</small></span></li>`,
      )
      .join("")}
  </ul>
  <div class="foot"><span>${g(d.dueThisMonth)} still due this month</span><a href="./">Open ›</a></div>
</div>
</body>
</html>`;
}
