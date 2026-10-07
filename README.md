# Money Truths 💜

**Your own private money ledger that your AI can read and update for you.**

Tell Claude or ChatGPT things like *"I paid $42 for groceries with my Visa"* or *"my checking says $1,250 now"*, and Money Truths keeps an honest record: what you actually have, what's already spoken for, what's due this month, and what you owe. You can ask your AI to show it as a card right in the chat, or open your own report page anytime.

It runs on **your own free Cloudflare account**. Nobody else hosts it or can see your data, including the person who made it.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/MaggieL13/Money-Truths)

---

## Setting it up (about 10 minutes, no coding)

> 💡 **Tip:** open this page in a chat with your AI and say *"Help me set up Money Truths."* It can walk you through each step. The AI guide is in [SETUP_GUIDE.md](SETUP_GUIDE.md).

1. **Click the Deploy to Cloudflare button above.**
   - Sign in to Cloudflare, or make a free account.
   - Connect GitHub when it asks. Cloudflare copies this project into your own GitHub account so you have your own copy.
2. **Pick a setup code.** Cloudflare asks for `SETUP_CODE`. Type a passphrase you'll remember, at least 8 characters, and **write it down**. Then click **Deploy** and wait a minute or two.
3. **Open your new ledger.** When the deploy finishes, Cloudflare shows a link like `https://money-truths.yourname.workers.dev`. Open it and you'll see the setup page.
4. **Fill in the setup page.** Enter your setup code, your name (a nickname is fine), your main currency and your timezone.
5. **Save your links.** You get three private links. They're shown only once, so put them in a password manager or private notes:
   - **AI connector link:** paste it into Claude (*Settings → Connectors → Add custom connector*) or ChatGPT (*Settings → Apps & Connectors → Developer mode → Create*). Menu names change from time to time and custom connectors depend on your plan. If you can't find them, ask your AI.
   - **Report link:** your full ledger page, read-only.
   - **Widget link:** a small phone card, read-only. Open it on your phone and use *Add to Home screen*.
6. **Start a new chat** and say: *"Let's set up my Money Truths."* Your AI will ask about your bank accounts, cash, cards, loans and bills one at a time, and add them as you answer.

That's it. From then on, just tell your AI what happens with your money.

## What it's good at

- **Honest numbers.** Expected money isn't counted until it arrives. Money set aside for a bill isn't "free". Someone else's money in your account isn't yours.
- **Due dates.** Bills, card minimums and loan payments, plus a calendar of what's paid and what's still due.
- **Debts.** Card balances, how much of each limit you've used, and loan progress (*3 of 12 paid*).
- **Shared costs.** *"Dinner was $60, Jordan owes me half."* Then, when Jordan pays you back, it's recorded as a repayment, not as income.
- **Fixing mistakes safely.** Nothing is ever deleted. A wrong entry gets reversed, so your history stays intact.
- **Any currency.** You pick one main currency, and single accounts can use others (a dollar savings account next to your euro checking, for example). Currencies are never mixed or silently converted.

The in-chat cards work in hosts that support MCP Apps, like Claude and ChatGPT. Hosts without card support still get the same information as text.

## Your data and privacy

- Everything lives in **your** Cloudflare account, in a small database (Cloudflare D1). The free plan is plenty for one person.
- Your links contain random keys. Anyone who has your **AI connector link** can read and change your ledger, so keep it private, like a password.
- **Lost a link, or worried someone has it?** Open `https://<your-ledger>/setup`, enter your setup code, and you'll get new links. The old ones stop working right away. You'll need to update the connector in your AI and on your phone.
- **Backups:** open your AI connector link with `/mcp` at the end replaced by `/api/export` (so it ends in `/<your-connector-key>/api/export`) to download a JSON file of everything. Do this now and then.
- Only store the last 4 digits of any card or account number. Never store full numbers or passwords.

## Getting updates

Your copy is a normal GitHub repository in your account. When this project gets improvements:

1. Ask your AI: *"Help me pull the latest Money Truths updates from MaggieL13/Money-Truths into my copy."*
2. Cloudflare redeploys automatically when your copy changes, and any database updates are applied as part of the deploy.

Your data is never touched by updates, apart from adding new columns or tables when a feature needs them.

## Troubleshooting

| You see | What it means |
|---|---|
| **"Almost there"** on the setup page | Your copy has no `SETUP_CODE`. In Cloudflare: *Workers & Pages → money-truths → Settings → Variables and Secrets*, add a **Secret** called `SETUP_CODE`, then deploy again. |
| **"That setup code doesn't match"** | Type it exactly as you entered it in Cloudflare. After 5 wrong tries, the page locks for 15 minutes. |
| **"Not found"** | The link is wrong or was replaced. Use your saved links, or get new ones from `/setup`. |
| Your AI says **"isn't set up yet"** | Open your ledger's `/setup` page and finish setting it up. |
| Cards don't appear in chat | Your AI host may not support cards. Ask for the numbers as text, or open your report link. |

## For developers

Cloudflare Worker + D1 + MCP (Streamable HTTP), TypeScript run directly by Node 24, no build step.

```bash
npm ci
cp .dev.vars.example .dev.vars        # set SETUP_CODE
npm run db:migrate                    # local D1
npm run dev                           # http://localhost:8787/setup
npm run check                         # typecheck + tests
```

- `src/core/`: the accounting engine. Double-entry postings, balance checkpoints, obligations, reservations, idempotent writes and an audit log. See [docs/ACCOUNTING_RULES.md](docs/ACCOUNTING_RULES.md).
- `src/tools.ts`: one tool registry shared by MCP (`/<key>/mcp`) and the JSON API (`/<key>/api/<tool>`).
- `src/card.ts`: the in-chat cards, one MCP Apps view with no external resources.
- `src/setup.ts`: first-run setup and hashed access keys.
- Schema changes go in new numbered files in `migrations/`. The deploy script applies them (`wrangler d1 migrations apply DB --remote && wrangler deploy`).

Manual deploy without the button: `npx wrangler d1 create money-truths`, paste the id into `wrangler.jsonc`, `npx wrangler secret put SETUP_CODE`, then `npm run deploy`.

## License

MIT. See [LICENSE](LICENSE). Money Truths is a record-keeping tool, not financial advice.
