---
paths:
  - "src/modules/usage/**"
  - "src/modules/payments/**"
---

# Pricing, credits, and ledger

- Money/credits use Prisma `Decimal`, never JS floats.
- `AiModelPricing` is effective-dated: one row with
  `effectiveFrom <= requestTime < effectiveTo` (null = open-ended); store its `pricingId`.
- `costThb` from cost rates, `chargedCredit` from credit rates. Never hard-code
  prices, credits-per-THB, or exchange rates.
- `scopeKey` separates embedding indexing from query usage.
- `CreditReservation.operationKey` makes reserve/replay idempotent. Reserve
  wallet + budget atomically.
- Settlement (one transaction): release hold, store replayable provider result,
  persist usage, at most one DEBIT, update totals. `balanceAfterCredit` equals
  the committed wallet balance.
- Failure before a billable result releases the hold exactly once, no DEBIT.
  Expired HELD reservations recover without double release.
- `usageEventId` and ledger `idempotencyKey` prevent duplicate charges.
- TOPUP/REFUND positive, DEBIT negative. Reservations don't touch `lifetimeSpentCredit`.
- Ledger is immutable: correct with REFUND/ADJUSTMENT, never update/delete.
- Top-up approval: atomic PENDING→APPROVED with approver/time, exactly one TOPUP
  ledger; concurrent approval never double-credits. Rejection changes no totals.

## Testing billing changes

Assert DB state (wallet, reservations, budgets, usage, ledger uniqueness/signs,
delivery outcome), not just HTTP. Cover reserve, settle, release, replay,
concurrency, provider failure, insufficient wallet/budget, long-context pricing,
and expiry. Balanced totals alone don't prove correctness.
