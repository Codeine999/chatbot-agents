# Core logic audit: chatbot / LINE / events / AI / usage / app-message / product / abuse

Date: 2026-11-03 · Branch `multi/app` (HEAD `509c0ed`) · Auditor: Claude Opus 5.5

Scope: every decision function on the path of a customer turn, read end to end:
`line/` (ingress, queue worker, channel adapter, delivery), `events/message`,
`chatbot/` (orchestrator, intent router, gates, classifier, retrieval, answer,
context, product RAG), `commerce/`, `products/search` (decision points only),
`ai/embeding`, `usage/` (AI budget, rate limit, credit reservation, billing),
`abuse/`, `app-message/`. Registration internals and admin modules were not audited.

Method: read the code, then ran an offline test suite (in this folder) that drives the
real services with only the boundaries faked (Prisma, Redis, embeddings, LLM provider,
product SQL, LINE API). **No paid AI and no LINE call is possible from these tests.**
One finding (C1) was also checked against the local dev Redis with a key-less `EVAL`.

---

## 1. Verdict

**Go-live readiness today: about 70%. After the four "fix before go-live" items below
(all small code or config changes): about 85–90%.**

This is a judgment, not a measurement. What the number rests on:

| Area | State |
|---|---|
| Grounding / anti-hallucination | **Strong.** Prices, stock, and option values are rendered from DB tokens, never from model prose. Invented evidence IDs, invented product IDs, malformed JSON, and "INSUFFICIENT_CONTEXT" all fail safe to the configured fallback. Conflicting presets go to a human. Verified by P01–P03, P09, R03, R06, L04. |
| Idempotency / billing | **Strong** (also load-tested in the 2026-11-01 UAT audit). Product turns replay stored plan/retrieval/response without a second LLM call (P10). |
| Routing correctness | **Good, with 1 confirmed gate bug** (R1) and over-eager handoff under load (R2/B1). |
| Customer-facing robustness | **Weak spots:** rate limits become admin handoffs, photo albums trigger bans, group chats leak 1:1 context. |
| Prior audit items | H2/M7 (budget → admin), M2 (postback dup), M3 (expired holds), H3 (in-memory per-user lock) from `docs/audit-uat-2026-11-01.th.md` are **still open** in this HEAD. |

### Fix before go-live

1. **R2 + B1:** AI rate limit makes the customer get the fallback *and* sets the room to `waiting_admin`; the per-user cap is ~20 turns/hour.
2. **B2:** A customer who sends more than 10 photos in 10 s is banned for 5 minutes. Photos 11+ are dropped before they are saved, so admins never see them.
3. **L2:** Group/room events are treated as 1:1 chats (privacy). Quick mitigation: disable "Allow bot to join group chats" in LINE OA Manager, then add a code guard.
4. **P2 (config):** Check that the production company has `productBusinessType = 'ECOMMERCE'`. Any other value (null, or a removed preset like FASHION) hides every variant field from search and the AI, and weakens the option-value guard.

Also required for any multi-instance deploy: the per-user ordering lock is in memory
(`line-events.processor.ts:56`). Run **one** app instance until it moves to Redis/DB.

---

## 2. End-to-end flow (as implemented)

```
LINE POST /api/line/webhooks
  LineSignatureGuard (HMAC raw body)
  LineWebhookAdapter.receive: zod parse (user|group|room sources!), global ingress 100/s (503)
  queue.add(jobId = webhookEventId)
BullMQ line-events (concurrency/limiter from env)
  LineEventsProcessor.processQueuedJob: in-memory tail per userId          <- H3 (single instance)
  passesAbuseChecks: ban -> burst 10/10s -> hourly 60/h -> spam           <- B2 (drops before persist)
  claimWebhookEvent (DB lease 120 s, max 5 attempts)
  MessageProcessorService.process
    findDelivery(key = webhookEventId) -> replay delivery, no AI
    saveIncomingEvent (tx: conversation upsert, unread+1, USER history)   <- L1 (postback dup)
    LoadContextService.load (Redis, 3 turns)                              <- C1
    toChatTurn -> ChatbotService
      muted? -> ''            too long? -> template
      REGISTER switched off mid-flow -> close session
      IntentRouterService.resolve
        1 rich menu (postback key / intent / exact label)
        2 gates: greeting -> cancel -> registerSession -> trusted rule
        3 KnowledgeRetrievalService.retrieve
            ProductRetrievalService (planner, search, policy knowledge)   <- P1, P2, M6
            legacy: cache DIRECT -> DB DIRECT -> lexical+micro+vector RRF <- R1, R3
        4 decideFromRetrieval / low-confidence classifier                <- R2
      action -> AiChatService (DIRECT | grounded JSON | general | product)
      isFallback -> requestAdmin (waiting_admin)
    contextPolicy CLEAR -> clear context
    saveReply (tx: lease check + LineDelivery upsert)
    LineDeliveryService.deliver: REPLY until ts+50 s, else PUSH (retry key) -> finalize -> append context
```

### Routing decision table (verified by `intent-decision.spec.ts` and `product-flow.spec.ts`)

| Input | Decision (action / source) | Customer gets | waiting_admin |
|---|---|---|---|
| "สวัสดีครับ" | GENERAL_QUESTION / RULE, no search | general AI reply | no |
| "ยกเลิก" | CANCEL_SESSION | cancelled template | no |
| "สมัคร" (CAN_REGISTER off/on) | START_REGISTER | unavailable / registration start | no |
| "…ติดต่อแอดมิน…" | CONTACT_ADMIN / RULE, no AI | contact-admin template | **yes** |
| postback `menu=<key>` or exact label | RICH_MENU_REPLY / DATABASE | tenant reply text | no |
| inside REGISTER: free text | CONTINUE_REGISTER / SESSION | registration step | no |
| inside REGISTER: "ติดต่อแอดมิน" | CONTACT_ADMIN / SESSION | template | yes |
| exact approved question | ANSWER_KNOWLEDGE, route DIRECT, 0 AI calls | stored answer | no |
| two exact presets disagree | CONTACT_ADMIN (CONFLICTING_CANDIDATES) | fallback | yes |
| vector ≥ 0.75 | ANSWER_KNOWLEDGE, RAG, 1 AI call | grounded answer | no |
| lone number, no context | CLARIFY | "ช่วยอธิบายเพิ่มเติม…" | no |
| low confidence + GENERAL | GENERAL_QUESTION / AI | general reply | no |
| low confidence + BUSINESS, no evidence | CONTACT_ADMIN | fallback | yes |
| low confidence + BUSINESS + weak evidence | ANSWER_KNOWLEDGE / AI | grounded answer | no |
| classifier bad JSON / budget out | CONTACT_ADMIN | fallback | **yes** (R2) |
| named product + price | ANSWER_KNOWLEDGE / DATABASE ("product plan PRODUCT") | DB prices via tokens | no |
| "ส่งฟรีไหม" (whole message) | product skipped -> DIRECT preset | stored answer | no |
| small talk, no catalog signal | planner -> GENERAL (no classifier) | general reply, refs cleared | no |
| "สอบถามสินค้าหน่อยค่ะ" | MISSING_INPUT, 0 AI calls | "สนใจสินค้าประเภทไหน…" | no |
| exact SKU | planner skipped | grounded product answer | no |
| planner invents product id | product.failed | fallback | yes |
| catalog DB down | UNAVAILABLE | safe "ตรวจสอบไม่ได้" text | yes |

---

## 3. Findings

Severity: **H** = hurts customers/privacy at launch, **M** = wrong under specific
conditions, **L** = quality / maintainability. Evidence: **[test]** = reproduced by a test
in this folder, **[redis]** = checked on local Redis, **[code]** = from reading the code.

### H — fix before go-live

#### R2. AI rate limit is treated as "cannot answer" and hands the room to admins [test]
- Where: `ai-intent-classifier.service.ts:94`, `answer.service.ts:328,383`,
  `embedding.service.ts:82` (throws -> `RETRIEVAL_ERROR`), `commerce-turn.service.ts:251`.
- What happens: `AiBudgetService.tryConsume()` returning false produces the same result
  as a real BUSINESS miss: fallback text, then `requestAdmin` -> `waiting_admin` + admin
  notification. Under a traffic spike, every room becomes an admin request.
- Test: `defects.spec.ts › BUG-R2`.
- Fix: add a distinct result (for example `AiBusy`). Reply with a short "busy, please try again"
  text, or re-queue the event on the retry queue, and do **not** call `requestAdmin`.
- Status: same as H2/M7 in the 2026-11-01 audit. Still open.

#### B1. Per-user AI cap counts calls, not turns: about 20 turns per hour [test]
- Where: `ai-budget.service.ts:24` (`AI_USER_LIMIT_PER_HOUR` default 60).
- A low-confidence turn spends 3 budget units (embedding + classifier + answer). A product
  turn spends 2–3 (planner, answer, optional repair, optional embedding). An active shopper
  hits the cap after about 20 turns. Every later turn then triggers R2.
- Test: `BUG-B1` (exactly 20 turns).
- Fix: count per turn (one consume per `turnId`), or raise the cap to about 3× the intended turn budget.

#### B2. A photo album gets the customer banned, and the photos are lost [test]
- Where: `line-events.processor.ts:209-221`, `ban.service.ts:100-150`.
- Every event over the burst limit (10 per 10 s) adds a strike. Strike 3 means a 5-minute ban.
  LINE sends each photo as its own event, so 13 photos → strikes 1–3 → banned.
  Rejected events return before `claimWebhookEvent`/`saveIncomingEvent`, so they never
  appear in the admin inbox. The same applies to the hourly limit (60), even while a
  human admin is chatting with the customer.
- Test: `BUG-B2` (10 claimed, user banned).
- Fix: at most one strike per window (strike when the window first overflows), exempt image
  and sticker bursts or count them separately, and **persist** rate-limited events
  (just skip the AI) so admins still see them.

#### L2. Group/room messages are treated as private 1:1 chats [test]
- Where: `line-webhook.adapter.ts:18-36` accepts `group`/`room` sources. The worker,
  `saveIncomingEvent` and `toChatTurn` never check `source.type`.
- A member's group message is stored in that member's **1:1** conversation. The bot replies
  **into the group** using the member's private 1:1 context, open handoff, and session.
  The PUSH fallback goes to the member's 1:1 chat instead.
- Test: `BUG-L2`.
- Fix: accept only `source.type === 'user'` in the worker (or model groups as their own
  conversation). In the meantime, disable group join in the OA settings.

#### H3 (prior, still open). Per-user ordering lock is in memory [code]
- `line-events.processor.ts:56`. Safe only with a single instance. This is a deploy
  constraint, not a code fix for go-live.

### M — fix soon after go-live

#### R1. Confidence gate looks at vector hits that were not selected [test]
- Where: `knowledge-retrieval.service.ts:242-248`. `topVector` is the maximum over **all**
  vector candidates. If an unrelated vector hit (0.90) is skipped by `selectContexts()`,
  it still marks a lexical-only answer as confident `RAG`, so the BUSINESS/GENERAL
  classifier is skipped. The grounded generator usually still declines, but the routing
  invariant ("a shared word is not enough") is broken.
- Test: `BUG-R1`. Fix: compute `topVector` over `selected` only.

#### P1. Weak policy text is appended word for word to product answers [test]
- Where: `product-retrieval.service.ts:425-444` keeps `knowledgeResult.selectedItems`
  even when the route is `LOW_CONFIDENCE`. `product-answer.policy.ts` `safeProductAnswer()`
  then appends `policies.map(e => e.answer)` without any model judgment.
- When the answer template fails validation twice (ANSWER + CRITICAL_REPAIR), the
  customer sees an unrelated FAQ (in the test, a washing tip) as the shipping policy.
- Test: `BUG-P1`. Fix: for BOTH mode, use only policies from a confident
  (`route !== 'LOW_CONFIDENCE'`) retrieval. Otherwise apply the `POLICY_UNVERIFIED_NOTE` path.

#### P2. Product grounding depends on the company's preset [test + code]
- Only the `ECOMMERCE` preset is registered (`products/attributes/presets/index.ts`). With
  any other `productBusinessType`, all variant fields are hidden from search and the AI, and
  `proseStatesOptionValue()` only knows the colour/size words found in the evidence.
  A model can then write "มีสีชมพูด้วยค่ะ" for a product with no pink variant.
- Test: `BUG-P2`. The repo's own spec `product-answer.policy.spec.ts › C02` fails for the same
  reason (it still uses the removed `FASHION` type).
- Fix: a go-live check (SQL: `select "productBusinessType" from company`), plus reject
  prose colour/size words using a built-in vocabulary that does not depend on the preset.

#### C1. Empty `catalogRefs` turns into `{}` in Redis, so stale product references come back [test + redis]
- Where: `load-context.service.ts:124-139`. The Lua script decodes and re-encodes every turn,
  and Redis `cjson` encodes an empty table as an object. Verified on local redis:7:
  `{"catalogRefs":[]}` → `{"catalogRefs":{}}`.
- `ProductAnswerService` stores `catalogRefs: []` to mean "this turn showed no product"
  (GENERAL chat, COUNT). It reads back as `undefined`, so a later "ตัวนี้ราคาเท่าไหร่" resolves
  to the product from two turns earlier.
- Test: `BUG-C1`. Fix: add `cjson.encode_empty_table_as_object(false)` in the script, or store
  the refs as a JSON string field that Lua never decodes.

#### L1 (prior M2, still open). A retried postback is saved twice [test]
- `line-channel.adapter.ts:251`: dedup uses `lineMessageId`, which postbacks don't have.
  Duplicate USER history and unread +2. Test: `BUG-L1`. Fix: dedup by `webhookEventId`.

#### R3. A transient embedding error goes straight to an admin, with no retry [test]
- `KnowledgeRetrievalService.read()` swallows the error → `RETRIEVAL_ERROR` → CONTACT_ADMIN.
  The retry queue for retryable AI errors (`line-events.processor.ts:106`) is never used
  for embeddings. Test: `BUG-R3`. Fix: rethrow `isRetryableAiProviderError` errors from
  `read()` for the semantic source.

#### M3 (prior, still open). Expired HELD credit reservations are never recovered automatically [code]
- `credit.service.ts:515-535`: `listUnresolvedReservations` and `releaseUnknownReservation`
  are only called from the admin controller. No scheduler exists, so `reservedCredit` stays
  inflated until someone releases it by hand. This conflicts with the rule
  "Expired HELD reservations recover…".

#### M6. Product signal regex fires on common words, adding a planner LLM call [code]
- `product-retrieval.service.ts:49-50`: `สี` matches `เสีย`/`เสียง` ("ของเสียหาย…"), and
  `ซื้อ`/`แนะนำ` match policy or payment questions. Each such message pays for a planner
  call and extra latency before it ends up as KNOWLEDGE. Verified with node.
  Fix: use word-boundary matching (Intl.Segmenter tokens) instead of substring regex.

#### M7. Retrieval scans up to 1,000 rows and runs BM25 in JS on every non-DIRECT turn [code]
- `answer-pattern.service.ts:55` and `micro-knowledge.service.ts:221` run `findMany take 500`
  each turn, even though the cache exists. CPU is the next bottleneck (2026-11-01 audit), and
  records past 500 are silently never matched lexically. Fix: reuse the cache snapshot for
  the DB lexical pass, or move BM25 to Postgres FTS.

### L — quality

| ID | Where | Issue |
|---|---|---|
| R4 [test] | `chatbot.service.ts:75` | Logs `user session [object Object]'` at WARN on every message. Delete it. |
| R5 [test] | `chatbot.service.ts:186-200` | `START_AI_CHAT` writes a GENERAL_QUESTION session that nothing reads (`CONTINUE_AI_CHAT` is never produced), and CANCEL doesn't clear it. |
| L3 [code] | `answer-pattern-cache.service.ts` | 4-minute per-instance cache. An admin edit refreshes only the local instance. |
| L4 [code] | `ai-intent-classifier.service.ts:125` | `.strict()` schema: one extra key from the model means fallback + handoff. Consider `.strip()`. |
| L5 [code] | `spam-detector.service.ts:92` | After the 5th repeat, every further repeat adds a strike, so the user is banned within seconds. |
| L6 [code] | `line-webhook.adapter.ts:42` | `mode: 'standby'` events are processed (relevant only with LINE Module / multiple channels). |
| L7 [code] | `line-channel.adapter.ts:163` | An image is downloaded even when the chat is admin-muted and will get no reply. |
| L8 [code] | `user-session.service.ts:36` | The AI resumes 10 minutes after the last admin message. Admin messages are not in the AI context, so the bot can contradict the admin. |
| L9 [code] | `commerce-scope.service.ts:385` | `company.findMany` runs on every product turn. Cache it. |

### Checked and not a bug
- `semantic-search.service.ts:164` sets `entityKey/topicKey = null` for AnswerPattern vector
  hits. This is correct: `AnswerPattern` has no such columns, and MicroKnowledge vectors do select them.

---

## 4. Best-practice comparison (external research)

| Practice | This codebase |
|---|---|
| Hybrid lexical + vector with RRF (k=60) | Done (`RRF_RANK_CONSTANT = 60`). |
| Don't threshold on RRF scores. Abstain needs a calibrated score, tuned on a set that includes unanswerable queries | Done correctly: the gate uses raw cosine, never RRF. **But** R1 applies it to unselected items. Recalibrate 0.75 on Thai queries with negatives whenever the embedding model changes. |
| Rerank before generation | Not present. The grounded JSON contract + `directlyAnswered` acts as an LLM judge. Acceptable at this KB size; add a reranker only if eval shows ranking errors. |
| Don't trust model self-confidence to trigger fallback; use external signals | Mostly done: evidence-ID check, DB tokens. The classifier's `confidence` is ignored (good). |
| Test fallback chains under rate limits, timeouts, malformed output | Malformed output and timeouts fail safe. **Rate limit is the weak path** (R2/B1). |
| Handoff keeps context; measure handoff rate separately from deflection | Handoff sets status only. Track `waiting_admin` caused by `businessFallback` vs. explicit requests, so R2-type storms are visible. |
| LINE: `userId` is optional in group events; key dedup on `webhookEventId`; redelivery is off by default and not guaranteed | Dedup on `webhookEventId`: done. Group handling: L2. Redelivery: must be enabled in the console (the 503 ingress path relies on it). |

Sources: [RRF k=60 critique](https://dev.to/ji_ai/reciprocal-rank-fusion-why-k60-buries-your-best-hit-525c),
[Retrieval fusion in production RAG (arXiv 2603.02153)](https://arxiv.org/pdf/2603.02153v1),
[Production RAG with pgvector + reranking](https://dev.to/martin_palopoli/how-i-built-a-production-rag-pipeline-with-fastapi-pgvector-and-cross-encoder-reranking-j2o),
[Hybrid retrieval guide](https://hashnode.com/posts/a-practitioners-guide-to-hybrid-retrieval/6a5731c6ae6b41a1442853c8),
[Fallback when no results](https://theneuralbase.com/conversational-ai/learn/intermediate/fallback-when-no-results/),
[AI-to-human handoff](https://murf.ai/blog/ai-to-human-handoff),
[LINE: receiving messages / redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/),
[LINE: group chats](https://developers.line.biz/en/docs/messaging-api/group-chats/).

---

## 5. Tests in this folder

```bash
bunx jest --config test/audit-core-logic-opus/jest.config.json
```

| File | Tests | What |
|---|---|---|
| `intent-decision.spec.ts` | 22 | Decision matrix: gates, menu, register session, DIRECT/RAG/CLARIFY/conflict, low-confidence classifier, fail-safe. |
| `product-flow.spec.ts` | 14 | Mock catalog (linen shirt with 2 variants, jeans). Planner → search → token rendering, invented price/ID, GENERAL override, policy FAQ bypass, small talk, broad opener, exact SKU, DB outage, replay, register digression, stock + BUG-P1, BUG-P2. |
| `defects.spec.ts` | 10 | One reproduction per confirmed defect: R1–R5, B1, B2, L1, L2, C1. |
| `opus.harness.ts` | – | Full turn including `ProductRetrievalService`/`ProductAnswerService`, with in-memory CommerceTurn and catalog. |

Defect tests assert **today's wrong behavior** and name the desired one in a comment.
When a fix lands, the matching test fails: flip its expectation and keep it as a regression test.

Last run: **3 suites, 46 tests, all passing** (0.8 s). `eslint` on this folder: clean.
`tsc --noEmit`: no errors in this folder.

### Repo checks run during the audit (not caused by this folder)
- `bunx jest` (default `src` suite): **27 failed / 404 passed / 5 skipped.** I classified the
  failures I inspected as stale specs, not regressions: the `knowledge-retrieval.service.spec.ts`
  cases predate the 0.75 vector gate and identical-answer dedupe, the "observes …" snapshots in
  `chatbot/audit/*.audit.spec.ts` assert older behavior, and `product-answer.policy.spec.ts › C02`
  uses the removed FASHION preset (see P2). I did not inspect the gemini-embedding, pricing-DTO,
  or prompt-composer failures.
- `bunx tsc --noEmit`: 13 errors, all pre-existing (`test/audit/product-ecom.fixture.ts` missing
  `renderMode`, plus one each in `line-ingress.audit.spec.ts` and `ai-setting-prompt.composer.spec.ts`).
- Not run: `bun run build`, the live/paid suites (`test/live`, `test:product-audit`), and load tests.

No production code was changed.
