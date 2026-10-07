import type { MoneyTruthsView } from "./view.ts";
import { fmt } from "./money.ts";

// Plain Markdown rendering of the report view for chat surfaces.

export function viewMarkdown(v: MoneyTruthsView, month: { income: number; economic_spending: number; debt_payments: number; reimbursements_received: number }): string {
  const g = (n: number) => fmt(n, v.currency);
  const liquid = v.accounts.reduce((s, a) => s + a.amount, 0);
  const free = liquid - v.earmarks.reduce((s, e) => s + e.amount, 0);
  const open = v.obligations.filter((o) => o.status !== "paid");
  const lines = [
    `# Money Truths — ${v.monthLabel}`,
    `_Generated from canonical Money Truths database · as of ${v.asOf}_`,
    "",
    `**${v.ownerName} — actually yours: ${g(liquid)}** (${v.accounts.map((a) => `${a.label} ${g(a.amount)}`).join(" · ")})`,
    `Free after reservations: **${g(free)}**${v.earmarks.length ? ` — ${v.earmarks.map((e) => `${g(e.amount)} for ${e.label}`).join("; ")}` : ""}`,
    ...v.separate.map((s) => `${s.label}: ${fmt(s.amount, s.currency)} — ${s.note}`),
    "",
    `## Still due this month: ${g(open.filter((o) => o.currency === v.currency).reduce((s, o) => s + (o.amount ?? 0), 0))}`,
    "| Due | Obligation | Amount | Status |",
    "|---|---|---:|---|",
    ...v.obligations.map((o) => `| ${o.dueDate ?? "monthly"}${o.dateConfirmed ? "" : "?"} | ${o.label} | ${o.amount === null ? "TBD" : fmt(o.amount, o.currency)} | ${o.status} |`),
    "",
    "## Needs attention",
    ...v.issues.map((i) => `- **${i.title}**${i.detail ? ` — ${i.detail}` : ""}`),
    "",
    "## Reconciliation",
    ...(v.reconciliation.length ? v.reconciliation.map((r) => `- ${r.account}: ${r.difference === null ? "?" : fmt(r.difference, r.currency)} (${r.ageDays}d) — ${r.note}`) : ["- none open"]),
    "",
    `## This month so far`,
    `Income ${g(month.income)} · spent ${g(month.economic_spending)} · debt payments ${g(month.debt_payments)} · reimbursed ${g(month.reimbursements_received)}`,
    "",
    "## Expected (not cash)",
    ...v.expected.map((e) => `- ${e.source}: ${e.amount === null ? "—" : fmt(e.amount, e.currency)} (${e.overdue ? "late" : e.status})`),
  ];
  return lines.join("\n");
}
