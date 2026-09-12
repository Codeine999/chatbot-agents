Project overview

Backend for an AI-assisted customer-support LINE OA (it is not a full saas just for the future).
It handles webhook ingestion, queued message processing, intent routing,
registration, RAG/pgvector retrieval, multi-provider AI, admin handoff, outbound
delivery, usage metering, credit accounting, budgets, and top-ups.

Stack: NestJS 11, Fastify, TypeScript, Prisma 7, PostgreSQL/pgvector, Redis,
BullMQ, Socket.IO, LINE Messaging API, OpenAI, Gemini, and Anthropic.

The current deployment serves one Company/LINE OA, while parts of the schema
prepare for multi-tenancy. Never weaken existing company/tenant ownership.

Repository map

prisma/ — schema and migrations

docs/ — current flows, dependencies, ERD, and architecture notes

src/ai-provider/ — provider adapters and model settings

src/generated/ — generated code; never edit manually

src/infra/ — infrastructure

src/modules/chatbot/ — orchestration, routing, sessions, context, knowledge

src/modules/line/ — webhook, queue worker, conversation, delivery

src/modules/usage/ — usage, pricing, wallet, budget, reservation, ledger

src/modules/admin/, payments/, registration/, users/, abuse/

test/ — automated tests

Inspect the current tree before relying on this map. Use the package manager and
commands declared by the lockfile and package.json.

Sources of truth

Use this order when information conflicts:

Current source code and migrations

Current tests and E2E fixtures

docs/mvp-line-rag-billing-flow.md

docs/line-message-e2e-current.md

docs/service-flow.md

docs/erd-database.md

Historical architecture reviews and roadmaps

Roadmap documents describe targets, not necessarily implemented behavior.
Report documentation drift when found.

Working rules

Read relevant code, tests, schema, migrations, and docs before editing.

Trace callers before changing shared types or public contracts.

Make the smallest complete change; do not rewrite unrelated code.

Preserve existing user changes in the working tree.

Follow current naming, dependency injection, validation, and error patterns.

Prefer existing modules/providers over parallel implementations.

Do not add production dependencies unless necessary.

Never edit generated code or build output manually.

Never expose secrets, provider costs, plaintext passwords, or customer PII.

Do not change business behavior merely to make tests pass.

Do not claim a check passed unless it was executed.

Architecture boundaries

Controllers authenticate, validate, call services, and return responses.

LINE ingress verifies the raw-body signature, enqueues events, and returns fast.

Queue workers own claim, retry, recovery, and message ordering.

ChatbotService orchestrates; IntentRouterService only decides.

RuleIntentService stays deterministic and performs no I/O.

KnowledgeRetrievalService is the single retrieval entry point.

AiChatService performs grounded generation, not retrieval scoring.

Provider adapters own provider calls, timeouts, usage normalization, and errors.

Delivery owns REPLY/PUSH selection, retries, and outbound idempotency.

Usage/credit services exclusively mutate wallet, budget, reservation, and ledger.

Never call an external provider inside a database transaction.

Security and multi-tenancy

Verify LINE signatures against the exact raw request body.

Guard admin/mutation routes with correct JWT and role checks.

Validate external payloads; do not use unvalidated request-body any.

Restrict Socket.IO to authenticated admins and approved origins.

Do not return raw internal errors to users.

Never send registration PII to an AI provider.

Redact PII before storing context or logs.

Every tenant/company-owned query must enforce its ownership scope.

Preserve rate limits, bans, spam detection, and AI budget gates.

LINE, queue, and delivery invariants

Webhook handling must survive duplicates, retries, crashes, and concurrency.

Preserve idempotency across webhook event, LINE message, AI operation, usage,
reservation, ledger, and delivery.

ProcessedLineWebhookEvent.webhookEventId is a durable deduplication key.

LineChatHistory.lineMessageId is unique when LINE supplies it.

Persist incoming messages and unread increments only once.

Preserve per-user/conversation ordering across processes; memory-only locking is
insufficient for horizontal scaling.

Reply tokens are single-use and expire. Never retry an already-used token.

Switching REPLY to PUSH must follow delivery policy and quota rules.

LineDelivery.key is the outbound idempotency key. Preserve legal claim,
accepted, retry, finalized, and lease-expiry transitions.

Provider acceptance and local finalization are different states; recovery must
avoid duplicate delivery.

Never send live LINE messages in automated tests.

Conversation and admin handoff

Redis sessions are temporary workflow state, not completed business records.

Keep sessions bounded with TTL and clear them after completion/cancellation.

Context must be bounded and PII-redacted.

Preserve registration state across allowed informational digressions.

Admin handoff is durable conversation state. While active, automatic AI replies
must remain muted until explicitly released.

Do not overwrite registration data merely to represent handoff.

Respect AdminMember.aiEnabled.

AdminChatRequest.clientRequestId makes an admin AI turn idempotent; retries
must not append duplicate messages.

RAG and AI rules

Deterministic cancel, menu, and active-flow rules follow current router policy.

Every displayed menu option must have deterministic handling.

Classifier/provider failure must fail safely, never invent a business answer.

AnswerPattern is source content; AnswerPatternVector is derived index data.

Embeddable content changes must update/invalidate the vector.

Record the embedding model; dimension/model changes require migration/reindex.

No adequate evidence means no generated knowledge/business answer.

RAG answers must use retrieved context and the configured safe fallback.

Mutable facts such as price, stock, balance, and account status come from the
authoritative database/API, never vector text.

Enforce active, language, and tenant filters where applicable.

Scoring, prompt, embedding, threshold, or rewrite changes require retrieval
tests using realistic Thai queries.

Route all model calls through the shared provider abstraction.

Persist provider request IDs when available.

Do not double-count input, cached-input, cache-write, output, or reasoning tokens.

Pricing and credit invariants

Use Prisma/database Decimal for money and credits; never authoritative JS
floating-point arithmetic.

AiModelPricing is effective-dated. Select one row where
effectiveFrom <= requestTime < effectiveTo, treating null effectiveTo as
open-ended, and store its pricingId on usage.

Calculate costThb from cost rates and chargedCredit from credit rates.

Apply regular input, cached input, cache write, output, and long-context rules
without double counting.

Never hard-code provider prices, credits-per-THB, or exchange rates in services.

Do not expose costThb to customers.

scopeKey must distinguish embedding document/indexing from query usage.

The ledger is the immutable accounting trail:

CreditReservation.operationKey makes reservation/replay idempotent.

Reserve wallet and matching budget credit atomically.

Settlement atomically releases holds, stores replayable provider result,
persists usage, creates at most one DEBIT, and updates wallet/budget totals.

Failure before a billable result releases the hold exactly once without DEBIT.

Expired HELD reservations must be safely recoverable without double release.

usageEventId and ledger idempotencyKey prevent duplicate charges.

TOPUP/REFUND are positive and DEBIT is negative.

balanceAfterCredit matches committed wallet balance in the same transaction.

Reservations do not increase lifetimeSpentCredit.

Wallet/budget reserved totals reconcile to HELD reservations.

Budget used totals reconcile to settled usage by kind and scopeKey.

Never rewrite/delete ledger history; use a compensating REFUND/ADJUSTMENT.

Top-up approval must atomically move PENDING to APPROVED, record approver/time,
increase wallet and lifetime top-up totals, and create exactly one TOPUP ledger.
Repeated/concurrent approval must never credit twice. Rejection changes no wallet
or ledger total. Preserve historical package and exchange-rate references.

Prisma changes

For schema changes:

Inspect current schema and related migrations.

Find affected services, DTOs, fixtures, seeds, and tests.

Update the schema and create a reviewed migration.

Plan compatibility/backfill for existing data.

Verify FKs, delete behavior, uniqueness, indexes, enums, and precision.

Regenerate the client and test against a clean database.

Do not use prisma db push as a production-migration substitute. Do not rename or
delete production data, alter Decimal precision, or change vector dimensions
without an explicit migration and rollback/backfill plan.

Verification

Discover exact scripts from package.json. Run targeted tests first, followed by
available typecheck, lint, build, and relevant E2E checks based on risk.

E2E tests must mock LINE/AI boundaries and reject unexpected outbound calls.
Billing tests must assert database state, including wallet totals, reservations,
budgets, usage, ledger uniqueness/signs, and delivery outcome—not only HTTP output.

After billing changes, test reserve, settle, release, retry/replay, concurrency,
provider failure, insufficient wallet/budget, long-context pricing, and expiry.

Definition of done

Requested behavior works across all affected layers.

Authorization, ownership, validation, idempotency, concurrency, retry, and
failure paths are covered as relevant.

Tests are added/updated and relevant checks actually pass.

Database changes include a safe migration/data plan.

No unrelated edits, secrets, or live test side effects remain.

Current-flow documentation is updated when behavior changes.

Final report lists changes, checks run, unverified areas, and deploy risks.

Balanced totals alone do not prove correctness. Also verify the originating
business event, usage scope, delivery outcome, idempotency, and reservation state.