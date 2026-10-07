# Accounting rules

Money Truths is small, but it keeps real double-entry books. These rules hold for every tool, and the tests in `test/` check them (numbered scenarios 1–25 plus regression tests).

## The model

- Every movement is a **transaction** with balanced **postings**: debits equal credits.
- An account's balance is its **newest accepted checkpoint** plus every posting after it. A checkpoint is a balance the user reported, from a screenshot, a statement or a cash count.
- Amounts are integers in each currency's **minor unit**: cents, or whole units for currencies without decimals. Floats are never used.
- Every write needs an **idempotency key**. Repeating a write with the same key returns the first result and records nothing new.
- Every write is **atomic** (one database batch) and lands in the **audit log**.

## Rules

**A. A fresh balance wins.** When the user reports what an account shows, it becomes a checkpoint. If it disagrees with the ledger, a *reconciliation issue* opens with the difference. Nothing is invented to explain the gap: no phantom expense, no assumed interest. An opening balance during setup is a checkpoint too, not income.

**B. Expected money isn't cash.** Expected inflows (a paycheck that's coming, a client who might pay) never change balances or free money until they're recorded as received.

**C. Transfers stay within one owner.** A transfer moves money between two accounts of the *same* owner. It's neither income nor spending, and it isn't counted as cash in or out. Money crossing between owners is a cash swap, a reimbursable expense, or a pass-through.

**D. Other people's money is never yours.** Accounts can belong to other people (a roommate's rent jar you look after, say). They're shown separately and never counted in your liquid or free money.

**E. Card purchases are spending; card payments aren't.** A card purchase raises the card's debt and counts as spending, without moving cash. Paying the card lowers cash and debt and counts as a *debt payment*, not new spending.

**F. Intending to pay isn't paying.** Moving money into an account "for the card bill" is only a transfer. The card minimum stays unpaid until a confirmed card payment is recorded.

**G. Reimbursable spending isn't your cost.** When part of a purchase is owed back, that part becomes a receivable from that person. Only your share counts as spending. Being paid back settles the receivable and is never income. Forgiving a small remainder (a *waiver*) needs a reason.

**H. Pass-through money is neither income nor spending.** Money that arrives for someone else and leaves again is held in a clearing account in between.

**I. Corrections are reversals.** Nothing is deleted. A wrong transaction is reversed by an opposite entry, and both stay in history. Reversing a payment reopens the obligation it paid.

**J. Closed months are frozen.** Closing a month stores an immutable snapshot of month-end balances, obligations and open issues. Later entries, checkpoints or opening balances dated in a closed month are refused.

**K. Currencies never mix.** Totals are in the main currency. Accounts in other currencies are shown separately, and moves between currencies are refused rather than converted at a guessed rate.

## Obligations and reservations

- An **obligation** is something due (a card minimum, loan payment, bill, or personal debt). Paying it records the payment and marks it in one atomic step. A partial payment leaves it *pending* with the remainder showing. A payment larger than the obligation applies only what was owed.
- A **reservation** earmarks existing money for something, which lowers *free* money but not the bank balance. Paying the linked obligation draws the reservation down. Anything left over is released, never left dangling.
- If the user doesn't know which account paid, the expense is saved as a **draft** that changes nothing until it's completed.
