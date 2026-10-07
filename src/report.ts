import type { Core } from "./core/index.ts";
import { loadTxns, loadView } from "./core/report-data.ts";
import type { MoneyTruthsView, Obligation, Status, Txn, TxnKind } from "./view.ts";
import { EMPTY, byDate, fromJournal, inMonth, search, signFor, type MonthNumbers } from "./summary.ts";
import { CSS } from "./report-css.ts";
import { colorFor, fmt } from "./money.ts";

// Money Truths report. Every number comes from the canonical database via
// Core; this file only lays it out.

export type Route =
  | { kind: "month"; ym: string; filter: TxnKind | null }
  | { kind: "year"; y: number }
  | { kind: "search"; q: string };

export async function renderReport(core: Core, url: URL): Promise<string> {
  const view = await loadView(core);
  const route = parseRoute(url, view.asOf);
  const txns = await loadTxns(core);
  const months = new Map<string, MonthNumbers>();
  const wanted =
    route.kind === "month" ? [route.ym] : route.kind === "year" ? MONTHS.map((_, i) => `${route.y}-${String(i + 1).padStart(2, "0")}`) : [];
  for (const ym of wanted) months.set(ym, await monthNumbers(core, ym));
  return renderPage(view, txns, route, months);
}

async function monthNumbers(core: Core, ym: string): Promise<MonthNumbers> {
  const journal = await core.periodSummary({ month: ym });
  return journal.transactions > 0 ? fromJournal(journal) : EMPTY;
}

export function parseRoute(url: URL, asOf: string): Route {
  const q = url.searchParams.get("q")?.trim();
  if (q) return { kind: "search", q: q.slice(0, 100) };
  const y = url.searchParams.get("y");
  if (y && /^\d{4}$/.test(y)) return { kind: "year", y: Number(y) };
  const m = url.searchParams.get("m");
  const k = url.searchParams.get("k");
  return {
    kind: "month",
    ym: m && /^\d{4}-(0[1-9]|1[0-2])$/.test(m) ? m : asOf.slice(0, 7),
    filter: k && k in KIND_LABEL ? (k as TxnKind) : null,
  };
}

export function renderPage(v: MoneyTruthsView, txns: Txn[], route: Route, months: Map<string, MonthNumbers>): string {
  // Rendering is synchronous, so the module-level formatting settings can't
  // leak between concurrent requests.
  CUR = v.currency;
  TZ = v.timezone;
  const currentYm = v.asOf.slice(0, 7);
  let body: string;
  if (route.kind === "search") body = searchBody(txns, route.q);
  else if (route.kind === "year") body = yearBody(route.y, currentYm, months);
  else if (route.ym === currentYm) body = currentMonthBody(v) + monthSummary(route.ym, months.get(route.ym) ?? EMPTY) + txnSection(inMonth(txns, route.ym), route, `Ledger — ${monthName(route.ym)}`, "Nothing recorded this month yet.");
  else body = otherMonthBody(txns, route, months.get(route.ym) ?? EMPTY, v);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#111014">
<title>Money Truths</title>
<style>${CSS}</style>
</head>
<body>
<main>

<header class="top">
  <div>
    <p class="eyebrow">${esc(v.eyebrow)}</p>
    <h1>Money Truths</h1>
    <p class="muted">As of ${esc(longDate(v.asOf))} · ${esc(v.ownerName)}</p>
    <p class="gen">Generated from canonical Money Truths database · ${esc(stamp(v.generatedAt))}</p>
  </div>
  ${v.mock ? `<span class="mock">Mock · frozen data</span>` : ""}
</header>

${periodNav(route, currentYm)}

${body}

<footer>
  <p class="law">Bank balance ≠ free money · expected income ≠ received cash · other people's money ≠ your money · reimbursable spending ≠ your final expense</p>
  ${v.footer ? `<p class="muted tiny">${esc(v.footer)}</p>` : ""}
</footer>

</main>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Current month

function currentMonthBody(v: MoneyTruthsView): string {
  const today = Number(v.asOf.slice(8, 10));
  const liquid = sum(v.accounts.map((a) => a.amount));
  const earmarked = sum(v.earmarks.map((e) => e.amount));
  const free = liquid - earmarked;

  const open = v.obligations.filter((o) => o.status !== "paid");
  const openKnown = sum(open.filter((o) => o.currency === v.currency).map((o) => o.amount ?? 0));
  const openUnknown = open.filter((o) => o.amount === null).length;
  const gap = Math.max(0, openKnown - liquid);
  const coverPct = openKnown > 0 ? Math.min(100, Math.round((liquid / openKnown) * 100)) : 100;
  const week = v.obligations.filter((o) => o.day !== null && o.day >= today && o.day < today + 7).sort(byDay);
  const mon = v.monthLabel.split(" ")[0].slice(0, 3);
  const dayTotals = range(1, v.daysInMonth).map((d) => sum(v.obligations.filter((o) => o.day === d && o.currency === v.currency).map((o) => o.amount ?? 0)));
  const maxDay = Math.max(...dayTotals, 1);

  return `
<section class="hero">
  <div class="card mine">
    <div class="label">💜 ${esc(v.ownerName)} — actually yours</div>
    <div class="huge">${g(liquid)}</div>
    <div class="stack" role="img" aria-label="Liquid money by account">
      ${v.accounts.filter((a) => a.amount > 0).map((a) => `<span style="flex:${a.amount};background:${a.color}" title="${esc(a.label)} ${g(a.amount)}"></span>`).join("")}
    </div>
    <ul class="legend">
      ${v.accounts.map((a) => `<li><i style="background:${a.color}"></i>${esc(a.label)} <b>${g(a.amount)}</b></li>`).join("")}
    </ul>
    <div class="free"><span>Free after reservations</span><b>${g(free)}</b></div>
    ${v.earmarks.map((e) => `<div class="earmark">🔒 ${g(e.amount)} reserved: ${esc(e.label)}</div>`).join("")}
  </div>
  <div class="side">
    ${v.separate
      .map(
        (s) => `<div class="card small">
      <div class="label">${esc(s.label)}</div>
      <div class="big">${m(s.amount, s.currency)}</div>
      <div class="muted tiny">${esc(s.note)}</div>
    </div>`,
      )
      .join("")}
    ${
      v.heldTotal !== liquid
        ? `<div class="card small">
      <div class="label">Held total — yours + others' (${esc(v.currency)})</div>
      <div class="big">${g(v.heldTotal)}</div>
      <div class="muted tiny">Shown for completeness. Only your part is yours to spend.</div>
    </div>`
        : ""
    }
  </div>
</section>

<section class="card wall">
  <div class="wall-head">
    <h2>${esc(v.monthLabel.split(" ")[0])} wall</h2>
    <span class="muted tiny">${open.length} open obligation${open.length === 1 ? "" : "s"}${openUnknown ? ` · ${openUnknown} amount${openUnknown > 1 ? "s" : ""} unknown` : ""}</span>
  </div>
  <div class="wall-nums">
    <div><span class="label">Still due</span><b class="bad">${g(openKnown)}</b></div>
    <div><span class="label">Liquid now</span><b>${g(liquid)}</b></div>
    <div><span class="label">Must come from income</span><b class="gold">${g(gap)}</b></div>
  </div>
  <div class="meter" aria-label="Liquid covers ${coverPct}% of what's still due"><span style="width:${coverPct}%"></span></div>
  <p class="muted tiny">Liquid money covers ${coverPct}% of what's still due this month. Expected income isn't counted until it lands.</p>
</section>

${
  v.reconciliation.length
    ? `<section class="card">
  <h2>Reconciliation <span class="count">${v.reconciliation.length} open</span></h2>
  <ul class="recon">
    ${v.reconciliation
      .map(
        (r) => `<li>
      <div><b>${esc(r.account)}</b><div class="muted tiny">${esc(r.note)}</div><div class="muted tiny">${r.expected !== null ? `ledger ${m(r.expected, r.currency)} · ` : ""}reported ${m(r.reported, r.currency)} · ${r.ageDays}d old</div></div>
      <div class="right"><span class="amt">${r.difference === null ? "?" : `${r.difference > 0 ? "+" : "−"}${m(Math.abs(r.difference), r.currency)}`}</span><span class="pill overdue">unresolved</span></div>
    </li>`,
      )
      .join("")}
  </ul>
</section>`
    : ""
}

<section class="card">
  <h2>Next 7 days</h2>
  ${week.length ? `<ul class="rows">${week.map((o) => obligationRow(o, mon)).join("")}</ul>` : `<p class="muted">Nothing due.</p>`}
</section>

<section class="card">
  <h2>${esc(v.monthLabel)}</h2>
  <div class="strip" style="--days:${v.daysInMonth}">
    ${range(1, v.daysInMonth)
      .map((d) => {
        const items = v.obligations.filter((o) => o.day === d);
        const total = dayTotals[d - 1];
        const h = items.length ? Math.max(14, Math.min(100, Math.sqrt(total / maxDay) * 100)) : 0;
        return `<div class="day${d === today ? " today" : ""}${d < today ? " past" : ""}" title="${esc(items.map((o) => `${o.label} ${o.amount === null ? "TBD" : m(o.amount, o.currency)} — ${STATUS_LABEL[o.status]}`).join("\n") || `${mon} ${d}`)}">
        <div class="bar-slot">${items.length ? `<span class="bar ${worstStatus(items)}" style="height:${h}%"></span>` : ""}</div>
        <span class="dnum${d % 5 === 0 || d === 1 || d === today ? "" : " minor"}">${d}</span>
      </div>`;
      })
      .join("")}
  </div>
  <div class="keys tiny">
    <span><i class="k paid"></i>paid</span><span><i class="k upcoming"></i>upcoming</span><span><i class="k overdue"></i>overdue</span><span class="muted">bar height ≈ amount · "?" = date inferred</span>
  </div>
  <details>
    <summary>All ${v.obligations.length} obligations</summary>
    <ul class="rows">${[...v.obligations].sort(byDay).map((o) => obligationRow(o, mon, true)).join("")}</ul>
  </details>
</section>

<section class="card">
  <h2>Needs attention <span class="count">${v.issues.length}</span></h2>
  ${
    v.issues.length
      ? `<ul class="issues">${v.issues
          .map((i) => `<li class="${i.severity}"><span class="sev" aria-label="${i.severity}"></span><div><b>${esc(i.title)}</b>${i.detail ? `<div class="muted">${esc(i.detail)}</div>` : ""}</div></li>`)
          .join("")}</ul>`
      : `<p class="muted">Nothing.</p>`
  }
</section>

<div class="two">
<section class="card">
  <h2>Cards</h2>
  ${v.cards.length ? "" : `<p class="muted tiny">No credit cards yet.</p>`}
  <ul class="debts">
    ${v.cards
      .map((c) => {
        const pct = c.limit ? Math.min(100, Math.round((c.debt / c.limit) * 100)) : null;
        return `<li>
      <div class="debt-head"><b>${esc(c.label)}</b>${bankPill(c.bank)}</div>
      ${pct !== null ? `<div class="util"><span class="${pct >= 98 ? "maxed" : pct >= 90 ? "hot" : ""}" style="width:${pct}%"></span></div>` : ""}
      <div class="debt-meta">
        <span>${m(c.debt, c.currency)} debt</span>
        <span class="muted">${c.available !== null ? `${c.availableEstimated ? "≈" : ""}${m(c.available, c.currency)} available` : "available ?"}${pct !== null ? ` · ${pct}%` : ""}</span>
      </div>
      <div class="muted tiny">${c.minimum !== null ? `Min ${m(c.minimum, c.currency)}${c.due ? ` · due ${esc(c.due)}` : ""}` : "Min TBD"}${c.limit ? ` · limit ${m(c.limit, c.currency)}` : ""}${c.note ? ` · ${esc(c.note)}` : ""}${c.snapshotAt ? ` · snapshot ${esc(shortDate(c.snapshotAt))}` : ""}</div>
    </li>`;
      })
      .join("")}
  </ul>
</section>

<section class="card">
  <h2>Loans & personal debts</h2>
  ${v.loans.length ? "" : `<p class="muted tiny">No loans yet.</p>`}
  <ul class="debts">
    ${v.loans
      .map((l) => {
        const pct = l.paid !== null && l.total ? Math.round((l.paid / l.total) * 100) : null;
        return `<li${l.priority ? ` class="priority"` : ""}>
      <div class="debt-head"><b>${esc(l.label)}</b>${bankPill(l.bank)}</div>
      ${pct !== null ? `<div class="prog"><span style="width:${Math.max(pct, 1)}%"></span></div>` : ""}
      <div class="debt-meta">
        <span>${l.balance !== null ? m(l.balance, l.currency) : "Balance TBD"}</span>
        <span class="muted">${l.installment !== null ? `${m(l.installment, l.currency)}/mo` : ""}${l.paid !== null && l.total ? ` · ${l.paid}/${l.total} paid` : ""}</span>
      </div>
      <div class="muted tiny">${[l.nextDue ? `next ${l.nextDue}` : "", l.rate, l.priority ? "Priority" : "", l.note, l.asOf ? `balance as of ${shortDate(l.asOf)} (${l.confidence})` : ""].filter(Boolean).map((s) => esc(s!)).join(" · ")}</div>
    </li>`;
      })
      .join("")}
  </ul>
</section>
</div>

<div class="two">
<section class="card">
  <h2>Income</h2>
  <p class="subhead">Received this month</p>
  ${
    v.received.length
      ? `<ul class="rows">${v.received.map((r) => `<li><span class="when">${esc(shortDate(r.date))}</span><div class="grow"><b>${esc(r.source)}</b><div class="muted tiny">${esc(r.account)}</div></div><div class="right"><span class="amt">+${m(r.amount, r.currency)}</span><span class="pill ok">received</span></div></li>`).join("")}</ul>`
      : `<p class="muted tiny">Nothing received yet.</p>`
  }
  ${incomeGroup("Expected — not cash until it lands", v.expected.filter((e) => e.status === "confirmed" || e.status === "expected"))}
  ${incomeGroup("Scenario / ending — never counted", v.expected.filter((e) => e.status !== "confirmed" && e.status !== "expected"), true)}
</section>

<section class="card">
  <h2>Subscriptions</h2>
  <ul class="rows">
    ${v.subscriptions
      .map(
        (s) => `<li class="${s.tone === "muted" ? "dim" : ""}">
      <div class="grow"><b>${esc(s.name)}</b><div class="muted tiny">${esc(s.payer)}${s.note ? ` · ${esc(s.note)}` : ""}</div></div>
      <div class="right"><span class="amt">${s.amount !== null ? m(s.amount, s.currency) : "—"}</span><span class="pill ${s.tone}">${esc(s.status)}</span></div>
    </li>`,
      )
      .join("")}
  </ul>
  ${v.subscriptions.length ? `<p class="muted tiny">You pay: <b>${perCurrency(v.subscriptions.filter((s) => !s.covered && s.tone !== "muted"))}</b>/mo${v.subscriptions.some((s) => s.covered) ? ` · Covered by others: <b>${perCurrency(v.subscriptions.filter((s) => s.covered))}</b>/mo` : ""}</p>` : `<p class="muted tiny">No subscriptions yet.</p>`}
</section>
</div>

${
  v.notes.length
    ? `<section class="card notes">
  <h2>Notes</h2>
  ${v.notes.map((n) => `<blockquote><span class="icon">${esc(n.icon)}</span><div><p>${esc(n.text)}</p><cite>${esc(n.author)}</cite></div></blockquote>`).join("")}
</section>`
    : ""
}
`;
}

function incomeGroup(title: string, list: MoneyTruthsView["expected"], dim = false): string {
  if (!list.length) return "";
  return `<p class="subhead">${esc(title)}</p>
  <ul class="rows">${list
    .map(
      (e) => `<li class="${dim ? "dim" : ""}">
      <div class="grow"><b>${esc(e.source)}</b>${e.note ? `<div class="muted tiny">${esc(e.note)}</div>` : ""}</div>
      <div class="right"><span class="amt">${e.amount === null ? "—" : (e.approx ? "~" : "") + m(e.amount, e.currency)}</span><span class="pill ${e.overdue ? "overdue" : e.status === "confirmed" ? "ok" : e.status === "expected" ? "wait" : "muted"}">${e.overdue ? "late" : esc(e.status)}</span></div>
    </li>`,
    )
    .join("")}</ul>`;
}

// ---------------------------------------------------------------------------
// Month summary, other months, year, search

function monthSummary(ym: string, n: MonthNumbers): string {
  if (n.source === "none") return "";
  return `<section class="card">
  <div class="wall-head"><h2>${esc(monthName(ym))} so far</h2><span class="muted tiny">${n.count} ledger entr${n.count === 1 ? "y" : "ies"}</span></div>
  ${tiles(n)}
</section>`;
}

function tiles(n: MonthNumbers, full = true): string {
  const cells: [string, string, string, string?][] = [
    ["Income", g(n.income), "Received, not expected"],
    ["Spent", g(n.spending), "Economic cost, incl. card purchases"],
    ["Debt payments", g(n.debtPayments), "Cards + loans — shrinks what you owe"],
    ["Earned − spent", `${n.net < 0 ? "−" : "+"}${g(Math.abs(n.net))}`, "Debt paydown counted separately", n.net < 0 ? "bad" : "good"],
  ];
  if (full) {
    cells.push(
      ["Reimbursed", g(n.reimbursements), "Settles what was owed — not income"],
      ["Card purchases", g(n.cardPurchases ?? 0), "Spending that didn't move cash"],
      ["Cash in", g(n.cashIn ?? 0), "Excl. transfers between your accounts"],
      ["Cash out", g(n.cashOut ?? 0), "Excl. transfers between your accounts"],
    );
  }
  return `<div class="tiles">${cells.map(([l, val, sub, cls]) => `<div><span class="label">${esc(l)}</span><b${cls ? ` class="${cls}"` : ""}>${val}</b><span class="muted tiny">${esc(sub)}</span></div>`).join("")}</div>`;
}

function otherMonthBody(txns: Txn[], route: Extract<Route, { kind: "month" }>, n: MonthNumbers, v: MoneyTruthsView): string {
  const month = inMonth(txns, route.ym);
  if (month.length === 0) {
    return `<section class="card empty">
  <h2>${esc(monthName(route.ym))}</h2>
  <p class="muted">${route.ym < v.since.slice(0, 7) ? "Before you started this ledger." : "Nothing recorded for this month."}</p>
</section>`;
  }
  const max = Math.max(...n.byGroup.map((b) => b.amount), 1);
  return `<section class="card">
  <div class="wall-head"><h2>${esc(monthName(route.ym))}</h2><span class="muted tiny">${n.count} entr${n.count === 1 ? "y" : "ies"}</span></div>
  ${tiles(n)}
</section>

${
  n.byGroup.length
    ? `<section class="card">
  <h2>Where it went</h2>
  <ul class="hbars">
    ${n.byGroup.map((b) => `<li><span class="hl">${esc(b.group)}</span><span class="ht"><span style="width:${(b.amount / max) * 100}%"></span></span><span class="hv">${g(b.amount)}${b.count ? `<span class="muted tiny"> · ${b.count}</span>` : ""}</span></li>`).join("")}
  </ul>
</section>`
    : ""
}

${txnSection(month, route, "Every entry", "")}`;
}

function txnSection(list: Txn[], route: Route, title: string, emptyMsg: string): string {
  const filter = route.kind === "month" ? route.filter : null;
  const kinds = [...new Set(list.map((t) => t.kind))];
  const shown = (filter ? list.filter((t) => t.kind === filter) : list).sort(byDate);
  const base = route.kind === "month" ? `?m=${route.ym}` : "?";
  return `<section class="card">
  <div class="wall-head"><h2>${esc(title)} <span class="count">${shown.length}</span></h2></div>
  ${kinds.length > 1 ? `<div class="chips"><a href="${base}"${filter ? "" : ` class="on"`}>All</a>${kinds.map((k) => `<a href="${base}&amp;k=${k}"${filter === k ? ` class="on"` : ""}>${KIND_LABEL[k]}</a>`).join("")}</div>` : ""}
  ${shown.length ? `<ul class="rows txns">${shown.map((t) => txnRow(t)).join("")}</ul>` : `<p class="muted">${esc(emptyMsg)}</p>`}
</section>`;
}

function txnRow(t: Txn, q?: string): string {
  const amount = m(t.amount, t.currency);
  const meta = [t.group, t.category, t.account].filter(Boolean).map((s) => esc(s!)).join(" · ");
  return `<li class="${t.kind === "transfer" || t.kind === "passthrough" || t.kind === "expected" || t.kind === "reversal" ? "dim" : ""}">
    <span class="when">${esc(t.dateLabel)}</span>
    <div class="grow"><b>${hl(t.description, q)}</b><div class="muted tiny">${meta}</div>${t.note ? `<div class="note-line tiny">${hl(t.note, q)}</div>` : ""}${
      t.splits?.length ? `<details><summary>${t.splits.length} splits</summary><ul class="splits">${t.splits.map((s) => `<li><span>${esc(s.label)} · ${esc(s.owner)}${s.reimbursable ? " · owed back" : ""}</span><span>${m(s.amount, t.currency)}</span></li>`).join("")}</ul></details>` : ""
    }</div>
    <div class="right"><span class="amt">${signFor(t.kind)}${amount}</span><span class="pill ${KIND_TONE[t.kind]}">${KIND_LABEL[t.kind]}</span></div>
  </li>`;
}

function yearBody(y: number, currentYm: string, months: Map<string, MonthNumbers>): string {
  const rows = MONTHS.map((_, i) => {
    const ym = `${y}-${String(i + 1).padStart(2, "0")}`;
    const n = months.get(ym) ?? EMPTY;
    return { ym, n, has: n.source !== "none" };
  });
  const max = Math.max(...rows.map((r) => Math.max(r.n.income, r.n.spending)), 1);
  const withData = rows.filter((r) => r.has);
  const total: MonthNumbers = withData.reduce<MonthNumbers>(
    (a, r) => ({ ...a, count: a.count + r.n.count, income: a.income + r.n.income, spending: a.spending + r.n.spending, reimbursements: a.reimbursements + r.n.reimbursements, debtPayments: a.debtPayments + r.n.debtPayments, net: a.net + r.n.net }),
    { ...EMPTY, source: "journal" },
  );

  return `<section class="card">
  <div class="wall-head"><h2>${y}</h2><span class="muted tiny">${total.count} entries · ${withData.length} month${withData.length === 1 ? "" : "s"} with data</span></div>
  ${withData.length ? tiles(total, false) : `<p class="muted">No data for ${y}.</p>`}
</section>

<section class="card">
  <div class="wall-head"><h2>Income vs spent by month</h2>
    <div class="keys tiny"><span><i class="k in"></i>Income</span><span><i class="k out"></i>Spent</span></div>
  </div>
  <div class="ychart" role="img" aria-label="Income and spending per month of ${y}">
    ${rows
      .map(
        (r, i) => `<a class="mg${r.has ? "" : " none"}${r.ym === currentYm ? " now" : ""}" href="?m=${r.ym}">
      <span class="bars">
        <span class="b in" style="height:${(r.n.income / max) * 100}%"></span>
        <span class="b out" style="height:${(r.n.spending / max) * 100}%"></span>
      </span>
      <span class="ml">${MONTHS[i].slice(0, 3)}</span>
      ${r.has ? `<span class="tip"><b>${esc(monthName(r.ym))}</b><br>Income ${g(r.n.income)}<br>Spent ${g(r.n.spending)}<br>Debt paid ${g(r.n.debtPayments)}<br>Earned − spent ${r.n.net < 0 ? "−" : "+"}${g(Math.abs(r.n.net))}</span>` : ""}
    </a>`,
      )
      .join("")}
  </div>
</section>

<section class="card">
  <h2>Table</h2>
  <div class="scroll"><table>
    <thead><tr><th>Month</th><th class="num">Income</th><th class="num">Spent</th><th class="num">Debt paid</th><th class="num">Earned − spent</th></tr></thead>
    <tbody>${
      withData
        .map((r) => `<tr><td><a href="?m=${r.ym}">${esc(monthName(r.ym))}</a></td><td class="num">${g(r.n.income)}</td><td class="num">${g(r.n.spending)}</td><td class="num">${g(r.n.debtPayments)}</td><td class="num ${r.n.net < 0 ? "bad" : "good"}">${r.n.net < 0 ? "−" : "+"}${g(Math.abs(r.n.net))}</td></tr>`)
        .join("") || `<tr><td colspan="5" class="muted">No data for ${y}.</td></tr>`
    }</tbody>
  </table></div>
</section>`;
}

function searchBody(txns: Txn[], q: string): string {
  const hits = search(txns, q).sort((a, b) => -byDate(a, b));
  const byMonth = new Map<string, Txn[]>();
  for (const h of hits) {
    const ym = h.date.slice(0, 7);
    byMonth.set(ym, [...(byMonth.get(ym) ?? []), h]);
  }
  const main = hits.filter((h) => h.currency === CUR);
  const inn = sum(main.filter((h) => h.kind === "income" || h.kind === "reimbursement").map((h) => h.amount));
  const out = sum(main.filter((h) => h.kind === "expense" || h.kind === "debt_payment").map((h) => h.amount));
  return `<section class="card">
  <div class="wall-head"><h2>${hits.length} result${hits.length === 1 ? "" : "s"} for “${esc(q)}”</h2><a class="tiny" href="?">Clear</a></div>
  ${hits.length ? `<div class="tiles"><div><span class="label">Matches in</span><b>${g(inn)}</b><span class="muted tiny">Income + reimbursements</span></div><div><span class="label">Matches out</span><b>${g(out)}</b><span class="muted tiny">Spending + debt payments</span></div></div>` : `<p class="muted">Nothing matched. Search covers descriptions, categories, accounts, notes and amounts.</p>`}
</section>
${[...byMonth]
  .map(
    ([ym, list]) => `<section class="card">
  <div class="wall-head"><h2><a href="?m=${ym}">${esc(monthName(ym))}</a> <span class="count">${list.length}</span></h2></div>
  <ul class="rows txns">${list.map((x) => txnRow(x, q)).join("")}</ul>
</section>`,
  )
  .join("")}`;
}

// ---------------------------------------------------------------------------
// Navigation & helpers

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const KIND_LABEL: Record<TxnKind, string> = {
  income: "income",
  expense: "spent",
  debt_payment: "debt",
  reimbursement: "reimbursed",
  receivable: "owed to you",
  transfer: "transfer",
  passthrough: "pass-through",
  expected: "expected",
  reversal: "reversed",
};

const KIND_TONE: Record<TxnKind, string> = {
  income: "ok",
  reimbursement: "ok",
  expense: "neutral",
  debt_payment: "debt",
  receivable: "wait",
  transfer: "muted",
  passthrough: "muted",
  expected: "muted",
  reversal: "muted",
};

function periodNav(route: Route, currentYm: string): string {
  const ym = route.kind === "month" ? route.ym : currentYm;
  const y = route.kind === "year" ? route.y : Number(ym.slice(0, 4));
  const stepper =
    route.kind === "year"
      ? `<a href="?y=${y - 1}" aria-label="Previous year">‹</a><a class="cur" href="?y=${y}">${y}</a><a href="?y=${y + 1}" aria-label="Next year">›</a>`
      : `<a href="?m=${shiftMonth(ym, -1)}" aria-label="Previous month">‹</a><a class="cur" href="?m=${ym}">${esc(monthName(ym))}</a><a href="?m=${shiftMonth(ym, 1)}" aria-label="Next month">›</a>`;
  return `<nav class="periods">
  <div class="seg">${stepper}</div>
  <div class="seg tabs">
    <a href="?m=${ym}"${route.kind === "month" ? ` class="on"` : ""}>Month</a>
    <a href="?y=${y}"${route.kind === "year" ? ` class="on"` : ""}>Year</a>
    ${route.kind !== "month" || ym !== currentYm ? `<a href="?m=${currentYm}">Today</a>` : ""}
  </div>
  <form class="search" method="get" role="search">
    <input type="search" name="q" value="${route.kind === "search" ? esc(route.q) : ""}" placeholder="Search — names, places, categories, amounts" aria-label="Search all transactions">
    <button type="submit">Search</button>
  </form>
</nav>`;
}

function obligationRow(o: Obligation, mon: string, showConfidence = false): string {
  const when = o.day === null ? "Monthly" : `${mon} ${o.day}${o.dateConfirmed ? "" : "?"}`;
  const meta = [o.note, showConfidence ? `${o.confidence}${o.linkedAccount ? ` · ${o.linkedAccount}` : ""}` : ""].filter(Boolean).join(" · ");
  return `<li class="${o.status === "paid" ? "dim" : ""}">
    <span class="when${o.dateConfirmed ? "" : " guess"}">${when}</span>
    <div class="grow"><b>${esc(o.label)}</b>${meta ? `<div class="muted tiny">${esc(meta)}</div>` : ""}</div>
    <div class="right"><span class="amt">${o.amount === null ? "TBD" : m(o.amount, o.currency)}</span><span class="pill ${o.status}">${STATUS_LABEL[o.status]}</span></div>
  </li>`;
}

const STATUS_LABEL: Record<Status, string> = { paid: "✓ paid", upcoming: "upcoming", overdue: "⚠ overdue", disputed: "⚠ disputed" };
const STATUS_RANK: Record<Status, number> = { overdue: 3, disputed: 3, upcoming: 1, paid: 0 };

function worstStatus(items: Obligation[]): Status {
  return items.reduce<Status>((w, o) => (STATUS_RANK[o.status] > STATUS_RANK[w] ? o.status : w), "paid");
}

function byDay(a: Obligation, b: Obligation): number {
  return (a.day ?? 99) - (b.day ?? 99);
}

function bankPill(bank: string): string {
  if (!bank) return "";
  return `<span class="bank" style="background:${colorFor(bank)};color:#15121a">${esc(bank)}</span>`;
}

function monthName(ym: string): string {
  return `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
}

function shiftMonth(ym: string, delta: number): string {
  const i = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1 + delta;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
}

/** Escape, then wrap case-insensitive matches of each query term in <mark>. */
function hl(text: string, q?: string): string {
  const safe = esc(text);
  if (!q) return safe;
  const terms = q
    .split(/\s+/)
    .filter((x) => x.length > 1)
    .map((x) => esc(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return safe;
  return safe.replace(new RegExp(`(${terms.join("|")})`, "gi"), "<mark>$1</mark>");
}

let CUR = "USD";
let TZ = "UTC";

/** An amount in the main currency. */
function g(minor: number): string {
  return fmt(minor, CUR);
}

function m(minor: number, currency: string): string {
  return fmt(minor, currency);
}

/** "$12.00 + €3.00": totals per currency, main currency first. */
function perCurrency(list: { amount: number | null; currency: string }[]): string {
  const by = new Map<string, number>([[CUR, 0]]);
  for (const s of list) if (s.amount !== null) by.set(s.currency, (by.get(s.currency) ?? 0) + s.amount);
  return [...by].filter(([c, n]) => n !== 0 || c === CUR).map(([c, n]) => m(n, c)).join(" + ");
}

function sum(ns: number[]): number {
  return ns.reduce((a, b) => a + b, 0);
}

function range(a: number, b: number): number[] {
  return Array.from({ length: b - a + 1 }, (_, i) => a + i);
}

function longDate(iso: string): string {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function shortDate(iso: string): string {
  return new Date(iso.slice(0, 10) + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function stamp(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZoneName: "short" });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
