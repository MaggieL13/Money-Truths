import { McpServer } from "@modelcontextprotocol/server";
import type { Core } from "./core/index.ts";
import { TOOLS, callTool } from "./tools.ts";
import { CARD_HTML, CARD_MIME, CARD_RESOURCE_META, CARD_URI, cardData, cardText, debtsData, debtsText, dueData, dueText } from "./card.ts";
import { z } from "zod/v4";
import { VERSION, versionLabel } from "./version.ts";

// Thin MCP surface over the shared tool registry. No accounting logic here.

const INSTRUCTIONS = `Money Truths — the user's own finance ledger. You help them keep it true.
Rules that always hold:
- Amounts are integers in the currency's minor unit: cents for USD/EUR ($12.50 → 1250), whole units for currencies without decimals (JPY, PYG…). Check money_get_snapshot "currency".
- Every write needs an idempotency_key unique to the real-world event; retries are safe.
- A fresh balance the user reports wins: use money_set_balance_checkpoint, never invent an expense to explain a gap.
- Expected income is not cash. Other people's money is not the user's. Reimbursements are not income. Transfers are not spending.
- Moving money "for the card bill" is a transfer; the card is unpaid until a confirmed card payment.
- If you don't know which account paid, record the expense without payment_account_id (it becomes a draft) or ask.
- Corrections are reversals; nothing is deleted.
- Be warm and plain-spoken; many users aren't finance people. Confirm amounts before recording big or unclear things.
First run: if money_get_snapshot shows no accounts, welcome the user and set up together — ask what accounts, cards, loans and people they have, then call money_create_account / money_create_person one at a time with the balances they read off their apps. Then add upcoming bills with money_upsert_obligation and show money_show_ledger.
Otherwise start with money_get_snapshot to learn account and obligation ids.`;

export function buildMcpServer(core: Core, opts: { readOnly: boolean; buildSha?: string | null }): McpServer {
  const server = new McpServer({ name: "money-truths", version: VERSION }, { instructions: INSTRUCTIONS });
  const version = versionLabel(opts.buildSha);

  for (const tool of TOOLS) {
    if (tool.mutating && opts.readOnly) continue;
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input,
        annotations: { readOnlyHint: !tool.mutating, destructiveHint: false, idempotentHint: true },
      },
      async (args: Record<string, unknown>) => {
        const r = await callTool(core, tool.name, args, opts);
        if (!r.ok) return { isError: true, content: [{ type: "text" as const, text: r.error }] };
        const result = r.result as { summary?: string; warnings?: string[] };
        const head = result && typeof result === "object" && "summary" in result ? [result.summary, ...(result.warnings ?? []).map((w) => `⚠ ${w}`)].join("\n") : null;
        return {
          content: [{ type: "text" as const, text: (head ? `${head}\n\n` : "") + JSON.stringify(result, null, 2) }],
        };
      },
    );
  }

  // In-chat Ledger card (MCP Apps; ChatGPT reads the same standard plus its
  // openai/outputTemplate alias). View-only, so read tokens get it too.
  server.registerResource(
    "ledger-card",
    CARD_URI,
    { title: "Money Truths ledger card", description: "View-only summary card rendered in chat.", mimeType: CARD_MIME },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: CARD_MIME, text: CARD_HTML, _meta: CARD_RESOURCE_META }],
    }),
  );
  server.registerTool(
    "money_show_ledger",
    {
      description:
        "Show the user their live ledger as a visual card in chat: spendable and free money, accounts, what's still due this month, the next payments, and alerts. Use when they ask to see the ledger, their money, or what's due. Read-only.",
      inputSchema: {},
      outputSchema: LEDGER_OUT,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI, "openai/outputTemplate": CARD_URI },
    },
    async () => {
      const { loadView } = await import("./core/report-data.ts");
      const data = { ...cardData(await loadView(core)), version };
      return {
        content: [{ type: "text" as const, text: cardText(data) }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );
  const ui = { ui: { resourceUri: CARD_URI }, "ui/resourceUri": CARD_URI, "openai/outputTemplate": CARD_URI };
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  server.registerTool(
    "money_show_due",
    {
      description:
        "Show the user a calendar card of everything due in a month (default: this month): paid, upcoming, partly paid and overdue, with totals. Use when they ask what's due, what's left to pay, or for the bills calendar. Read-only.",
      inputSchema: { month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM").optional().describe("YYYY-MM; defaults to the current month.") },
      outputSchema: DUE_OUT,
      annotations: ro,
      _meta: ui,
    },
    async (args: { month?: string }) => {
      const data = { ...(await dueData(core, args.month)), version };
      return { content: [{ type: "text" as const, text: dueText(data) }], structuredContent: data as unknown as Record<string, unknown> };
    },
  );
  server.registerTool(
    "money_show_debts",
    {
      description:
        "Show the user a card of all their debts: each credit card's balance, usage and minimum, and each loan's balance, installment and progress. Use when they ask about debts, cards or loans. Read-only.",
      inputSchema: {},
      outputSchema: DEBTS_OUT,
      annotations: ro,
      _meta: ui,
    },
    async () => {
      const { loadView } = await import("./core/report-data.ts");
      const data = { ...debtsData(await loadView(core)), version };
      return { content: [{ type: "text" as const, text: debtsText(data) }], structuredContent: data as unknown as Record<string, unknown> };
    },
  );
  return server;
}

// Output schemas for the card tools (structuredContent). They describe the
// documented fields; extra fields are allowed so the card can grow without
// breaking older clients.
const n = z.number();
const nn = z.number().nullable();
export const LEDGER_OUT = {
  card: z.literal("ledger"),
  tool: z.string(),
  version: z.string(),
  asOf: z.string(),
  currency: z.string(),
  monthLabel: z.string(),
  liquid: n,
  free: n,
  reserved: n,
  accounts: z.array(z.looseObject({ label: z.string(), amount: n })),
  wall: z.looseObject({ due: n, gap: n, coverPct: n }),
  next: z.array(z.looseObject({ label: z.string(), amount: nn, due: z.string(), status: z.string() })),
  urgent: n,
  unresolved: n,
};
export const DUE_OUT = {
  card: z.literal("due"),
  tool: z.string(),
  version: z.string(),
  month: z.string(),
  monthLabel: z.string(),
  currency: z.string(),
  today: nn,
  daysInMonth: n,
  firstWeekday: n,
  items: z.array(z.looseObject({ label: z.string(), day: nn, amount: nn, paid: n, status: z.enum(["paid", "overdue", "upcoming", "partial", "disputed"]), late: z.boolean() })),
  totals: z.looseObject({ stillDue: n, paid: n, overdue: n, overdueCount: n, disputedCount: n, unknownCount: n }),
};
export const DEBTS_OUT = {
  card: z.literal("debts"),
  tool: z.string(),
  version: z.string(),
  asOf: z.string(),
  currency: z.string(),
  cards: z.array(z.looseObject({ label: z.string(), debt: n, limit: nn, available: nn, availableEstimated: z.boolean(), minimum: nn })),
  loans: z.array(z.looseObject({ label: z.string(), balance: nn, installment: nn, paid: nn, total: nn, nextDue: z.string().nullable() })),
  totals: z.looseObject({ cardDebt: n, cardLimit: n, loanDebt: n, unknownLoans: n }),
};
