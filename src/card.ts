import { LedgerError, type Core } from "./core/index.ts";
import { VERSION } from "./version.ts";
import type { MoneyTruthsView, Obligation } from "./view.ts";
import { PALETTE, fmt } from "./money.ts";

// In-chat cards (MCP Apps). One view-only app renders every card; each tool
// returns structuredContent tagged with `card` (which layout) and `tool` +
// `args` (what refresh re-runs). No external resources, no writes.
// Amounts are minor units; `currency` is the main currency and items in
// another currency carry their own.
//
//   money_show_ledger  → ledger summary       (cardData)
//   money_show_due     → month due calendar    (dueData)
//   money_show_debts   → cards and loans       (debtsData)

export const CARD_URI = "ui://money-truths/ledger-card.html";
export const CARD_MIME = "text/html;profile=mcp-app";

/**
 * Resource metadata. The card loads nothing from the network, so it declares
 * an explicitly empty Content Security Policy: the MCP Apps keys, plus the
 * equivalent ChatGPT keys so ChatGPT enforces it too.
 */
export const CARD_RESOURCE_META = {
  ui: { prefersBorder: false, csp: { connectDomains: [] as string[], resourceDomains: [] as string[] } },
  "openai/widgetCSP": { connect_domains: [] as string[], resource_domains: [] as string[] },
  "openai/widgetPrefersBorder": false,
};

export interface CardData {
  card: "ledger";
  tool: "money_show_ledger";
  args: Record<string, never>;
  asOf: string;
  generatedAt: string;
  currency: string;
  monthLabel: string;
  liquid: number;
  free: number;
  reserved: number;
  accounts: { label: string; amount: number; color: string }[];
  separate: { label: string; amount: number; currency: string }[];
  wall: { due: number; gap: number; coverPct: number; open: number; unknown: number };
  next: { label: string; amount: number | null; currency: string; due: string; daysAway: number; status: string; note?: string }[];
  urgent: number;
  attention: number;
  unresolved: number;
  late: number;
  /** Nothing set up yet. */
  empty: boolean;
}

export function cardData(v: MoneyTruthsView): CardData {
  const today = Number(v.asOf.slice(8, 10));
  const liquid = v.accounts.reduce((s, a) => s + a.amount, 0);
  const reserved = v.earmarks.reduce((s, e) => s + e.amount, 0);
  const open = v.obligations.filter((o) => o.status !== "paid");
  const due = open.filter((o) => o.currency === v.currency).reduce((s, o) => s + (o.amount ?? 0), 0);
  const mon = v.monthLabel.slice(0, 3);
  const rank = (o: Obligation & { day: number }) => (o.status === "overdue" ? 0 : (o.kind === "card" || o.kind === "loan") && o.day - today <= 7 ? 1 : 2);
  return {
    card: "ledger",
    tool: "money_show_ledger",
    args: {},
    asOf: v.asOf,
    generatedAt: v.generatedAt,
    currency: v.currency,
    monthLabel: v.monthLabel,
    liquid,
    free: liquid - reserved,
    reserved,
    accounts: v.accounts.filter((a) => a.amount > 0).map((a) => ({ label: a.label, amount: a.amount, color: a.color })),
    separate: v.separate.map((s) => ({ label: s.label, amount: s.amount, currency: s.currency })),
    wall: {
      due,
      gap: Math.max(0, due - liquid),
      coverPct: due > 0 ? Math.min(100, Math.round((liquid / due) * 100)) : 100,
      open: open.length,
      unknown: open.filter((o) => o.amount === null).length,
    },
    next: open
      .filter((o): o is Obligation & { day: number } => o.day !== null && o.amount !== null && (o.day >= today || o.status === "overdue"))
      .sort((a, b) => rank(a) - rank(b) || a.day - b.day)
      .slice(0, 5)
      .map((o) => ({ label: o.label, amount: o.amount, currency: o.currency, due: `${mon} ${o.day}${o.dateConfirmed ? "" : "?"}`, daysAway: o.day - today, status: o.status })),
    urgent: v.issues.filter((i) => i.severity === "high").length,
    attention: v.issues.length,
    unresolved: v.reconciliation.length,
    late: v.expected.filter((e) => e.overdue).length,
    empty: v.accounts.length === 0 && v.separate.length === 0 && v.cards.length === 0 && v.loans.length === 0 && v.obligations.length === 0,
  };
}

// ---- Due calendar ------------------------------------------------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface DueItem {
  label: string;
  day: number | null;
  /** What's still owed; for paid items, what the obligation was. */
  amount: number | null;
  currency: string;
  paid: number;
  status: "paid" | "overdue" | "upcoming" | "partial" | "disputed";
  /** Past its due date and unpaid (independent of disputed). */
  late: boolean;
  kind: string;
  inferred: boolean;
}

export interface DueData {
  card: "due";
  tool: "money_show_due";
  args: { month: string };
  month: string;
  monthLabel: string;
  asOf: string;
  currency: string;
  /** Day of month for "today" when the card shows the current month, else null. */
  today: number | null;
  daysInMonth: number;
  /** 0 = Monday. */
  firstWeekday: number;
  items: DueItem[];
  totals: { stillDue: number; paid: number; overdue: number; overdueCount: number; disputedCount: number; unknownCount: number };
}

export async function dueData(core: Core, month?: string): Promise<DueData> {
  const today = core.today();
  if (month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new LedgerError(`month must be YYYY-MM (got "${month}").`);
  const ym = month ?? today.slice(0, 7);
  const [y, m] = ym.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const amountUnknown = await core.fields("obligation");
  const rows = (await core.upcomingObligations({ from_date: `${ym}-01`, to_date: `${ym}-${String(days).padStart(2, "0")}` })) as {
    id: string; name: string; amount_minor: number; currency: string; due_date: string; kind: string; status: string; confidence: string; paid_minor: number; remaining_minor: number;
  }[];
  const items: DueItem[] = rows
    .filter((o) => o.status !== "cancelled")
    .map((o) => {
      const unknown = amountUnknown.get(o.id)?.amount_unknown === true;
      const late = o.status !== "paid" && o.due_date < today;
      const status: DueItem["status"] =
        o.status === "paid" ? "paid" : o.status === "disputed" ? "disputed" : late ? "overdue" : o.paid_minor > 0 ? "partial" : "upcoming";
      return {
        label: o.name,
        day: Number(o.due_date.slice(8, 10)),
        amount: unknown ? null : status === "paid" ? o.amount_minor : o.remaining_minor,
        currency: o.currency,
        paid: o.paid_minor,
        status,
        late,
        kind: o.kind,
        inferred: o.confidence !== "confirmed",
      };
    });
  // Totals are in the main currency; other-currency items still show individually.
  const main = items.filter((i) => i.currency === core.base);
  const open = main.filter((i) => i.status !== "paid");
  return {
    card: "due",
    tool: "money_show_due",
    args: { month: ym },
    month: ym,
    monthLabel: `${MONTHS[m - 1]} ${y}`,
    asOf: today,
    currency: core.base,
    today: today.startsWith(ym) ? Number(today.slice(8, 10)) : null,
    daysInMonth: days,
    firstWeekday: (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7,
    items,
    totals: {
      stillDue: open.reduce((s, i) => s + (i.amount ?? 0), 0),
      paid: main.filter((i) => i.status === "paid").reduce((s, i) => s + (i.amount ?? 0), 0) + open.reduce((s, i) => s + i.paid, 0),
      overdue: open.filter((i) => i.status === "overdue").reduce((s, i) => s + (i.amount ?? 0), 0),
      overdueCount: items.filter((i) => i.status === "overdue").length,
      disputedCount: items.filter((i) => i.status === "disputed").length,
      unknownCount: items.filter((i) => i.status !== "paid" && i.amount === null).length,
    },
  };
}

export function dueText(d: DueData): string {
  const g = (n: number) => fmt(n, d.currency);
  const line = (i: DueItem) => `${i.day}${i.inferred ? "?" : ""}: ${i.label} ${i.amount === null ? "TBD" : fmt(i.amount, i.currency)} (${i.status})`;
  return [
    `Due in ${d.monthLabel}: ${g(d.totals.stillDue)} still due · ${g(d.totals.paid)} paid · ${d.totals.overdueCount} overdue (${g(d.totals.overdue)})`,
    ...d.items.map(line),
  ].join("\n");
}

// ---- Debts --------------------------------------------------------------------

export interface DebtsData {
  card: "debts";
  tool: "money_show_debts";
  args: Record<string, never>;
  asOf: string;
  currency: string;
  cards: { label: string; bank: string; currency: string; debt: number; limit: number | null; available: number | null; availableEstimated: boolean; minimum: number | null; due: string | null; note?: string; snapshotAt: string | null }[];
  loans: { label: string; bank: string; currency: string; balance: number | null; installment: number | null; paid: number | null; total: number | null; nextDue: string | null; rate?: string; priority: boolean; note?: string }[];
  totals: { cardDebt: number; cardLimit: number; loanDebt: number; unknownLoans: number };
}

export function debtsData(v: MoneyTruthsView): DebtsData {
  const cards = v.cards.map((c) => ({ label: c.label, bank: c.bank, currency: c.currency, debt: c.debt, limit: c.limit, available: c.available, availableEstimated: c.availableEstimated, minimum: c.minimum, due: c.due, note: c.note, snapshotAt: c.snapshotAt }));
  const loans = v.loans.map((l) => ({ label: l.label, bank: l.bank, currency: l.currency, balance: l.balance, installment: l.installment, paid: l.paid, total: l.total, nextDue: l.nextDue, rate: l.rate, priority: l.priority, note: l.note }));
  return {
    card: "debts",
    tool: "money_show_debts",
    args: {},
    asOf: v.asOf,
    currency: v.currency,
    cards,
    loans,
    totals: {
      cardDebt: cards.filter((c) => c.currency === v.currency).reduce((s, c) => s + c.debt, 0),
      cardLimit: cards.filter((c) => c.currency === v.currency).reduce((s, c) => s + (c.limit ?? 0), 0),
      loanDebt: loans.filter((l) => l.currency === v.currency).reduce((s, l) => s + (l.balance ?? 0), 0),
      unknownLoans: loans.filter((l) => l.balance === null).length,
    },
  };
}

export function debtsText(d: DebtsData): string {
  const g = (n: number) => fmt(n, d.currency);
  return [
    `Debts as of ${d.asOf}: cards ${g(d.totals.cardDebt)}${d.totals.cardLimit ? ` of ${g(d.totals.cardLimit)} limits` : ""} · loans ${g(d.totals.loanDebt)}${d.totals.unknownLoans ? ` + ${d.totals.unknownLoans} with unknown balance` : ""}`,
    ...d.cards.map((c) => {
      const f = (n: number) => fmt(n, c.currency);
      return `Card ${c.label}: ${f(c.debt)}${c.limit ? ` / ${f(c.limit)}` : ""}${c.minimum !== null ? `, min ${f(c.minimum)}${c.due ? ` due ${c.due}` : ""}` : ""}${c.note ? ` (${c.note})` : ""}`;
    }),
    ...d.loans.map((l) => `Loan ${l.label}: ${l.balance === null ? "balance TBD" : fmt(l.balance, l.currency)}${l.installment ? `, ${fmt(l.installment, l.currency)}/mo` : ""}${l.paid !== null && l.total ? `, ${l.paid}/${l.total} paid` : ""}${l.nextDue ? `, next ${l.nextDue}` : ""}`),
  ].join("\n");
}

/** Plain-text version for the model (and for hosts without MCP Apps). */
export function cardText(d: CardData): string {
  const g = (n: number) => fmt(n, d.currency);
  if (d.empty) {
    return `Money Truths — ${d.monthLabel}: empty so far. Nothing is set up yet; call money_get_snapshot and follow its getting_started steps with the user.`;
  }
  return [
    `Money Truths — ${d.monthLabel}, as of ${d.asOf}`,
    `Liquid ${g(d.liquid)} · free ${g(d.free)} (${g(d.reserved)} reserved)`,
    ...d.separate.map((s) => `${s.label}: ${fmt(s.amount, s.currency)} (not counted)`),
    `${d.monthLabel.split(" ")[0]} still due ${g(d.wall.due)} · liquid covers ${d.wall.coverPct}% · ${g(d.wall.gap)} must come from income`,
    `Next: ${d.next.map((n) => `${n.label} ${n.amount === null ? "TBD" : fmt(n.amount, n.currency)} (${n.due})`).join("; ") || "nothing due"}`,
    `${d.urgent} urgent · ${d.unresolved} unresolved differences · ${d.late} late expected payment${d.late === 1 ? "" : "s"}`,
  ].join("\n");
}

export const CARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Money Truths</title>
<style>
:root{--bg:#111014;--card:#1a171e;--raised:#221d27;--border:#3a303e;--text:#f4edf5;--muted:#b7aeb9;--dim:#7d7381;--gold:#e0bd72;--violet:#9a78d1;--good:#aee3bc;--warn:#f3d796;--warn-bg:#3d341e;--bad:#ffb5bb;--bad-bg:#3b2327}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.c{background:var(--card);border:1px solid var(--border);border-radius:18px;padding:16px;max-width:640px}
.top{display:flex;justify-content:space-between;align-items:center;gap:8px}
.eb{color:var(--gold);font-size:11px;font-weight:750;letter-spacing:.14em;text-transform:uppercase}
.asof{color:var(--dim);font-size:12px}
button{background:var(--raised);color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:3px 10px;font:inherit;font-size:12px;cursor:pointer}
button:hover{color:var(--text)}button:disabled{opacity:.5;cursor:default}
.row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end;margin-top:8px}
.big{font-size:34px;font-weight:800;letter-spacing:-.02em;line-height:1.05;font-variant-numeric:tabular-nums}
.free{color:var(--muted);font-size:13px;margin-top:2px}.free b{color:var(--good)}
.sep{display:flex;flex-direction:column;align-items:flex-end;gap:2px;font-size:12px;color:var(--muted);text-align:right}
.sep b{color:var(--text);font-variant-numeric:tabular-nums}
.stack{display:flex;height:9px;border-radius:999px;overflow:hidden;gap:2px;background:var(--raised);margin-top:12px}
.lg{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12px;color:var(--muted)}
.lg i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px}
.lg b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.wall{margin-top:14px;background:var(--raised);border-radius:12px;padding:10px 12px}
.wn{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.wn span{display:block;color:var(--muted);font-size:11px}.wn b{font-size:15px;font-variant-numeric:tabular-nums}
.meter{height:7px;background:var(--bad-bg);border-radius:999px;overflow:hidden;margin-top:8px}.meter span{display:block;height:100%;background:var(--violet)}
.h{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:14px 0 4px}
ul{list-style:none;margin:0;padding:0}
li{display:grid;grid-template-columns:56px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid #2c2531}
li:last-child{border-bottom:0}
.when{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.lab{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.amt{text-align:right;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap}
.amt small{display:block;font-weight:500;font-size:11px;color:var(--warn)}
li.overdue .amt small{color:var(--bad)}
.foot{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.pill{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:var(--raised);color:var(--muted)}
.pill.bad{background:var(--bad-bg);color:var(--bad)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
.gen{color:var(--dim);font-size:11px;margin-top:10px}
.wait{color:var(--muted);padding:24px 0;text-align:center}
.cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;margin-top:10px}
.dow{font-size:10px;color:var(--dim);text-align:center;padding-bottom:2px}
.d{min-height:44px;border-radius:8px;background:var(--raised);padding:3px 4px;display:flex;flex-direction:column;gap:2px;cursor:pointer;border:1px solid transparent}
.d.e{background:transparent;cursor:default}
.d.t{border-color:var(--violet)}
.d.sel{background:#2f2740;border-color:var(--gold)}
.dn{font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums}
.d.past .dn{color:var(--dim)}
.dv{font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dv.paid{color:var(--good);opacity:.7}.dv.upcoming,.dv.partial{color:var(--warn)}.dv.overdue{color:var(--bad)}.dv.disputed{color:#cdb8f0}
li.disputed .amt small{color:#cdb8f0}
.tot{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:10px}
.tot div{background:var(--raised);border-radius:10px;padding:8px 10px;min-width:0;overflow-wrap:anywhere}.tot span{display:block;color:var(--muted);font-size:11px}.tot b{font-variant-numeric:tabular-nums}
li.paid{opacity:.55}
.amt small.paid{color:var(--good)}
.bank{font-size:10px;font-weight:750;padding:1px 7px;border-radius:999px;margin-left:6px;vertical-align:1px}
.debt{padding:9px 0;border-bottom:1px solid #2c2531}.debt:last-child{border-bottom:0}
.dh{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.dh b{font-variant-numeric:tabular-nums}
.bar{height:7px;background:var(--raised);border-radius:999px;overflow:hidden;margin:6px 0 4px}
.bar span{display:block;height:100%;border-radius:999px;background:var(--violet)}
.bar span.hot{background:var(--warn)}.bar span.max{background:var(--bad)}.bar span.prog{background:var(--good)}
.sub{color:var(--muted);font-size:12px}
.debt.priority{border:1px solid var(--gold);border-radius:10px;padding:9px 10px;margin:4px 0;background:#1f1a14}
@media (max-width:420px){.tot{grid-template-columns:1fr 1fr}.tot div:last-child{grid-column:1/-1}.big{font-size:28px}.row{grid-template-columns:1fr}.sep{flex-direction:row;flex-wrap:wrap;gap:2px 14px;align-items:flex-start;text-align:left}.wn{grid-template-columns:1fr 1fr}.wn div:last-child{grid-column:1/-1}}
</style>
</head>
<body>
<div class="c" id="root"><div class="wait">Loading…</div></div>
<script>
(() => {
  const root = document.getElementById("root");
  const CARD_VERSION = "__CARD_VERSION__";
  const stamp = (d) => esc((d.version || "") + " · card " + CARD_VERSION);
  // Money: integers in each currency's minor unit, formatted with Intl.
  let CUR = "USD";
  const digits = (c) => { try { return new Intl.NumberFormat("en-US", { style: "currency", currency: c }).resolvedOptions().maximumFractionDigits; } catch (_) { return 2; } };
  const fm = (n, c) => {
    c = c || CUR;
    const dg = digits(c);
    const major = Math.abs(n) / Math.pow(10, dg);
    let s;
    try { s = new Intl.NumberFormat("en-US", { style: "currency", currency: c, currencyDisplay: "narrowSymbol", minimumFractionDigits: dg, maximumFractionDigits: dg }).format(major); }
    catch (_) { s = major.toFixed(dg) + " " + c; }
    return (n < 0 ? "−" : "") + s;
  };
  const g = (n) => fm(n, CUR);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (d) => (d < 0 ? -d + "d late" : d === 0 ? "today" : d === 1 ? "tomorrow" : "in " + d + "d");

  let current = null;
  function render(d) {
    if (!d || typeof d !== "object") return;
    current = d;
    if (d.currency) CUR = d.currency;
    if (d.card === "due") return renderDue(d);
    if (d.card === "debts") return renderDebts(d);
    if (typeof d.liquid !== "number") return;
    const stack = d.accounts.map((a) => '<span style="flex:' + a.amount + ";background:" + esc(a.color) + '"></span>').join("");
    const legend = d.accounts.map((a) => '<span><i style="background:' + esc(a.color) + '"></i>' + esc(a.label) + " <b>" + g(a.amount) + "</b></span>").join("");
    const sep = d.separate.map((s) => "<span>" + esc(s.label) + " <b>" + fm(s.amount, s.currency) + "</b></span>").join("");
    const next = d.next.map((n) =>
      '<li class="' + esc(n.status) + '"><span class="when">' + esc(n.due) + '</span><span class="lab">' + esc(n.label) + '</span><span class="amt">' +
      (n.amount === null ? "TBD" : fm(n.amount, n.currency)) + "<small>" + when(n.daysAway) + (n.status === "overdue" ? " · overdue" : "") + "</small></span></li>").join("");
    const pills = [
      d.urgent ? '<span class="pill bad">⚠ ' + d.urgent + " urgent</span>" : "",
      d.late ? '<span class="pill warn">' + d.late + " late payment" + (d.late > 1 ? "s" : "") + "</span>" : "",
      d.unresolved ? '<span class="pill">' + d.unresolved + " unresolved difference" + (d.unresolved > 1 ? "s" : "") + "</span>" : "",
      d.attention ? '<span class="pill">' + d.attention + " need attention</span>" : "",
    ].join("");
    root.innerHTML =
      '<div class="top"><span class="eb">Money Truths</span><span><span class="asof">as of ' + esc(d.asOf) + '</span> <button id="refresh" title="Fetch fresh numbers">↻</button></span></div>' +
      '<div class="row"><div><div class="big">' + g(d.liquid) + '</div><div class="free">free <b>' + g(d.free) + "</b>" + (d.reserved ? " · " + g(d.reserved) + " reserved" : "") + '</div></div><div class="sep">' + sep + "</div></div>" +
      '<div class="stack">' + stack + '</div><div class="lg">' + legend + "</div>" +
      '<div class="wall"><div class="wn"><div><span>Still due in ' + esc(d.monthLabel.split(" ")[0]) + '</span><b style="color:var(--bad)">' + g(d.wall.due) + "</b></div><div><span>Liquid now</span><b>" + g(d.liquid) +
      '</b></div><div><span>From income</span><b style="color:var(--gold)">' + g(d.wall.gap) + '</b></div></div><div class="meter"><span style="width:' + d.wall.coverPct + '%"></span></div></div>' +
      '<div class="h">Next up</div><ul>' + (next || '<li><span></span><span class="lab">Nothing due</span><span></span></li>') + "</ul>" +
      '<div class="foot">' + pills + "</div>" +
      (d.empty ? '<div class="wall" style="text-align:center">✨ Nothing here yet. Tell your AI which accounts, cards and bills you have, and it will set them up with you.</div>' : "") +
      '<div class="gen">Generated from canonical Money Truths database · view only · ' + stamp(d) + "</div>";
    finish();
  }

  const top = (title, asOf) =>
    '<div class="top"><span class="eb">' + esc(title) + '</span><span><span class="asof">as of ' + esc(asOf) + '</span> <button id="refresh" title="Fetch fresh numbers">↻</button></span></div>';
  // Compact amount for calendar cells, in major units: 1.2k, 35, 2.7M.
  const k = (minor) => {
    const n = minor / Math.pow(10, digits(CUR));
    return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(Math.round(n));
  };
  const PALETTE = __PALETTE__;
  const colorFor = (s) => { let h = 0; for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0; return PALETTE[h % PALETTE.length]; };
  const bank = (b) => (b ? '<span class="bank" style="background:' + colorFor(b) + ';color:#15121a">' + esc(b) + "</span>" : "");
  function finish() {
    const btn = document.getElementById("refresh");
    if (btn) btn.onclick = refresh;
    reportSize();
  }

  let selectedDay = null;
  let showPaid = false;
  function renderDue(d) {
    const byDay = {};
    for (const i of d.items) if (i.day) (byDay[i.day] = byDay[i.day] || []).push(i);
    const rank = { overdue: 4, disputed: 3, upcoming: 2, partial: 2, paid: 1 };
    let cells = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((w) => '<div class="dow">' + w + "</div>").join("");
    for (let i = 0; i < d.firstWeekday; i++) cells += '<div class="d e"></div>';
    for (let day = 1; day <= d.daysInMonth; day++) {
      const its = byDay[day] || [];
      const worst = its.reduce((w, i) => (rank[i.status] > rank[w] ? i.status : w), "paid");
      const main = its.filter((i) => !i.currency || i.currency === CUR);
      const open = main.filter((i) => i.status !== "paid").reduce((s, i) => s + (i.amount || 0), 0);
      const shown = open || main.reduce((s, i) => s + (i.amount || 0), 0);
      cells += '<div class="d' + (day === d.today ? " t" : "") + (d.today && day < d.today ? " past" : "") + (day === selectedDay ? " sel" : "") + '" data-day="' + day + '"><span class="dn">' + day + "</span>" +
        (its.length ? '<span class="dv ' + worst + '">' + (shown ? k(shown) : "?") + "</span>" : "") + "</div>";
    }
    // Paid items fold away unless a day is selected or "show paid" is on: what's owed comes first.
    const paidCount = d.items.filter((i) => i.status === "paid").length;
    const list = d.items
      .filter((i) => (selectedDay ? i.day === selectedDay : showPaid || i.status !== "paid"))
      .sort((a, b) => (a.day || 99) - (b.day || 99))
      .map((i) => '<li class="' + i.status + '"><span class="when">' + d.monthLabel.slice(0, 3) + " " + i.day + (i.inferred ? "?" : "") + '</span><span class="lab">' + esc(i.label) + '</span><span class="amt">' +
        (i.amount === null ? "TBD" : fm(i.amount, i.currency)) + '<small class="' + (i.status === "paid" ? "paid" : "") + '">' +
        (i.status === "paid" ? "✓ paid" : i.status === "disputed" ? "disputed" + (i.late ? " · late" : "") : i.status === "overdue" ? "overdue" : i.status === "partial" ? fm(i.paid, i.currency) + " paid" : d.today ? (i.day - d.today === 0 ? "today" : "in " + (i.day - d.today) + "d") : "upcoming") +
        "</small></span></li>").join("");
    root.innerHTML = top("Due · " + d.monthLabel, d.asOf) +
      '<div class="tot"><div><span>Still due</span><b style="color:var(--bad)">' + g(d.totals.stillDue) + '</b></div><div><span>Paid</span><b style="color:var(--good)">' + g(d.totals.paid) +
      '</b></div><div><span>Overdue</span><b style="color:' + (d.totals.overdueCount ? "var(--bad)" : "var(--muted)") + '">' + (d.totals.overdueCount ? d.totals.overdueCount + " · " + g(d.totals.overdue) : "none") + "</b></div></div>" +
      '<div class="cal">' + cells + "</div>" +
      '<div class="h">' + (selectedDay ? d.monthLabel.slice(0, 3) + " " + selectedDay + ' · <a href="#" id="all" style="color:var(--violet)">show all</a>' : showPaid ? "Everything this month" : "Still to pay") + "</div><ul>" + (list || '<li><span></span><span class="lab">Nothing here</span><span></span></li>') + "</ul>" +
      (!selectedDay && paidCount ? '<div class="sub" style="margin-top:6px"><a href="#" id="paidtoggle" style="color:var(--violet)">' + (showPaid ? "hide paid" : "show " + paidCount + " paid") + "</a></div>" : "") +
      (d.totals.unknownCount || d.totals.disputedCount ? '<div class="foot">' + (d.totals.disputedCount ? '<span class="pill">' + d.totals.disputedCount + " disputed</span>" : "") + (d.totals.unknownCount ? '<span class="pill">' + d.totals.unknownCount + " amount" + (d.totals.unknownCount > 1 ? "s" : "") + " unknown</span>" : "") + "</div>" : "") +
      '<div class="gen">? = date inferred · tap a day to filter · view only · ' + stamp(d) + "</div>";
    root.querySelectorAll(".d[data-day]").forEach((el) => (el.onclick = () => { const n = Number(el.dataset.day); selectedDay = selectedDay === n ? null : n; renderDue(d); }));
    const all = document.getElementById("all");
    if (all) all.onclick = (e) => { e.preventDefault(); selectedDay = null; renderDue(d); };
    const pt = document.getElementById("paidtoggle");
    if (pt) pt.onclick = (e) => { e.preventDefault(); showPaid = !showPaid; renderDue(d); };
    finish();
  }

  function renderDebts(d) {
    const cards = d.cards.map((c) => {
      const f = (n) => fm(n, c.currency);
      const pct = c.limit ? Math.min(100, Math.round((c.debt / c.limit) * 100)) : null;
      return '<div class="debt"><div class="dh"><span>' + esc(c.label) + bank(c.bank) + "</span><b>" + f(c.debt) + "</b></div>" +
        (pct !== null ? '<div class="bar"><span class="' + (pct >= 98 ? "max" : pct >= 90 ? "hot" : "") + '" style="width:' + pct + '%"></span></div>' : "") +
        '<div class="sub">' + (c.available !== null ? (c.availableEstimated ? "≈" : "") + f(c.available) + " available" + (pct !== null ? " · " + pct + "% used" : "") : "available ?") +
        (c.minimum !== null ? " · min " + f(c.minimum) + (c.due ? " " + esc(c.due) : "") : "") + (c.note ? " · " + esc(c.note) : "") + "</div></div>";
    }).join("");
    const loans = d.loans.map((l) => {
      const f = (n) => fm(n, l.currency);
      const pct = l.paid !== null && l.total ? Math.round((l.paid / l.total) * 100) : null;
      return '<div class="debt' + (l.priority ? " priority" : "") + '"><div class="dh"><span>' + esc(l.label) + bank(l.bank) + "</span><b>" + (l.balance === null ? "TBD" : f(l.balance)) + "</b></div>" +
        (pct !== null ? '<div class="bar"><span class="prog" style="width:' + Math.max(pct, 1) + '%"></span></div>' : "") +
        '<div class="sub">' + [l.installment ? f(l.installment) + "/mo" : "", l.paid !== null && l.total ? l.paid + "/" + l.total + " paid" : "", l.nextDue ? "next " + esc(l.nextDue) : "", l.rate ? esc(l.rate) : "", l.priority ? "priority" : ""].filter(Boolean).join(" · ") + "</div></div>";
    }).join("");
    const t = d.totals;
    root.innerHTML = top("Debts", d.asOf) +
      '<div class="tot"><div><span>Cards</span><b style="color:var(--bad)">' + g(t.cardDebt) + "</b>" + (t.cardLimit ? '<span>of ' + g(t.cardLimit) + " limit</span>" : "") +
      '</div><div><span>Loans</span><b>' + g(t.loanDebt) + "</b>" + (t.unknownLoans ? "<span>+ " + t.unknownLoans + " TBD</span>" : "") + '</div><div><span>Total known</span><b>' + g(t.cardDebt + t.loanDebt) + "</b></div></div>" +
      '<div class="h">Cards</div>' + (cards || '<div class="sub">No cards.</div>') +
      '<div class="h">Loans & personal debts</div>' + (loans || '<div class="sub">No loans.</div>') +
      '<div class="gen">Generated from canonical Money Truths database · view only · ' + stamp(d) + "</div>";
    finish();
  }

  // --- MCP Apps bridge (JSON-RPC over postMessage) ---------------------------
  let nextId = 1;
  const pending = new Map();
  const post = (msg) => window.parent.postMessage(msg, "*");
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post({ jsonrpc: "2.0", id, method, params });
  });
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent) return;
    const m = e.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id !== undefined && !m.method && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(m.error) : p.resolve(m.result);
      return;
    }
    if (m.method === "ui/notifications/tool-result") render(m.params && m.params.structuredContent);
    else if (m.method && m.id !== undefined) post({ jsonrpc: "2.0", id: m.id, result: {} }); // ping, teardown, …
  });

  // Measure the card itself: the document can never be shorter than the frame
  // the host gave it, so measuring the document would never let the card shrink.
  let lastH = 0;
  function reportSize() {
    const r = root.getBoundingClientRect();
    const h = Math.ceil(r.bottom + 1);
    if (h === lastH) return;
    lastH = h;
    post({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: Math.ceil(r.right), height: h } });
  }
  if (window.ResizeObserver) new ResizeObserver(reportSize).observe(root);

  async function refresh() {
    const btn = document.getElementById("refresh");
    if (btn) btn.disabled = true;
    try {
      const r = await request("tools/call", { name: (current && current.tool) || "money_show_ledger", arguments: (current && current.args) || {} });
      render(r && r.structuredContent);
    } catch (_) {
      if (btn) btn.disabled = false;
    }
  }

  // ChatGPT exposes the same data through its compatibility globals.
  const fromOpenAI = () => window.openai && window.openai.toolOutput && render(window.openai.toolOutput);
  window.addEventListener("openai:set_globals", fromOpenAI);
  fromOpenAI();

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "money-truths-ledger-card", version: CARD_VERSION },
    appCapabilities: { availableDisplayModes: ["inline"] },
  })
    .then(() => post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }))
    .catch(() => {});
})();
</script>
</body>
</html>`.replace("__CARD_VERSION__", VERSION).replace("__PALETTE__", JSON.stringify(PALETTE));
