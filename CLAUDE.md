## Core map (chatbot-agents) — read before changing core

> Summarized from core-logic-erd / product-flow / ai-chatbot-architecture (snapshot 7–13 Nov 2026). Line numbers are omitted on purpose because they drift. If a path or function name doesn't match, grep the class name first, then trust the doc.
> All paths are under `src/modules/` unless stated otherwise.

### 1. Overview

- Stack: NestJS + Fastify, Prisma + Postgres (pgvector), Redis, BullMQ, Zod
- Two channels share one core: **LINE** (webhook → BullMQ) and **App** (REST, reply returned in a single HTTP response). Both enter `MessageProcessorService` through a `ChannelAdapter` (`LineChannelAdapter` / `AppChannelAdapter`)
- LINE-only features: member registration, Product RAG (requires `lineMemberId`; the App channel has none, so it always falls through to legacy RAG)
- Idempotency key used across the system: `turnId` = `webhookEventId` (LINE) or `app:<messageId>` (App)
- Single-company deployment: `CompanyService.getCompanyId()` / `CommerceScopeService.forLineDeployment` (multiple companies = fail closed, use legacy)

### 2. LINE message pipeline (actual order)

| # | Class (path) | What it does |
|---|---|---|
| 1 | `LineWebhookController` `POST /api/line/webhooks[/:channelKey]` (`line/`) | Receives events[], does no AI |
| 2 | `LineCredentialService` (`line/channel/`) | Resolves secret/accessToken: `forChannelKey()` or `forDeployment()` (`lineChannels` row in DB → env fallback). Cached 60s |
| 3 | `LineSignatureGuard` | HMAC-SHA256(rawBody) + `destination == botUserId`. Any failure = identical 401 |
| 4 | `LineWebhookAdapter.receive` | zod parse, ingress limit `rl:line:global:ingress`, `queue 'chat-events'.add('process-line-event', jobId=webhookEventId)` (one queue shared with every connector; `ChatEventsProcessor` is the only worker and routes by job name), returns 200 immediately |
| 5 | `ChatEventsProcessor` → `LineEventsProcessor` (handler) | ban / burst 10 per 10s / hourly 60 / spam → `claimWebhookEvent` (lease 120s, heartbeat 30s, attempts<5). Orders events per user with an **in-memory Map (not cross-process)** |
| 6 | `MessageProcessorService.process` (`events/message/`) | Shared hub for all channels (see below) |
| 7 | `ChatbotService.handleTextMessage/Image/Sticker` (`chatbot/`) | gates → router → action → ChatResponse |
| 8 | `LineChannelAdapter.saveReply` → `LineDeliveryService.deliver` | outbox + actual send (section 7) |

`MessageProcessorService.process` in order: `findDelivery(eventId)` (exists = replay, only forward it, no AI call) → `saveIncomingEvent` → typing indicator → `LoadContextService.load` → `toChatTurn` → `DecisionTraceService.run(...)` { `ChatbotService` → if `contextPolicy=CLEAR` clear Redis context → `saveReply` → `deliver` } → `finally` `DecisionLogService.save`

`ChatTurn.kind`: `text | image | sticker | response` (`response` = canned reply from the adapter, e.g. image from an external provider; skips ChatbotService, no decision log)

### 3. ChatbotService → IntentRouterService

**Pre-gates (ChatbotService)**: Redis `chat:control:{userId}` = ADMIN/PAUSE → returns `text:''` (muted: no reply, but the message is still stored) → load session `chat:session:{userId}` → empty message = default menu → longer than `AI_MAX_MESSAGE_LENGTH` (1000) = template → session REGISTER while REGISTRATION is disabled = clear + notify

**Router (`chatbot/intent/intent-router.service.ts`, `utils/route-stages.ts`)** only decides, never answers:
1. Rich menu (postback `menu=<key>` or typed label exactly) → `RICH_MENU_REPLY` (CLEAR)
2. `RuleIntentService.detect` (deterministic, no I/O) + `gateBeforeSearch` in order: greeting/opener (`DETECT_GREET`) → cancel → REGISTER session (only a rule ≥ 0.9 can interrupt) → trusted rule ≥ 0.9 (knowledge-style questions such as "how do I register" go to retrieval first)
3. No gate decided → `KnowledgeRetrievalService.retrieve` → `decideFromRetrieval`:
   `retrieval.product` → ANSWER_KNOWLEDGE · `MISSING_USER_INFORMATION` → CLARIFY · `CONFLICTING_CANDIDATES|RETRIEVAL_ERROR` → CONTACT_ADMIN · route ≠ LOW_CONFIDENCE → ANSWER_KNOWLEDGE · `plannerIntent=KNOWLEDGE` → (has evidence ? answer : handoff) · otherwise → `AiIntentClassifierService` (BUSINESS/GENERAL)
4. Classifier: JSON `{classification, confidence, reason, standaloneQuery, questions}`. BUSINESS + `standaloneQuery` differs from the original text → re-retrieve once (`disableProduct`, `forceGrounded`, no history) and keep the result with higher `evidenceStrength`. BUSINESS without evidence / classifier failure → CONTACT_ADMIN. GENERAL → `answerGeneral` (**ignores confidence**, see F5)

**Actions**: `RICH_MENU_REPLY`, `CANCEL_SESSION`, `START_REGISTER/CONTINUE_REGISTER` (RegistrationFlowService, Redis session), `CONTACT_ADMIN`, `START_AI_CHAT`, `GENERAL_QUESTION`, `CLARIFY`, `ANSWER_KNOWLEDGE`

**`ChatbotService.aiResponse` (contextPolicy rules that must not break)**:
- `isFallback` → `requestAdmin` + `SYSTEM/EXCLUDE` (this turn is not stored, but earlier context is not cleared)
- Partial answer (`result.handoff`) → reply + `requestAdmin`, `INCLUDE`
- Normal answer → `INCLUDE` (`KNOWLEDGE`/`AI` source)
- CLEAR is used for menu / cancel / register / customer-initiated "contact admin"
- `InsufficientCreditException` → `withoutCredit` returns `text:''` (no reply, no handoff)

**LLM calls per turn (for cost estimates)**: DIRECT/menu/cancel/clarify/sticker template = 0 · greeting/opener = 1 · normal RAG = 1 · LOW→classifier→(grounded|general) = 2 · classifier requests re-search = 2 + 1 extra embedding · grounded answers `NOT_BUSINESS` → general = 2 · Product = 2–3 (PLAN, ANSWER, CRITICAL_REPAIR) · image = 1

### 4. Retrieval (legacy RAG)

`KnowledgeRetrievalService.retrieve` is the single entry point (classifier re-search also goes through it). Order: product gate first (section 6) → legacy (memoized per turn to avoid duplicate embedding/billing)

Legacy `runRetrieval`:
1. `resolveRetrievalQuery` — **deterministic, not an LLM**. Fills in "model X" from the last 6 history messages; unclear reference = `missingReference` → CLARIFY
2. `AnswerPatternCacheService.snapshot()` — one in-memory set of AnswerPattern + MicroKnowledge (≤500 rows/table, TTL 240s, reloaded via Redis pub/sub `knowledge:changed`). Stale = read DB
3. Exact FAQ (`questionExamples` match, `safeDirect`, `renderMode≠REWRITE`) → route `DIRECT` (0 LLM, 0 embedding)
4. Pattern/micro BM25 (Thai segmentation via `Intl.Segmenter`, `thai-bm25.ts` has `FUNCTION_WORDS`) + **one** `embedQuery` → vector search on 2 tables (`answerPatternVector`, `microKnowledgeVector`; **always reads live DB**)
5. RRF k=60 (3 lists) → `selectContexts` (≤3 items, ≤12,000 chars, related via `entityKey/topicKey`) → `conflicts()` (contradicting numbers/polarity = `CONFLICTING_CANDIDATES`)
6. Confident (`RAG`) when exact, or cosine of selectedItems ≥ **0.75** (`KNOWLEDGE_RAG_MIN_VECTOR_SIMILARITY`), otherwise `LOW_CONFIDENCE`

| Value | Purpose |
|---|---|
| BM25 ≥ 0.1, cosine ≥ 0.6 | candidate noise floors (not confidence) |
| cosine ≥ 0.75 | gate that lets RAG skip the classifier (calibrated on gemini-embedding-2; re-measure when the model changes) |
| `KNOWLEDGE_LEXICAL_MIN_COVERAGE` 0.5 | keyword-only item #2+ must pass coverage |
| `fallbackReason` | `MISSING_USER_INFORMATION, CONFLICTING_CANDIDATES, RETRIEVAL_ERROR, NO_USABLE_EVIDENCE, BELOW_MIN_VECTOR_SIMILARITY, NO_SEARCH_RESULTS` |

Knowledge writes must go through the admin services and call `cache.changed()` (it awaits the refresh, then publishes). Writing to the DB directly without it leaves other instances stale for up to 240s.

### 5. Answer (`chatbot/answer/answer.service.ts` — `AiChatService`)

`answerKnowledge` uses the retrieval from the router (no second search): has product → `ProductAnswerService` · DIRECT safe → return `answer` verbatim (no persona/LLM) · usable `selectedItems` → `generateFromKnowledge` · none → `fallbackMessage`

`generateFromKnowledge` returns JSON `{askedAbout, directlyAnswered, decision: ANSWER|INSUFFICIENT_CONTEXT|NOT_BUSINESS, answer, evidenceIds[], unanswered[]}`
- Passes when `decision=ANSWER` + `directlyAnswered=true` + at least 1 evidenceId remains that is inside selectedItems (unknown IDs are dropped, the whole answer is not rejected)
- **Numbers/facts inside `answer` are not verified** (see F4)
- Non-empty `unanswered` → append `PARTIAL_ANSWER_NOTE` + handoff
- `NOT_BUSINESS` is allowed only when `allowGeneralExit` (route `RAG` and source ∈ CACHE/DATABASE/EMBEDDING) → `answerGeneral`
- Failure → fallback + handoff; reasons: `INSUFFICIENT_CONTEXT, NOT_DIRECTLY_ANSWERED, INVALID_EVIDENCE_REFERENCE, INVALID_GROUNDED_OUTPUT, TRUNCATED_OUTPUT (finishReason=length), NOT_BUSINESS_ON_BUSINESS_ROUTE`
- Prompt is built by `composeAiAnswerPrompt` (`chatbot/shared/prompt/ai-setting-prompt.composer.ts`): evidence/ragContext sits in the **systemInstruction** (see F6), `& < >` escaped

`AiSetting` (`aiSettings`): latest active row in scope `AI_SETTING_TENANT_ID`; only role `dev` may write `systemPrompt`

### 6. Product RAG (LINE only)

Path: `KnowledgeRetrievalService` → `chatbot/knowledge/product/product-retrieval.service.ts` (`retrieveProduct`)

1. **Gate**: `PRODUCT_ENABLED` + `PRODUCT_RAG_ENABLED`, has `userId/turnId/lineMemberId/conversationId`, not a pure policy-question regex (e.g. "free shipping?" should hit DIRECT), single-company scope. Any failure = `undefined` (use legacy)
2. `CommerceTurnService.find/open` (`commerce/`) — per-event snapshot in `commerceTurns`, unique `(companyId, connectionKey='standalone-line', externalEventId=webhookEventId)`; lease 180s; stages `plan → retrieval → response` are persisted and never redone (replay makes no LLM calls and no double billing); another worker holding the lease = 503 → webhook RETRY
3. `routeWithoutPlanner`: product signal / reference to earlier refs / probe finds name-alias-SKU / `mentionsCatalog` → PLAN; otherwise run legacy first: DIRECT/RAG/settled → use legacy; policy-like but unsure → `plannerIntent=KNOWLEDGE` (0 LLM); everything else → PLAN (planner replaces the classifier)
4. **Plan**: broad inquiry / exact SKU at the start of the message / policy-only = rule-based (0 LLM), otherwise LLM slot `PLAN` (`productPlannerSchema`, temp 0.1). `validate`: productIds ⊆ probe/refs, option/filter keys ∈ the preset's `storeOptions/storeFields`, operator matches type, min ≤ max price. Failure = `plan.failed` → fallback (never guess). An EQ filter on an option key (color/size) is converted into an option. `inStockOnly` must come from the customer's words (`groundStockFilter`)
5. **Search** (`products/search/product-search.service.ts`) in a RepeatableRead tx, 15s: probe → lexical SQL + BM25 (+ vector fallback ≥ 0.65 if `PRODUCT_SEMANTIC_ENABLED`) → `matchesBusinessFields` (options + filters must all hold on the **same variant**) → `evidence()` (price/stock read live from DB) → status `FOUND | MISSING_INPUT | VARIANT_UNAVAILABLE | NO_MATCH | NO_RELIABLE_CANDIDATE | UNAVAILABLE`
6. **Answer** (`product-answer.service.ts`, `product-answer.policy.ts`, `product-answer.grounding.ts`): not FOUND → `safeProductAnswer` (0 LLM). FOUND → LLM slot `ANSWER` returns an `answerTemplate` with tokens like `{{e1.price}}` → `renderProductAnswer` substitutes values from the DB only. The renderer rejects prose that contains numbers / stock words / option values written by the model (`proseStatesOptionValue`), tokens outside the allowlist, or answers that don't cover the asks. Rejected + critical (BOTH / COMPARE / PRICE+STOCK) → slot `CRITICAL_REPAIR` once → rejected again = `safeProductAnswer`
7. Price/stock/status **must never come from LLM prose or vectors**; always via DB tokens

**Preset / meta**: `products/attributes/presets/*.preset.ts` + `prompts/*.prompt.ts` → registry `BUSINESS_PRESETS` (currently only `ECOMMERCE`) → `search/catalog-fields.ts` (`catalogFields` / `loadCatalogFields` = **the only gateway**, never read presets directly). Chosen by `company.productBusinessType` (not in registry = 0 fields → meta can't be written + planner fails; the preset must be applied). Real values live in `productVariants.meta` (jsonb); price = `price` column, stock = `inventoryBalances`, never in meta (keys containing price/cost/stock/qty/onhand/PII and reserved keys are rejected by `isSafeAttributeKey`). Adding a business type = preset file + prompt file + one registry line

**Admin catalog writes**: `AdminProductController` → `ProductService` → `ProductCommandService.execute` (single tx, idempotent via `requestId` + fingerprint, advisory lock, lock order: shared preset lock → `lockProduct` FOR UPDATE, optimistic version) → write + `enqueueProductIndex` (outbox `productIndexJobs`) in the same tx. `ProductIndexService` ticks every 5s: claim lease → embed **outside the tx** → re-check document hash before upserting `productVectors` (mismatch = SUPERSEDED). Stock adjustment = command `ADJUST_STOCK` (`InventoryService`, `onHand ≥ reserved`, append-only movements); there is no reservation flow or out-of-stock alert yet

### 7. Delivery / outbox (`line/line-delivery.service.ts`)

- `saveReply`: tx verifies `processedLineWebhookEvent.leaseOwner` is still ours (otherwise throws `Webhook lease lost`) → empty text = no delivery row → upsert `lineDelivery` with key = `webhookEventId` (admin: `admin:{adminId}:{conversationId}:{clientRequestId}`)
- `deliver`: claim `PENDING→SENDING` (lease 120s) → mute check (auto reply during admin mute = `FAILED`) → **REPLY** if token exists and `now < timestamp+50s` → only a clearly invalid token switches to **PUSH** (`retryKey` fixed, ≤8 attempts, backoff 2s·2ⁿ⁻¹ ≤60s, firstPushAt ≥ 23h → UNKNOWN)
- Statuses: `PENDING | SENDING | ACCEPTED | FAILED | UNKNOWN`. Any other REPLY error / worker dying mid-REPLY = `UNKNOWN`, never guess-resend (no alert yet, F9)
- `accept` → `finalize`: upsert `lineChatHistory` by `deliveryId`, conversation preview, Redis `appendTurn` (`chat:context:{conversationId}`, 3 turns, TTL 30m, `INCLUDE` only)
- Recovery: deliveries every 5s (≤20 rows); webhook events every 15s (`RETRY/PROCESSING` with expired lease, attempts<5, 5 = `FAILED`); an error inside an event → `finishWebhookEvent` sets `RETRY` + lease +10s

### 8. Billing (every LLM/embedding call)

Must go through `UsersAiProviderService.generate` / `EmbeddingService` (→ `usage/billing/ai-billing.service.ts` `runBilled`). Never call a provider adapter directly.

`AiBudgetService.tryConsume` (Redis: global 30/s, per user 60/h, **counted per call, not per message**) → idempotencyKey (`usage:{turnId}:{sha256(request)}`, product `usage:product:{turn}:{slot}`, embed `usage:embed:…`) → replay if SETTLED → `AiPricingService.createQuote` (`aiModelPricing` must have a row for that provider/model) → `CreditService.reserveAiCredit` (wallet + budget, ReadCommitted + row lock) → provider call **outside tx** (heartbeat 30s) → `recordAiUsage` (claim HELD→SETTLED + `aiUsageEvents` + DEBIT `creditLedger` + result for replay)

**Always rethrow, never swallow in try/catch**: `InsufficientCreditException` (→ `withoutCredit`) and `PendingAiUsageError` (→ worker RETRY). Other provider errors → fallback. Settle failure → reservation `UNKNOWN`

Kinds: `LINE_AI_REPLY` scope `'*'` (shared by LINE + App, budgets not split yet), `EMBEDDING` scope `query|document`. Money is `Decimal` only

### 9. Handoff / mute

- `UserSessionService.requestAdmin(userId)` (`users/session/`): `ChannelHandoffRegistry` picks a handler by userId prefix (`app:` → `AppHandoffHandler` → `channelConversations`); none = LINE path: `lineConversation.status → waiting_admin`, `AdminNotification` only when the status actually changes. **Does not mute the bot**
- Admin sends a message (`LineWebhookService.sendAdminMessage`, `AppInboxService.sendAdminMessage`) → delivery PUSH + `sessions.mute` (`chat:control:{userId}`=ADMIN, TTL `AUTO_MUTE_WHEN_REPLY`) + `waiting_admin → open`
- `resume-bot`: DEL mute + status open + `LoadContextService.clear`

### 10. Decision log (`decision-log/`)

- One row per turn in `decisionLogs`, unique `(companyId, eventId)`. `DecisionTraceService` keeps state in AsyncLocalStorage; other services inject it as **`@Optional`** and call `note/route/retrieval/answer/llmCall/handoff` (outside a turn = no-op, **no I/O inside trace**)
- Written in the `finally` of `trace.run` (`COMPLETED`, or `ERROR` + errorCode if the turn throws). A write failure is warned and swallowed. `ERROR` never overwrites `COMPLETED`
- Adding a new answer branch → must call `decisionTrace.answer({ mode, fallbackReason? })`, otherwise it logs as `TEMPLATE`; a fallback with no reason = `UNREPORTED`. Registration turns store no inputText/responseText. `costThb` is not stored
- No row for `ChatTurn.kind='response'` or turns without a `turnId`
- Read via `GET /api/admin/decision-logs[/summary|/:id]` (roles dev/owner); purged every 6h per `DECISION_LOG_RETENTION_DAYS` (90)

### 11. How the App channel differs from LINE (`app-message/`)

`AppClientGuard` (flag `APP_MESSAGE_ENABLED`, Origin, IP ban) → `AppSessionGuard` (Bearer `ags_…` → sha256 → `appGuestSessions`) → `AppMessageService.send`: sanitize ≤2000 + `AppAbuseService` (any hit = **429 + Retry-After**, never silently dropped) → `ensureConversation` → dedupe on `(conversationId, clientMessageId)` (different text = 409) → **DB room lock** `channelConversations.activeTurnId` 120s (collision = 409 BUSY) → store inbound + unread+1 → `MessageProcessorService` (claim = messageId) → release lock → return `{message, replies[], meta}`
- userId in core = `app:<contactId>`, `turnId = app:<messageId>`, tables `channel*` (parallel to `line*`), no registration, no Product RAG, no BullMQ, no outbox/delivery (`deliver` only appends context)
- Admin request → `AppHandoffHandler`; a failed turn = 503 and the inbound message stays `PROCESSING`; resending the same id is safe (billing replay)

### 12. Redis keys / key tables

Redis: `chat:session:{userId}` (TTL 30m sliding) · `chat:control:{userId}` (mute) · `chat:context:{conversationId}` (3 turns) · `rl:line:*` / `rl:ai:*` / `rl:app:*` · `strikes:*`/ban · `bull:chat-events` · `knowledge:changed` (pub/sub)

| Table | Unique keys / caveats |
|---|---|
| `processedLineWebhookEvent` | `webhookEventId`; lease owner/until; status `RETRY/PROCESSING/COMPLETED/FAILED` |
| `lineDelivery` | `key` (send idempotency); `context` json used for append after ACCEPTED |
| `lineChatHistory` | `lineMessageId`, `deliveryId` unique; `rawEvent` holds raw PII |
| `commerceTurns` / `commerceLlmCalls` | plan/retrieval/response snapshot; slots `PLAN/ANSWER/CRITICAL_REPAIR` |
| `productVariants` | `(companyId, sku)`; `meta` jsonb |
| `productCatalogCommands` | `(companyId, requestId)` idempotency for every catalog write |
| `creditReservation` | `operationKey` unique, status `HELD/SETTLED/RELEASED/UNKNOWN`, `result` json for replay |
| `decisionLogs` | `(companyId, eventId)` |

### 13. Rules when editing code (invariants)

1. Every LLM/embedding call goes through the billing wrapper; rethrow `InsufficientCreditException` / `PendingAiUsageError`
2. Never make network/LLM calls inside a DB transaction (billing, indexing, delivery all run outside tx)
3. Reuse `turnId` as the idempotency key. Don't invent non-deterministic keys or retries will double-bill
4. Price/stock/status come from the DB via renderer tokens, never from LLM prose or vectors
5. Changing thresholds / prompts / embedding model / RRF → needs Thai retrieval tests (AGENTS.md rule) and re-measured cosine values
6. Adding a new action → update router + `ChatbotService` switch + report the answer mode to decision trace + decide the `contextPolicy`
7. Writing knowledge/AnswerPattern → call `cache.changed()`; writing catalog → only through `ProductCommandService.execute`
8. Never persist secrets (passwords) into `lineDelivery.text` / history / preview (see F1)
9. Per-user state that must work across instances must not use an in-memory Map (see F2)
10. Delivery status (`lineDelivery`), billing, and webhook claim are separate states; never infer one from another

### 14. Where to look for what

| Task | Start here |
|---|---|
| Wrong route / wrong action | `chatbot/intent/intent-router.service.ts`, `utils/route-stages.ts`, `rule-intent.service.ts` |
| Search misses / wrong hits / thresholds | `chatbot/knowledge/knowledge-retrieval.service.ts`, `answer-pattern.service.ts`, `thai-bm25.ts`, `semantic-search.service.ts` |
| Stale KB / cache | `answer-pattern-cache.service.ts` + admin knowledge services (`cache.changed()`) |
| FAQ answer invented / frequent fallback | `chatbot/answer/answer.service.ts` (`generateFromKnowledge`), `shared/prompt/ai-setting-prompt.composer.ts` |
| Classifier / GENERAL | `chatbot/intent/ai-intent-classifier.service.ts`, `answerGeneral` |
| Wrong product answer / planner | `product/product-retrieval.service.ts`, `products/search/product-search.service.ts`, `product-plan-policy.ts` |
| Price/stock in prose | `product/product-answer.policy.ts`, `product-answer.grounding.ts` |
| Business fields / meta | `products/attributes/presets/*`, `search/catalog-fields.ts`, `attributes/utils/attribute-value.util.ts` |
| Product index / embedding | `products/search/product-index.service.ts`, `product-index-outbox.ts`, `product-vector.repository.ts` |
| Not delivered / duplicated / reply token | `line/line-delivery.service.ts`, `line/line-reply.service.ts`, `line/admin/line-admin.service.ts` |
| Stuck / duplicate / retried events | `events/queue/chat-events.processor.ts` (worker), `line/line-events.processor.ts`, `line/line-webhook.service.ts` |
| Credit / model pricing / replay | `usage/billing/ai-billing.service.ts`, `usage/credit-point/credit.service.ts`, `usage/billing/ai-pricing.service.ts` |
| Rate limit / ban / spam | `usage/rate-limit/*`, `line-events.processor.ts` (LINE), `app-message/app-abuse.service.ts` (App) |
| Handoff / mute | `users/session/user-session.service.ts`, `app-message/app-handoff.handler.ts` |
| What did this turn decide | `decisionLogs` (`trace`, `answerMode`, `fallbackReason` columns) + `commerceTurns` for products |
| App channel | `app-message/app-message.service.ts`, `app-channel.adapter.ts`, `app-inbox.service.ts` |
| Registration | `registration/registration-flow.service.ts` |

### 15. Frequently used env vars

`KNOWLEDGE_RAG_MIN_VECTOR_SIMILARITY`(0.75) · `KNOWLEDGE_LEXICAL_MIN_COVERAGE`(0.5) · `KNOWLEDGE_TENANT_ID`/`KNOWLEDGE_LANGUAGE`(th) · `AI_SETTING_TENANT_ID` · `AI_MAX_MESSAGE_LENGTH`(1000) · `AI_USER_LIMIT_PER_HOUR`(60) · `LINE_USER_HOURLY_LIMIT`(60) · `LINE_EVENTS_CONCURRENCY`(10) · `LINE_EVENTS_RATE_LIMIT_MAX` · `LINE_GLOBAL_INGRESS_LIMIT_PER_SEC`(100) · `AUTO_MUTE_WHEN_REPLY` · `PRODUCT_ENABLED` / `PRODUCT_RAG_ENABLED` / `PRODUCT_SEMANTIC_ENABLED` · `PRODUCT_VECTOR_MIN_SIMILARITY`(0.65) · `REGISTRATION` flag · `APP_MESSAGE_ENABLED` / `APP_ALLOWED_ORIGINS` · `DECISION_LOG_ENABLED` / `DECISION_LOG_RETENTION_DAYS`(90) · `AI_USER_PROVIDER` / `AI_ADMIN_PROVIDER` / `AI_OPENROUTER_MODELS` · `CREDENTIAL_ENC_KEY_V<n>` · `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` (fallback when no `lineChannels` row exists)

### 16. Known issues (scan from 16 Oct; not all re-verified after 7 Nov — check the code before relying on them)

- **F1 high** Member password is stored as plaintext permanently in `lineDelivery.text`, `lineChatHistory.text`, `lineConversation.lastMessage` (registration flow)
- **F2 high** Per-user message ordering is guaranteed only within one process (Map in `LineEventsProcessor`); multiple instances can reply out of order
- **F3 medium** Transient AI error → retry job (`retry-line-event`, same queue) has no delay but the lease still has 10s left → claim fails, the real work waits for the 15s recovery sweep (the older doc claims backoff works, which is wrong)
- **F4 medium** Grounded answers don't verify numbers in the answer against the evidence (product side has the token renderer, FAQ side doesn't)
- **F5 medium** Classifier GENERAL ignores confidence · **F6 medium** Evidence sits in the system instruction (prompt injection) · **F7** Slip images are sent to the provider before knowing they're transactions · **F8** `redactPii` doesn't cover names/addresses, and snapshots (`commerceTurns.input`, `processedLineWebhookEvent.event`, `lineChatHistory.rawEvent`) have no retention
- **F9** Other REPLY errors → `UNKNOWN`, no retry, nobody notified · **F10** AI budget counts per call (hits the cap at ~15–20 messages/hour when Product is on) · **F14** `isUsableKnowledge` is commented out of `eligible()`
- Partially fixed: F11 (KB side uses the snapshot now, product side still scans whole tables), F13 (pub/sub notifies other instances, best effort)