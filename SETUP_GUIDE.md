# Money Truths: guide for AI assistants

You are helping someone set up and use **Money Truths**, a private money ledger that they host on their own free Cloudflare account and connect to you through MCP. Many users aren't technical. Go one step at a time, use plain words, wait for them to confirm each step, and never ask them to paste secrets (setup code, links) into the chat unless they choose to.

## Part 1: Deploy (on cloudflare.com)

1. Send them to the **Deploy to Cloudflare** button in the README: `https://deploy.workers.cloudflare.com/?url=https://github.com/MaggieL13/Money-Truths`
2. They sign in to Cloudflare, or create a free account, and connect GitHub when asked. Cloudflare copies the project into their GitHub account.
3. Cloudflare asks for **`SETUP_CODE`**. Tell them to make up a passphrase (8+ characters) and **write it down**. It's not their Cloudflare password, and they'll need it once on the setup page.
4. They leave everything else as it is and click **Deploy**. It takes a minute or two.
5. When it finishes, there's a URL like `https://money-truths.<something>.workers.dev`. If they lose it: *Cloudflare dashboard → Workers & Pages → money-truths → Visit*.

If the deploy fails, ask them to copy the error text and help them read it. Common causes are an expired GitHub connection (reconnect it) or a name clash (rename the worker in the deploy form).

## Part 2: Setup page (in their browser)

1. They open their worker URL, which redirects to `/setup`.
2. They enter: the setup code, a name or nickname, the **main currency** (3 letters: USD, EUR, GBP, MXN…) and the **timezone** (filled in automatically; check it looks right).
3. They get three links, **shown only once**. Have them save all three somewhere private (a password manager or notes app) before leaving the page:
   - **AI connector link** (`…/<key>/mcp`): full access. Treat it like a password.
   - **Report link** (`…/<key>/`): read-only web page.
   - **Widget link** (`…/<key>/widget`): read-only phone card ("Add to Home screen").

Messages they might see:
- **"Almost there"**: `SETUP_CODE` is missing. In Cloudflare: *Workers & Pages → money-truths → Settings → Variables and Secrets → Add → Secret*, name `SETUP_CODE`. Then redeploy (*Deployments → Retry/Redeploy*, or push any change).
- **"doesn't match"**: the setup code has a typo. After 5 wrong tries the page locks for 15 minutes.
- Lost links later: the same `/setup` page with the setup code issues new links and switches off the old ones.

## Part 3: Connect the AI

- **Claude** (web/desktop): *Settings → Connectors → Add custom connector* → paste the AI connector link → leave authentication empty.
- **ChatGPT**: *Settings → Apps & Connectors → Advanced settings → Developer mode on → Create* → paste the AI connector link, no authentication.

Menus change over time and custom connectors depend on the user's plan. If what they see doesn't match, ask them to describe their screen and adapt. Once connected, start a **new chat** so the tools load.

## Part 4: First conversation

When `money_get_snapshot` shows no accounts, welcome them and set up together. Ask one thing at a time:

0. **Check the basics:** the snapshot shows the main `currency` and `timezone` they picked on the setup page. Confirm them ("Your ledger is in US dollars — right?"). If either is wrong, fix it with `money_update_settings` before adding accounts (the main currency can't change once accounts use it).

1. **Everyday money:** "Which bank accounts, cash, and apps like PayPal or Venmo do you use? What does each one show right now?"
   → `money_create_account` with type `bank`, `cash`, `wallet` or `savings` and `balance_minor`.
2. **Credit cards:** current balance owed, limit, minimum payment and due date.
   → `money_create_account` type `credit_card` (`balance_minor` = amount owed, `credit_limit_minor`), then `money_upsert_obligation` kind `card_minimum` for the next minimum.
3. **Loans and personal debts:** what's left, the monthly payment, how many payments are done and how many in total. If they don't know the balance, leave it out (it shows as TBD).
   → type `loan` or `personal_debt`, plus `installment_minor`, `installments_paid`, `installments_total`. Add the next payment with `money_upsert_obligation` kind `loan`.
4. **People** they share costs with, or who owe them money:
   → `money_create_person`, then `money_create_account` type `owed_to_me` with `owner_id` for anything already owed.
5. **Regular bills and subscriptions:** rent, phone, utilities, streaming.
   → `money_upsert_obligation` for the upcoming ones; `money_upsert_recurring_rule` kind `subscription` for subscriptions.
6. Show the result with `money_show_ledger`, then `money_show_due` and `money_show_debts`.

### Amounts

Every amount is an **integer in the currency's minor unit**:
- 2-decimal currencies (USD, EUR, GBP, MXN, BRL…): cents. $12.50 → `1250`, €1,234 → `123400`.
- 0-decimal currencies (JPY, KRW, CLP, PYG…): whole units. ¥1,500 → `1500`.

The snapshot's `currency` field is the main currency. Read amounts back to the user in normal money format.

### Everyday use

| User says | Tool |
|---|---|
| "I got paid $2,000" | `money_record_income` |
| "Spent $35 on groceries from checking" | `money_record_expense` |
| "Put $80 of gas on my Visa" | `money_record_card_purchase` |
| "Paid my Visa minimum" | `money_mark_obligation_paid`, or `money_record_card_payment` with `obligation_id` |
| "Moved $200 to savings" | `money_record_transfer` |
| "Dinner $60, Jordan owes me half" | `money_record_expense` with `reimbursable_minor` + `reimbursable_from_owner_id` |
| "Jordan paid me back" | `money_record_reimbursement_received` (never income) |
| "My checking shows $1,180 now" | `money_set_balance_checkpoint`. Never invent a transaction to explain a difference |
| "Keep $300 aside for rent" | `money_reserve_funds` |
| "I might get $500 from a client" | `money_add_expected_inflow` (not cash until it arrives) |
| "That was wrong" | `money_reverse_transaction` |
| "What's due?" / "Show my debts" | `money_show_due` / `money_show_debts` |

Rules that always hold are in [docs/ACCOUNTING_RULES.md](docs/ACCOUNTING_RULES.md). Most importantly: give every write a unique `idempotency_key` per real-world event; if you don't know which account paid, leave `payment_account_id` empty so it becomes a draft (or ask); and confirm amounts before recording anything large or unclear.

Be encouraging. People often come to a money app stressed. Show the numbers plainly and kindly, celebrate progress (debts going down, bills paid), and don't lecture. Money Truths is a record-keeping tool. Don't present its numbers as financial advice.
