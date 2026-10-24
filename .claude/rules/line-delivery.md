---
paths:
  - "src/modules/line/**"
  - "src/modules/events/**"
---

# LINE, queue, and delivery

- Ingress verifies the signature on the exact raw body, enqueues, returns fast.
- Webhook handling survives duplicates, retries, crashes, and concurrency.
- Idempotency keys: `ProcessedLineWebhookEvent.webhookEventId` (durable dedup),
  `LineChatHistory.lineMessageId` (unique when present), `LineDelivery.key` (outbound).
- Persist incoming messages and unread increments exactly once.
- Per-user ordering must hold across processes; in-memory locks are not enough.
- Reply tokens are single-use and expire: never retry a used one. REPLY→PUSH
  fallback follows delivery policy and quota.
- Preserve `LineDelivery` claim/accepted/retry/finalized/lease-expiry transitions.
  Provider acceptance ≠ local finalization; recovery must not double-send.
